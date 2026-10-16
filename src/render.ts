import {
  systemClock,
  type Clock,
  type SemanticEvent,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import type { ThreadKey } from "./domain.js";
import { escapeSlack, TurnPresentation } from "./presentation.js";
import type { SlackRateLimiter } from "./rate-limit.js";
import type { SlackPort } from "./slack-port.js";

/** How often a running answer is published, at most: never once per token. */
export const PUBLISH_CADENCE_MS = 1_500;

/**
 * A streamed answer's bounds (S-206): each `chat.appendStream` carries at
 * most `chunk` characters, and the whole stream at most `total`, within
 * Slack's 40,000 characters of a message's text. Past it, the stream says
 * once that the rest is in Datalayer and appends nothing more.
 */
export const STREAM_LIMITS = { chunk: 12_000, total: 38_000 } as const;
export const STREAM_REST = "\n\n… The rest of this answer is in Datalayer.";

/**
 * Where to cut escaped text at or before `at` without splitting an entity
 * (`&amp;`, `&lt;`, `&gt;`): a cut inside one moves to its `&`.
 */
export function entitySafeCut(text: string, at: number): number {
  if (at >= text.length) return text.length;
  const amp = text.lastIndexOf("&", at - 1);
  if (amp < 0) return at;
  const semi = text.indexOf(";", amp);
  return semi >= at && semi - amp <= 4 ? amp : at;
}

/** Slack refused the call itself (`ok: false`), as opposed to a network or rate failure. */
function slackRefusalOf(error: unknown): string | undefined {
  const value = error as
    | { code?: unknown; data?: { error?: unknown } }
    | undefined;
  return value?.code === "slack_webapi_platform_error" &&
    typeof value.data?.error === "string"
    ? value.data.error
    : undefined;
}

export type RenderOptions = Readonly<{
  /** Where the session is opened in Datalayer (a one-use handoff when available). */
  openUrl: string;
  /** The Slack user the answer streams to (Slack streaming needs a recipient in a channel). */
  recipientUserId: string;
  /** What a choice button carries to answer the question (the run asking). */
  askValue?: string;
  /** The message to keep updating: a recovered turn resumes its own. */
  messageTs?: string;
  /** quiet (one status line) or noisy (every tool listed): the installation's event policy (S-308). */
  events?: "quiet" | "noisy";
  cadenceMs?: number;
  clock?: Clock;
}>;

/**
 * One turn's answer in a Slack thread (S-206): streamed with
 * `chat.startStream`/`appendStream`/`stopStream` when the port offers it;
 * otherwise one placeholder updated at a bounded cadence, then a final
 * message. Every call passes the rate limiter.
 */
export class TurnRenderer {
  readonly presentation = new TurnPresentation();
  readonly #clock: Clock;
  readonly #cadence: number;
  #ts?: string;
  #streaming = false;
  #lastPublished = Number.NEGATIVE_INFINITY;
  #dirty = false;
  #pendingText = "";
  #streamed = 0;
  #streamCut = false;
  /** Why Slack refused to stream this answer, when it did: the placeholder was used instead. */
  streamRefused?: string;
  /** The run the stream named: what the Stop button says it stops. */
  runId?: string;
  /** What the Stop button carries: the session and the run it names. */
  stopValue?: string;
  /** The Slack member whose Stop ended the turn (S-205), named on the final status. */
  stoppedBy?: string;

  constructor(
    readonly slack: SlackPort,
    readonly limiter: SlackRateLimiter,
    readonly key: ThreadKey,
    readonly options: RenderOptions,
  ) {
    this.#clock = options.clock ?? systemClock;
    this.#cadence = options.cadenceMs ?? PUBLISH_CADENCE_MS;
    this.#ts = options.messageTs;
  }

  /** The message the answer is in, once begun. */
  get messageTs(): string | undefined {
    return this.#ts;
  }

  /** Post the placeholder, or start the stream; a resumed turn keeps its message. */
  async begin(): Promise<string> {
    if (this.#ts) return this.#ts;
    const streaming = this.slack.streaming;
    if (streaming) {
      try {
        this.#ts = await this.limiter.run(
          "chat.startStream",
          this.key.channelId,
          // No seed: what the stream starts with stays in the answer.
          () => streaming.start(this.key, this.options.recipientUserId),
        );
        this.#streaming = true;
      } catch (error) {
        // Streaming is not available here (the workspace's plan, the
        // conversation, the app's settings): the bounded placeholder answers.
        // Anything but Slack's own refusal still fails the turn.
        const refusal = slackRefusalOf(error);
        if (!refusal) throw error;
        this.streamRefused = refusal;
      }
    }
    if (!this.#ts)
      this.#ts = await this.limiter.run(
        "chat.postMessage",
        this.key.channelId,
        () => this.slack.postThread(this.key, this.#message()),
      );
    this.#lastPublished = this.#clock.now();
    return this.#ts;
  }

  async apply(event: SemanticEvent): Promise<void> {
    const before = this.presentation.answer.length;
    this.presentation.apply(event);
    // The stream carries every part of the answer the stop blocks leave out:
    // words, a table event's table, a completion's text standing in for
    // none (a replayed turn). Citations are the stop's Sources line.
    if (
      event.kind === "text" ||
      event.kind === "table" ||
      event.kind === "completion"
    )
      this.#pendingText += this.presentation.answer.slice(before);
    this.#dirty = true;
    if (this.presentation.ended) return;
    if (this.#clock.now() - this.#lastPublished >= this.#cadence)
      await this.#publish();
  }

  /** The final message: the whole answer, its tables and sources, no Stop. */
  async finish(): Promise<void> {
    const ts = await this.begin();
    if (this.#streaming && this.slack.streaming) {
      const streaming = this.slack.streaming;
      await this.#flushStream();
      // Slack appends these blocks under the streamed words: what the stream
      // did not carry (files, sources, the question, the status, the
      // actions), never the answer a second time.
      const final = this.presentation.message(this.options.openUrl, {
        askValue: this.options.askValue,
        direct: this.key.channelId.startsWith("D"),
        events: this.options.events,
        stoppedBy: this.stoppedBy,
        streamed: true,
        threadMenu: true,
      });
      await this.limiter.run("chat.stopStream", this.key.channelId, () =>
        streaming.stop(this.key, ts, final),
      );
    } else {
      await this.limiter.run("chat.update", this.key.channelId, () =>
        this.slack.updateMessage(this.key, ts, this.#message()),
      );
    }
    this.#dirty = false;
  }

  /** Publish what changed since the last publish, if anything did. */
  async flush(): Promise<void> {
    if (this.#dirty) await this.#publish();
  }

  async #publish(): Promise<void> {
    const ts = await this.begin();
    if (this.#streaming) await this.#flushStream();
    else
      await this.limiter.run("chat.update", this.key.channelId, () =>
        this.slack.updateMessage(this.key, ts, this.#message()),
      );
    this.#lastPublished = this.#clock.now();
    this.#dirty = false;
  }

  async #flushStream(): Promise<void> {
    const streaming = this.slack.streaming;
    const ts = this.#ts;
    if (!streaming || !ts || !this.#pendingText) return;
    let text = escapeSlack(this.#pendingText);
    this.#pendingText = "";
    if (this.#streamCut) return;
    const room = STREAM_LIMITS.total - this.#streamed;
    if (text.length > room) {
      text = `${text.slice(0, entitySafeCut(text, Math.max(0, room)))}${STREAM_REST}`;
      this.#streamCut = true;
    }
    for (let at = 0; at < text.length; ) {
      const end =
        at + STREAM_LIMITS.chunk >= text.length
          ? text.length
          : entitySafeCut(text, at + STREAM_LIMITS.chunk);
      const chunk = text.slice(at, end);
      await this.limiter.run("chat.appendStream", this.key.channelId, () =>
        streaming.append(this.key, ts, chunk),
      );
      this.#streamed += chunk.length;
      at = end;
    }
  }

  #message() {
    return this.presentation.message(this.options.openUrl, {
      threadMenu: true,
      direct: this.key.channelId.startsWith("D"),
      events: this.options.events,
      askValue: this.options.askValue,
      runId: this.runId,
      stopValue: this.stopValue,
      stoppedBy: this.stoppedBy,
    });
  }
}
