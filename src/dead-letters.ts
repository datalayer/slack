import { createHash } from "node:crypto";

import type { Pool } from "pg";

import { Logger, redact, redactCredentials } from "./observability.js";
import type { PostgresWorkQueue } from "./postgres-queue.js";

/**
 * Dead letters (plans/SLACK.md §9, S-405): jobs that failed five times. By
 * default an operator sees their metadata and a hash of their payload — never
 * the words of a prompt or a delivery. Replaying puts one back to work, once.
 * Reading a payload is privileged: a dead job's only, it needs a reason, is
 * recorded in `slack_payload_access` and audited, and its credentials are
 * still redacted. Every replay is kept in `slack_job_replays` with who asked.
 */
export type DeadLetter = Readonly<{
  id: string;
  kind: string;
  attempts: number;
  createdAt: string;
  /** The last error, redacted: a credential in an error message is not shown. */
  lastError: string;
  /** sha256 of the payload: tells two jobs apart without showing either. */
  payloadHash: string;
}>;

export function payloadHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export class DeadLetters {
  constructor(
    readonly database: Pool,
    readonly queue: PostgresWorkQueue<unknown>,
    readonly logger: Logger = new Logger(),
  ) {}

  async list(limit = 50): Promise<DeadLetter[]> {
    const dead = await this.queue.dead(limit);
    return Promise.all(
      dead.map(async (one) => ({
        attempts: one.attempts,
        createdAt: one.createdAt,
        id: one.id,
        kind: one.kind,
        lastError: String(redact(one.lastError ?? "")),
        payloadHash: payloadHash(await this.queue.payloadOf(one.id)),
      })),
    );
  }

  async replay(id: string, operator: string): Promise<boolean> {
    if (!operator.trim()) throw new Error("Name who replays the job.");
    const replayed = await this.queue.replay(id, operator);
    this.logger.audit("admin.changed", {
      by: operator,
      installation: "slack-queue",
      job: id,
      reason: replayed ? "dead job replayed" : "not a dead job",
    });
    return replayed;
  }

  /** A payload, for a stated reason, recorded and audited; secrets still redacted. */
  async payload(
    id: string,
    operator: string,
    reason: string,
  ): Promise<unknown> {
    if (reason.trim().length < 10)
      throw new Error("Say why the payload is read: ten characters at least.");
    if (!operator.trim()) throw new Error("Name who reads the payload.");
    // A dead job's only: a live job or an unknown id is refused, and no read
    // of it is recorded.
    const payload = await this.queue.payloadOf(id);
    if (payload === undefined)
      throw new Error(
        `Job ${id} is not a dead job: there is no payload to read.`,
      );
    await this.database.query(
      "INSERT INTO slack_payload_access (job_id, operator, reason) VALUES ($1, $2, $3)",
      [id, operator, reason.slice(0, 1_000)],
    );
    this.logger.audit("payload.read", {
      by: operator,
      installation: "slack-queue",
      job: id,
      reason: "privileged payload access",
    });
    return redactCredentials(payload);
  }
}
