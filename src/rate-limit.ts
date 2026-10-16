/**
 * Slack's rate limits, kept before a call rather than discovered after it
 * (S-206): calls of one method to one channel are
 * spaced, and a 429 waits as long as Slack's `Retry-After` says, then tries
 * again a bounded number of times. Never one call per model token.
 */

import {
  systemClock,
  type Clock,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import type { SlackInstallationKey, ThreadKey } from "./domain.js";
import { isDirectChannel, isThreadKey, type SlackPort } from "./slack-port.js";

/** How far apart calls of one method to one channel are, in milliseconds. */
export const METHOD_SPACING: Readonly<Record<string, number>> = {
  "chat.postMessage": 1_000,
  "chat.postEphemeral": 1_000,
  "chat.update": 1_200,
  "chat.appendStream": 1_000,
  "chat.startStream": 1_000,
  "chat.stopStream": 0,
};

/** The seconds a rate-limited Slack call says to wait, or nothing when it was not one. */
export function retryAfterOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { code?: unknown; retryAfter?: unknown };
  if (
    value.code === "slack_webapi_rate_limited_error" &&
    typeof value.retryAfter === "number"
  )
    return Math.max(0, value.retryAfter);
  return undefined;
}

export class RateLimitedError extends Error {
  constructor(readonly method: string) {
    super(`Slack kept refusing ${method} for its rate limit.`);
  }
}

export class SlackRateLimiter {
  readonly #next = new Map<string, number>();
  /** Every wait it made, in milliseconds: what tests and metrics read. */
  readonly waits: number[] = [];

  constructor(
    readonly clock: Clock = systemClock,
    readonly maxRetries = 3,
  ) {}

  /** Run one Slack call for a channel, spaced and retried on a 429. */
  async run<T>(
    method: string,
    channelId: string,
    call: () => Promise<T>,
  ): Promise<T> {
    return this.#call(method, channelId, call, true);
  }

  /**
   * Run one Slack call that is not paced (a card, a private word, App Home):
   * not spaced, but a 429 still waits Slack's `Retry-After`, a bounded number
   * of times. The Web client rejects rate-limited calls (`bolt.ts`), so this is
   * where every 429 is seen.
   */
  async retry<T>(
    method: string,
    channelId: string,
    call: () => Promise<T>,
  ): Promise<T> {
    return this.#call(method, channelId, call, false);
  }

  async #call<T>(
    method: string,
    channelId: string,
    call: () => Promise<T>,
    spaced: boolean,
  ): Promise<T> {
    const key = `${method}:${channelId}`;
    for (let attempt = 0; ; attempt += 1) {
      const wait = (this.#next.get(key) ?? 0) - this.clock.now();
      if (wait > 0) {
        this.waits.push(wait);
        await this.clock.sleep(wait);
      }
      if (spaced)
        this.#next.set(
          key,
          this.clock.now() + (METHOD_SPACING[method] ?? 1_000),
        );
      try {
        return await call();
      } catch (error) {
        const seconds = retryAfterOf(error);
        if (seconds === undefined) throw error;
        if (attempt >= this.maxRetries) throw new RateLimitedError(method);
        this.#next.set(key, this.clock.now() + seconds * 1_000);
      }
    }
  }
}

/**
 * A Slack port whose every call waits out a 429 (`SlackRateLimiter.retry`):
 * what everything but a turn's answer posts through. A turn's answer is paced
 * by its renderer on the port itself (`render.ts`).
 */
export function retryingSlackPort(
  port: SlackPort,
  limiter: SlackRateLimiter,
): SlackPort {
  const streaming = port.streaming;
  const channelOf = (key: SlackInstallationKey | ThreadKey, userId: string) =>
    isThreadKey(key) ? key.channelId : userId;
  return {
    postDirect: (key, userId, message) =>
      limiter.retry("chat.postMessage", userId, () =>
        port.postDirect(key, userId, message),
      ),
    postPrivate: (key, userId, message) =>
      limiter.retry(
        isThreadKey(key) && !isDirectChannel(key.channelId)
          ? "chat.postEphemeral"
          : "chat.postMessage",
        channelOf(key, userId),
        () => port.postPrivate(key, userId, message),
      ),
    postThread: (key, message) =>
      limiter.retry("chat.postMessage", key.channelId, () =>
        port.postThread(key, message),
      ),
    updateMessage: (key, ts, message) =>
      limiter.retry("chat.update", key.channelId, () =>
        port.updateMessage(key, ts, message),
      ),
    memberOf: (key, userId) =>
      limiter.retry("users.info", userId, () => port.memberOf(key, userId)),
    suggestPrompts: (key, title, prompts) =>
      limiter.retry(
        "assistant.threads.setSuggestedPrompts",
        key.channelId,
        () => port.suggestPrompts(key, title, prompts),
      ),
    streaming,
  };
}
