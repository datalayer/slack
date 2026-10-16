import type { ThreadKey } from "./domain.js";
import { escapeSlack, TurnPresentation } from "./presentation.js";
import {
  systemClock,
  type Clock,
  type SlackRateLimiter,
} from "./rate-limit.js";
import type { SemanticEvent } from "./semantic.js";
import type { SlackPort } from "./slack-port.js";

/** How often a running answer is published, at most: never once per token. */
export const PUBLISH_CADENCE_MS = 1_500;

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
  /** The run the stream named: what the Stop button says it stops. */
  runId?: string;
  /** What the Stop button carries: the session and the run it names. */
  stopValue?: string;

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
      this.#streaming = true;
      this.#ts = await this.limiter.run(
        "chat.startStream",
        this.key.channelId,
        () =>
          streaming.start(this.key, this.options.recipientUserId, "_Working…_"),
      );
    } else {
      this.#ts = await this.limiter.run(
        "chat.postMessage",
        this.key.channelId,
        () => this.slack.postThread(this.key, this.#message()),
      );
    }
    this.#lastPublished = this.#clock.now();
    return this.#ts;
  }

  async apply(event: SemanticEvent): Promise<void> {
    this.presentation.apply(event);
    if (event.kind === "text") this.#pendingText += event.text;
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
      const final = this.presentation.message(this.options.openUrl, {
        askValue: this.options.askValue,
        direct: this.key.channelId.startsWith("D"),
        events: this.options.events,
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
    const chunk = escapeSlack(this.#pendingText);
    this.#pendingText = "";
    await this.limiter.run("chat.appendStream", this.key.channelId, () =>
      streaming.append(this.key, ts, chunk),
    );
  }

  #message() {
    return this.presentation.message(this.options.openUrl, {
      threadMenu: true,
      direct: this.key.channelId.startsWith("D"),
      events: this.options.events,
      askValue: this.options.askValue,
      runId: this.runId,
      stopValue: this.stopValue,
    });
  }
}
