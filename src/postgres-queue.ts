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

  async enqueue(item: T): Promise<void> {
    await this.database.query("INSERT INTO slack_jobs (payload) VALUES ($1)", [
      item,
    ]);
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
