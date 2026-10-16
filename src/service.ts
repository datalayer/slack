import type { AgentClient } from "./agent-client.js";
import { HostRefusedError } from "./host-client.js";
import { StoreLinks, type AccountLinks } from "./host-installations.js";
import type {
  IncomingPrompt,
  SlackInstallationKey,
  ThreadKey,
  TurnRequest,
} from "./domain.js";
import { Logger } from "./observability.js";
import {
  DEFAULT_QUOTAS,
  quotaEntries,
  quotaWords,
  resetOf,
  windowOf,
  type QuotaLimits,
} from "./quotas.js";
import { stripAppMention } from "./presentation.js";
import {
  retryingSlackPort,
  SlackRateLimiter,
  systemClock,
  type Clock,
} from "./rate-limit.js";
import { TurnRenderer } from "./render.js";
import { TurnRouting, type Refusal } from "./routing.js";
import type { SlackMessage, SlackPort } from "./slack-port.js";
import { turnAliveAt, type SlackStore } from "./store.js";

/** A running turn that said nothing for this long may be taken over (a crashed worker). */
export const TURN_STALE_AFTER_MS = 15 * 60 * 1000;

/**
 * A running turn of the same event is resumed only once it is older than the
 * queue's lease (`postgres-queue.ts`, five minutes): before that, its worker
 * may still be alive, and the job is a duplicate in flight.
 */
export const RESUME_AFTER_MS = 5 * 60 * 1000;
/**
 * How often the worker answering a turn says it is alive (S-207): well
 * within `RESUME_AFTER_MS` and `TURN_STALE_AFTER_MS`, so a long turn is never
 * resumed by a redelivery nor taken over by a new prompt while it runs.
 */
export const TURN_HEARTBEAT_MS = 60 * 1000;

/** Slack's answer when the person is gone from the workspace: their link ends (S-103). */
export const GONE_USER_ERRORS = new Set([
  "user_not_found",
  "user_disabled",
  "account_inactive",
]);

/** What the Stop button carries: the session, the run it names and the event that began it. */
export type StopValue = Readonly<{ s: string; r?: string; e: string }>;

export type ServiceOptions = Readonly<{
  clock?: Clock;
  limiter?: SlackRateLimiter;
  logger?: Logger;
  cadenceMs?: number;
  staleAfterMs?: number;
  resumeAfterMs?: number;
  /** Questions an hour per person, workspace, organization and application (S-404). */
  quotas?: QuotaLimits;
  /** quiet (one status line) or noisy (every tool listed) answers (S-308). */
  events?: "quiet" | "noisy";
  /** How often a running turn's heartbeat is written (`TURN_HEARTBEAT_MS`). */
  heartbeatMs?: number;
  /** Where *Open in Datalayer* goes for a session: a one-use handoff when Datalayer answers one. */
  openUrlOf?: (sessionId: string, request: TurnRequest) => Promise<string>;
}>;

function slackErrorOf(error: unknown): string | undefined {
  const data = (error as { data?: { error?: unknown } } | undefined)?.data;
  return typeof data?.error === "string" ? data.error : undefined;
}

/**
 * The turn worker (plans/SLACK.md §7.2, S-202 to S-207): resolve who asks and
 * which application answers; one turn at a time per thread (a second prompt
 * is refused privately while one runs); the session created or resumed with
 * the speaker and Slack provenance, idempotent by the Slack event id; its
 * semantic events rendered at a bounded cadence; a redelivery after a crash
 * resumes the same message, and Datalayer replays rather than runs again.
 */
export class SlackAgentService {
  readonly routing: TurnRouting;
  readonly limiter: SlackRateLimiter;
  readonly logger: Logger;
  /** Slack, every call waiting out a 429 (S-206): what all but a turn's answer posts through. */
  readonly slack: SlackPort;
  /** Slack as given: a turn's renderer paces and retries its own calls on it. */
  readonly #paced: SlackPort;
  readonly #clock: Clock;

  constructor(
    readonly store: SlackStore,
    readonly agents: AgentClient,
    slack: SlackPort,
    readonly webUrl: string,
    /** Who is linked, and how one connects: Datalayer's record, through the host key. */
    readonly links: AccountLinks = new StoreLinks(store),
    readonly options: ServiceOptions = {},
  ) {
    this.#clock = options.clock ?? systemClock;
    this.limiter = options.limiter ?? new SlackRateLimiter(this.#clock);
    this.#paced = slack;
    this.slack = retryingSlackPort(slack, this.limiter);
    this.logger = options.logger ?? new Logger();
    this.routing = new TurnRouting(store, links, webUrl);
  }

  /** Say something to one person only; a person gone from Slack is unlinked (fail closed). */
  async privately(
    key: SlackInstallationKey | ThreadKey,
    userId: string,
    message: SlackMessage,
  ): Promise<void> {
    try {
      await this.slack.postPrivate(key, userId, message);
    } catch (error) {
      const code = slackErrorOf(error);
      if (!code || !GONE_USER_ERRORS.has(code)) throw error;
      await this.links.unlink?.(key, userId);
      this.logger.audit("identity.unlinked", {
        installation: `${key.appId}:${key.enterpriseId ?? "-"}:${key.teamId}`,
        reason: code,
        slackUser: userId,
      });
    }
  }

  #refused(
    prompt: IncomingPrompt,
    refusal: Refusal | "busy" | "empty" | "quota",
  ): void {
    this.logger.audit("identity.refused", {
      installation: `${prompt.appId}:${prompt.enterpriseId ?? "-"}:${prompt.teamId}`,
      reason: refusal,
      slackUser: prompt.userId,
    });
  }

  async handlePrompt(
    prompt: IncomingPrompt,
    botUserId?: string,
  ): Promise<void> {
    const resolution = await this.routing.resolve(prompt);
    if (!resolution.ok) {
      if (resolution.refusal === "not-installed") return; // late work is dropped
      if (resolution.refusal === "no-application" && resolution.message?.blocks)
        await this.store.holdPrompt(prompt);
      this.#refused(prompt, resolution.refusal);
      if (resolution.message)
        await this.privately(prompt, prompt.userId, resolution.message);
      return;
    }
    const { resolved } = resolution;

    const text = stripAppMention(prompt.text, botUserId);
    if (!text) {
      await this.privately(prompt, prompt.userId, {
        text: "Add a question after @Datalayer.",
      });
      return;
    }

    const now = new Date(this.#clock.now());
    const claim = await this.store.beginTurn(
      prompt,
      prompt.eventId,
      now,
      this.options.staleAfterMs ?? TURN_STALE_AFTER_MS,
    );
    if (claim.outcome === "done") return; // a duplicate of an answered event
    if (
      claim.outcome === "resumed" &&
      now.getTime() - turnAliveAt(claim.turn) <
        (this.options.resumeAfterMs ?? RESUME_AFTER_MS)
    )
      return; // the same event, its worker still answering (its heartbeat is recent)
    if (claim.outcome === "busy") {
      this.#refused(prompt, "busy");
      await this.privately(prompt, prompt.userId, {
        text: "@Datalayer is still answering in this thread. Wait for its answer, or press Stop on it, then ask again.",
      });
      return;
    }

    // Quotas before any costly work; a resumed turn was counted already.
    if (claim.outcome === "started") {
      const installation = await this.store.getInstallation(prompt);
      const limits = this.options.quotas ?? DEFAULT_QUOTAS;
      const taken = await this.store.takeQuota(
        quotaEntries(limits, {
          applicationId: resolved.applicationId,
          installation: `${prompt.appId}:${prompt.enterpriseId ?? "-"}:${prompt.teamId}`,
          organizationId: installation?.datalayerOrganizationId,
          slackUserId: prompt.userId,
        }),
        windowOf(now),
      );
      if (!taken.ok) {
        await this.store.endTurn(prompt, prompt.eventId);
        this.#refused(prompt, "quota");
        await this.privately(prompt, prompt.userId, {
          text: quotaWords({
            limit: taken.entry.limit,
            ok: false,
            resetsAt: resetOf(now),
            scope: taken.entry.scope,
          }),
        });
        return;
      }
    }

    const request: TurnRequest = {
      applicationId: resolved.applicationId,
      externalEventId: prompt.eventId,
      externalUserId: prompt.userId,
      principalId: resolved.principalId,
      prompt: text,
      provenance: {
        appId: prompt.appId,
        channelId: prompt.channelId,
        enterpriseId: prompt.enterpriseId,
        teamId: prompt.teamId,
        threadTs: prompt.threadTs,
      },
      sessionId: resolved.binding?.sessionId,
      sessionGeneration: resolved.binding
        ? undefined
        : (await this.store.getArchivedThreads(prompt)).length,
    };

    let turn;
    try {
      // The exchange is the authorization: the linked person may open this
      // application, now. A resumed turn sends the same event id: Datalayer
      // answers the original turn and runs nothing again.
      turn = await this.agents.startTurn(request);
    } catch (error) {
      await this.store.endTurn(prompt, prompt.eventId);
      if (error instanceof HostRefusedError && error.status < 500) {
        this.#refused(prompt, "no-access");
        await this.privately(prompt, prompt.userId, {
          text: `Datalayer did not let this turn start: ${error.detail} Read ${this.webUrl}/docs/slack#troubleshooting`,
        });
        return;
      }
      throw error;
    }

    // *Open in Datalayer* is a one-use handoff to this conversation (S-305),
    // or no button at all: never a guessed address.
    const openUrl = this.options.openUrlOf
      ? await this.options
          .openUrlOf(turn.sessionId, request)
          .catch((error: unknown) => {
            this.logger.warn("turn.handoff_failed", {
              error_name: error instanceof Error ? error.name : "unknown",
            });
            return "";
          })
      : "";
    const renderer = new TurnRenderer(this.#paced, this.limiter, prompt, {
      askValue: prompt.eventId,
      cadenceMs: this.options.cadenceMs,
      events: this.options.events,
      clock: this.#clock,
      messageTs: claim.turn.messageTs,
      openUrl,
      recipientUserId: prompt.userId,
    });
    const stopValue = (runId?: string): string =>
      JSON.stringify({
        e: prompt.eventId,
        r: runId,
        s: turn.sessionId,
      } satisfies StopValue);
    renderer.stopValue = stopValue();

    // While this worker answers, it says so every minute (S-207): on real
    // time, unref'd, and stopped with the turn.
    const heartbeat = setInterval(() => {
      void this.store
        .updateTurn(prompt, prompt.eventId, {
          heartbeatAt: new Date(this.#clock.now()).toISOString(),
        })
        .catch((error: unknown) =>
          this.logger.warn("turn.heartbeat_failed", {
            error_name: error instanceof Error ? error.name : "unknown",
          }),
        );
    }, this.options.heartbeatMs ?? TURN_HEARTBEAT_MS);
    heartbeat.unref();

    try {
      const messageTs = await renderer.begin();
      await this.store.updateTurn(prompt, prompt.eventId, {
        messageTs,
        sessionId: turn.sessionId,
      });
      const binding = {
        ...request.provenance,
        applicationId: resolved.applicationId,
        lastEventId: prompt.eventId,
        lastRunId: resolved.binding?.lastRunId,
        openedByPrincipalId:
          resolved.binding?.openedByPrincipalId ?? resolved.principalId,
        // Until the turn finishes, its status message waits for an answer: a
        // turn paused on an approval is finished by `turn.completed`.
        pendingMessageTs: messageTs,
        sessionId: turn.sessionId,
        updatedAt: now.toISOString(),
        visibility: resolved.visibility,
      };
      await this.store.putThread(binding);
      await this.store.clearNextApplication(prompt);

      for await (const event of turn.updates) {
        if (turn.run.id && renderer.runId !== turn.run.id) {
          renderer.runId = turn.run.id;
          renderer.stopValue = stopValue(turn.run.id);
          await this.store.updateTurn(prompt, prompt.eventId, {
            runId: turn.run.id,
          });
        }
        await renderer.apply(event);
      }
      await renderer.finish();
      await this.store.putThread({
        ...binding,
        lastRunId: turn.run.id ?? binding.lastRunId,
        pendingMessageTs: renderer.presentation.ended
          ? undefined
          : binding.pendingMessageTs,
        updatedAt: new Date(this.#clock.now()).toISOString(),
      });
    } catch (error) {
      this.logger.warn("turn.interrupted", {
        error_name: error instanceof Error ? error.name : "unknown",
      });
      await renderer.apply({
        kind: "error",
        message: "The connection to Datalayer was interrupted.",
      });
      await renderer.finish().catch(() => undefined);
    } finally {
      clearInterval(heartbeat);
      await this.store.endTurn(prompt, prompt.eventId);
    }
  }

  /**
   * Stop (S-207): only the run the button names, only while it runs, only
   * for a person linked in this workspace; Datalayer stops it as that person
   * (their own exchange), so a person who may not open the application
   * cannot stop it either.
   */
  async stop(
    thread: ThreadKey,
    value: StopValue,
    slackUserId: string,
  ): Promise<"stopped" | "not-running" | "not-linked"> {
    const turn = await this.store.getTurn(thread);
    if (
      !turn ||
      turn.state !== "running" ||
      turn.eventId !== value.e ||
      turn.sessionId !== value.s ||
      (value.r !== undefined && turn.runId !== value.r)
    )
      return "not-running";
    const link = await this.links.linkOf(thread, slackUserId);
    if (!link) return "not-linked";
    const binding = await this.store.getThread(thread);
    if (!binding) return "not-running";
    await this.agents.stopTurn(value.s, {
      applicationId: binding.applicationId,
      externalEventId: `stop:${value.e}`,
      externalUserId: slackUserId,
      principalId: link.principalId,
      prompt: "",
      provenance: thread,
      sessionId: value.s,
    });
    return "stopped";
  }
}

export function slackThreadKey(input: {
  appId: string;
  channel: string;
  enterpriseId?: string;
  teamId: string;
  threadTs?: string;
  ts: string;
}): ThreadKey {
  return {
    appId: input.appId,
    channelId: input.channel,
    enterpriseId: input.enterpriseId,
    teamId: input.teamId,
    threadTs: input.threadTs ?? input.ts,
  };
}
