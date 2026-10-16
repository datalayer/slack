/**
 * Slack's rate limits, kept before a call rather than discovered after it
 * (plans/SLACK.md §7.2, S-206): calls of one method to one channel are
 * spaced, and a 429 waits as long as Slack's `Retry-After` says, then tries
 * again a bounded number of times. Never one call per model token.
 */

export interface Clock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

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
    const key = `${method}:${channelId}`;
    for (let attempt = 0; ; attempt += 1) {
      const wait = (this.#next.get(key) ?? 0) - this.clock.now();
      if (wait > 0) {
        this.waits.push(wait);
        await this.clock.sleep(wait);
      }
      this.#next.set(key, this.clock.now() + (METHOD_SPACING[method] ?? 1_000));
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
