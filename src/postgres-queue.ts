import type { Pool, PoolClient } from "pg";

import type { WorkQueue } from "./queue.js";

type Job<T> = Readonly<{ attempts: number; id: string; payload: T }>;

export class PostgresWorkQueue<T> implements WorkQueue<T> {
  #handler?: (item: T) => Promise<void>;
  #loop?: Promise<void>;
  #stopping = false;

  constructor(
    readonly database: Pool,
    readonly pollIntervalMs = 250,
  ) {}

  async enqueue(item: T, idempotencyKey?: string): Promise<boolean> {
    if (!idempotencyKey) {
      await this.database.query(
        "INSERT INTO slack_jobs (payload) VALUES ($1)",
        [item],
      );
      return true;
    }
    // The idempotency key and its job in one transaction (§7.1, 4).
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const claimed = await client.query(
        "INSERT INTO slack_event_claims (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id",
        [`ingress:${idempotencyKey}`],
      );
      if (claimed.rowCount === 1)
        await client.query("INSERT INTO slack_jobs (payload) VALUES ($1)", [
          item,
        ]);
      await client.query("COMMIT");
      return claimed.rowCount === 1;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async ready(): Promise<boolean> {
    try {
      await this.database.query("SELECT 1 FROM slack_jobs LIMIT 1");
      return true;
    } catch {
      return false;
    }
  }

  /** Jobs that failed five times, with their metadata only: what the dead-letter tool lists. */
  async dead(limit = 50): Promise<
    Array<{
      id: string;
      attempts: number;
      lastError: string | null;
      createdAt: string;
      kind: string;
    }>
  > {
    const result = await this.database.query<{
      attempts: number;
      created_at: Date;
      id: string;
      kind: string | null;
      last_error: string | null;
    }>(
      `SELECT id::text, attempts, last_error, created_at,
              CASE WHEN payload ? 'delivery' THEN 'delivery'
                   WHEN payload ? 'prompt' THEN 'prompt'
                   ELSE 'other' END AS kind
       FROM slack_jobs WHERE state = 'dead' ORDER BY id LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      attempts: row.attempts,
      createdAt: new Date(row.created_at).toISOString(),
      id: row.id,
      kind: row.kind ?? "other",
      lastError: row.last_error,
    }));
  }

  /** Put a dead job back to work: once, by id. */
  async replay(id: string): Promise<boolean> {
    const result = await this.database.query(
      "UPDATE slack_jobs SET state = 'ready', attempts = 0, available_at = now(), last_error = NULL WHERE id = $1 AND state = 'dead'",
      [id],
    );
    return result.rowCount === 1;
  }

  /** A dead job's payload: privileged, read only through the audited tool. */
  async payloadOf(id: string): Promise<unknown> {
    const result = await this.database.query<{ payload: unknown }>(
      "SELECT payload FROM slack_jobs WHERE id = $1",
      [id],
    );
    return result.rows[0]?.payload;
  }

  start(handler: (item: T) => Promise<void>): void {
    if (this.#loop)
      throw new Error("The PostgreSQL work queue has already started.");
    this.#handler = handler;
    this.#stopping = false;
    this.#loop = this.#run();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    await this.#loop;
    this.#loop = undefined;
    this.#handler = undefined;
  }

  async #run(): Promise<void> {
    while (!this.#stopping) {
      const job = await this.#claim();
      if (!job) {
        await delay(this.pollIntervalMs);
        continue;
      }
      try {
        await this.#handler?.(job.payload);
        await this.database.query("DELETE FROM slack_jobs WHERE id = $1", [
          job.id,
        ]);
      } catch (error) {
        await this.#fail(job, error);
      }
    }
  }

  async #claim(): Promise<Job<T> | undefined> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      await reclaimAbandonedJobs(client);
      const selected = await client.query<Job<T>>(
        `SELECT id::text, payload, attempts
         FROM slack_jobs
         WHERE state = 'ready' AND available_at <= now()
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
      );
      const job = selected.rows[0];
      if (!job) {
        await client.query("COMMIT");
        return undefined;
      }
      await client.query(
        `UPDATE slack_jobs
         SET state = 'processing', attempts = attempts + 1, locked_at = now()
         WHERE id = $1`,
        [job.id],
      );
      await client.query("COMMIT");
      return { ...job, attempts: job.attempts + 1 };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async #fail(job: Job<T>, error: unknown): Promise<void> {
    const message =
      error instanceof Error ? error.message : "Unknown worker failure";
    if (job.attempts >= 5) {
      await this.database.query(
        "UPDATE slack_jobs SET state = 'dead', last_error = $2, locked_at = NULL WHERE id = $1",
        [job.id, message.slice(0, 2_000)],
      );
      return;
    }
    const delaySeconds = Math.min(300, 2 ** job.attempts);
    await this.database.query(
      `UPDATE slack_jobs
       SET state = 'ready', available_at = now() + ($2 * interval '1 second'),
           last_error = $3, locked_at = NULL
       WHERE id = $1`,
      [job.id, delaySeconds, message.slice(0, 2_000)],
    );
  }
}

async function reclaimAbandonedJobs(client: PoolClient): Promise<void> {
  await client.query(
    `UPDATE slack_jobs
     SET state = 'ready', available_at = now(), locked_at = NULL,
         last_error = 'Worker lease expired'
     WHERE state = 'processing' AND locked_at < now() - interval '5 minutes'`,
  );
}

const delay = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
