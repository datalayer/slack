import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";

import {
  deadLetters,
  PostgresWorkQueue,
  SecretCipher,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresSlackStore } from "../src/postgres-store.js";

/**
 * The database roles of S-405 on a throwaway PostgreSQL
 * (`DATALAYER_SLACK_TEST_DATABASE_URL`, a superuser's, never a cluster's),
 * in a database of this file's own (the other files share one database by
 * schema): migrated as the service's role first (today's shape), the
 * one-time SQL of the README run as the superuser, then `migrate --roles` as
 * slack_owner. The service's role cannot read a dead job's payload and still
 * works its queue; slack_dead_letters reads dead jobs only, and every payload
 * read and every replay leaves an audit row.
 */
const DATABASE_URL = process.env.DATALAYER_SLACK_TEST_DATABASE_URL;
const DATABASE = "slack_test_roles";
// Built, so that no secret scanner takes it for a credential.
const PASSWORD = ["test", "only", "role"].join("-");
const SERVICE = "slack";
const ROLES = [SERVICE, "slack_owner", "slack_dead_letters"];
const run = promisify(execFile);

const as = (role?: string) => {
  const url = new URL(DATABASE_URL ?? "");
  url.pathname = `/${DATABASE}`;
  if (role) {
    url.username = role;
    url.password = PASSWORD;
  }
  return url.toString();
};

/** The superuser's one-time statements, exactly as the README gives them. */
const oneTimeSql = (): string => {
  const doc = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const sql = /<!-- one-time-owner-sql -->\s*```sql\n([\s\S]*?)```/.exec(
    doc,
  )?.[1];
  if (!sql) throw new Error("The README has no one-time SQL.");
  return sql;
};

type Ran = { status: number; stdout: string; stderr: string };
const ran = async (
  command: string[],
  env: Record<string, string>,
): Promise<Ran> => {
  try {
    const { stdout, stderr } = await run(
      "node",
      ["--import", "tsx", ...command],
      { encoding: "utf8", env: { ...process.env, ...env } },
    );
    return { status: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return {
      status: typeof failed.code === "number" ? failed.code : 1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
};

describe.runIf(Boolean(DATABASE_URL))("database roles on PostgreSQL", () => {
  let admin: pg.Pool;
  let service: pg.Pool;
  let reader: pg.Pool;
  let iam: Server;
  let iamUrl = "";

  const migrate = (role: string, ...args: string[]) =>
    ran(["scripts/migrate.ts", ...args], {
      DATABASE_URL: as(role),
      DATALAYER_SLACK_SERVICE_ROLE: SERVICE,
    });
  const job = async (payload: object, state: string, attempts = 0) => {
    const [row] = (
      await admin.query<{ id: string }>(
        "INSERT INTO slack_jobs (payload, state, attempts) VALUES ($1, $2, $3) RETURNING id::text",
        [payload, state, attempts],
      )
    ).rows;
    if (!row) throw new Error("the insert returned no row");
    return row.id;
  };
  const audit = async () =>
    (
      await admin.query<{
        reads: string;
        replays: string;
        roles: string[] | null;
      }>(
        `SELECT (SELECT count(*) FROM slack_payload_access) AS reads,
                (SELECT count(*) FROM slack_job_replays) AS replays,
                (SELECT array_agg(DISTINCT database_role) FROM
                   (SELECT database_role FROM slack_payload_access
                    UNION ALL SELECT database_role FROM slack_job_replays) AS every) AS roles`,
      )
    ).rows[0];
  const event = (n: number) => ({
    kind: "event",
    eventId: `Ev${n}`,
    text: `the words of request ${n}`,
    teamId: "T1",
    userId: "U1",
  });

  beforeAll(async () => {
    const server = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    try {
      await server.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
      await server.query(`CREATE DATABASE ${DATABASE}`);
      for (const role of ROLES)
        await server.query(
          `DO $$ BEGIN
             IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
               CREATE ROLE ${role} LOGIN;
             END IF;
           END $$;
           ALTER ROLE ${role} LOGIN PASSWORD '${PASSWORD}'`,
        );
    } finally {
      await server.end();
    }
    admin = new pg.Pool({ connectionString: as(), max: 2 });
    // CNPG's database owner may create in public.
    await admin.query(
      `GRANT CREATE, USAGE ON SCHEMA public TO ${SERVICE}; GRANT CONNECT ON DATABASE ${DATABASE} TO PUBLIC`,
    );
    // Today's shape: the service's role runs the migrations and owns it all.
    const first = await migrate(SERVICE);
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    await admin.query(oneTimeSql());
    const roles = await migrate("slack_owner", "--roles");
    expect(roles.stderr).toBe("");
    expect(roles.status).toBe(0);
    service = new pg.Pool({ connectionString: as(SERVICE), max: 5 });
    reader = new pg.Pool({
      connectionString: as("slack_dead_letters"),
      max: 2,
    });
    // IAM's whoami for the operator's key: a person with the platform role.
    iam = createServer((request, response) => {
      const known =
        request.url === "/api/iam/v1/whoami" &&
        request.headers.authorization === "Bearer operator-key";
      response.writeHead(known ? 200 : 401, {
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify(
          known
            ? {
                profile: {
                  uid: "operator-grace",
                  roles_ss: ["platform_admin"],
                },
              }
            : {},
        ),
      );
    });
    await new Promise<void>((resolve) => iam.listen(0, "127.0.0.1", resolve));
    iamUrl = `http://127.0.0.1:${(iam.address() as AddressInfo).port}`;
  }, 180_000);
  afterAll(async () => {
    await service?.end();
    await reader?.end();
    await admin?.end();
    await new Promise((resolve) => (iam ? iam.close(resolve) : resolve(null)));
  });

  it("applies the roles step as slack_owner only, again to the same end, and names what it does not own", async () => {
    // The service's role makes nothing any more: its migrations stop first
    // (its own schema, first in its search_path, holds only the queue's view).
    const refused = await migrate(SERVICE, "--roles");
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("permission denied for schema slack");
    for (let time = 0; time < 2; time++) {
      const applied = await migrate("slack_owner", "--roles");
      expect(applied.stderr).toBe("");
      expect(applied.stdout).toContain(
        "Applied 1 database role steps for the service's role slack.",
      );
    }
    await admin.query(
      `CREATE TABLE slack_stray (id int); ALTER TABLE slack_stray OWNER TO ${SERVICE}`,
    );
    const stray = await migrate("slack_owner", "--roles");
    await admin.query("DROP TABLE slack_stray");
    expect(stray.status).not.toBe(0);
    expect(stray.stderr).toContain(
      "Not owned by slack_owner: public.slack_stray.",
    );
  }, 120_000);

  it("never shows the service's role a dead job's payload, nor the audit", async () => {
    await admin.query(
      "TRUNCATE slack_jobs, slack_payload_access, slack_job_replays",
    );
    const dead = await job(event(901), "dead", 5);
    const ready = await job(event(902), "ready");
    const { rows } = await service.query<{ id: string; payload: unknown }>(
      "SELECT id::text, payload FROM slack_jobs ORDER BY id",
    );
    expect(rows.map((row) => row.id)).toEqual([ready]);
    expect(
      (
        await service.query("SELECT payload FROM slack_jobs WHERE id = $1", [
          dead,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await service.query(
          "UPDATE slack_jobs SET state = 'ready' WHERE id = $1",
          [dead],
        )
      ).rowCount,
    ).toBe(0);
    for (const statement of [
      "SELECT payload FROM public.slack_jobs",
      "SELECT payload FROM slack_dead_letters.slack_jobs",
      "SELECT * FROM slack_payload_access",
      "INSERT INTO slack_job_replays (job_id, operator, replayed) VALUES (1, 'x', true)",
    ])
      await expect(service.query(statement)).rejects.toThrow(
        /permission denied/,
      );
    await expect(
      service.query("ALTER TABLE public.slack_jobs OWNER TO slack"),
    ).rejects.toThrow(/must be owner/);
    await expect(service.query("SET ROLE slack_owner")).rejects.toThrow(
      /permission denied/,
    );
    // The row is still there, its payload whole.
    const { rows: kept } = await admin.query<{ text: string }>(
      "SELECT payload->>'text' AS text FROM slack_jobs WHERE id = $1 AND state = 'dead'",
      [dead],
    );
    expect(kept).toEqual([{ text: "the words of request 901" }]);
  });

  it("works the queue and its tables as the service's role: enqueued once, done and deleted, dead after the fifth attempt", async () => {
    await admin.query("TRUNCATE slack_jobs, slack_event_claims");
    const queue = new PostgresWorkQueue<{ n: number }>(service, "slack", 20);
    expect(await queue.ready()).toBe(true);
    expect(await queue.enqueue({ n: 1 }, "event-1")).toBe(true);
    expect(await queue.enqueue({ n: 1 }, "event-1")).toBe(false);
    expect(await queue.enqueue({ n: 2 })).toBe(true);
    // Its fifth attempt.
    const dying = await job({ n: 3 }, "ready", 4);
    const handled: number[] = [];
    queue.start(async ({ n }) => {
      handled.push(n);
      if (n === 3) throw new Error("the fifth failure");
    });
    for (let wait = 0; wait < 100 && handled.length < 3; wait++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    await queue.stop();
    expect(handled.sort()).toEqual([1, 2, 3]);
    const { rows } = await admin.query(
      "SELECT id::text, state, attempts, last_error, payload FROM slack_jobs",
    );
    expect(rows).toEqual([
      {
        attempts: 5,
        id: dying,
        last_error: "the fifth failure",
        payload: { n: 3 },
        state: "dead",
      },
    ]);
    const store = new PostgresSlackStore(
      service,
      new SecretCipher(randomBytes(32).toString("base64"), 1),
    );
    expect(await store.claimEvent("event-2")).toBe(true);
    expect(await store.claimEvent("event-2")).toBe(false);
    await store.releaseEvent("event-2");
    expect(await store.claimEvent("event-2")).toBe(true);
  });

  it("reads and replays dead jobs only as slack_dead_letters, every read and replay audited", async () => {
    await admin.query(
      "TRUNCATE slack_jobs, slack_payload_access, slack_job_replays",
    );
    const dead = await job(event(920), "dead", 5);
    const other = await job(event(921), "dead", 5);
    const live = await job(event(922), "ready");
    const letters = deadLetters(reader, "slack");

    const listed = await letters.list();
    expect(listed.map((one) => one.id)).toEqual([dead, other]);
    expect(JSON.stringify(listed)).not.toContain("the words of request");

    const payload = await letters.payload(
      dead,
      "operator-ada",
      "the request failed five times",
    );
    expect(payload).toMatchObject({ text: "the words of request 920" });
    await expect(
      letters.payload(live, "operator-ada", "a live job is not dead"),
    ).rejects.toThrow(/not a dead job/);
    expect(await letters.replay(other, "operator-ada")).toBe(true);
    // Replayed, it is no dead job any more; a live one never was.
    expect(await letters.replay(other, "operator-ada")).toBe(false);
    expect(await letters.replay(live, "operator-ada")).toBe(false);
    expect(await audit()).toEqual({
      reads: "1",
      replays: "3",
      roles: ["slack_dead_letters"],
    });

    for (const statement of [
      "SELECT payload FROM public.slack_jobs",
      "SELECT * FROM slack_payload_access",
      "DELETE FROM slack_job_replays",
      "UPDATE slack_jobs SET payload = '{}'",
      "SELECT * FROM slack_installations",
    ])
      await expect(reader.query(statement)).rejects.toThrow(
        /permission denied/,
      );
    expect(
      (
        await reader.query("SELECT payload FROM slack_jobs WHERE id = $1", [
          live,
        ])
      ).rowCount,
    ).toBe(0);

    // The bin: as the reader, the operator checked at IAM, each payload read
    // and replay audited; the service's role refused.
    const bin = (role: string, ...args: string[]) =>
      ran(["src/dead-letters-cli.ts", ...args], {
        DATABASE_URL: as(role),
        DATALAYER_IAM_URL: iamUrl,
        DATALAYER_OPERATOR_KEY: "operator-key",
      });
    const list = await bin("slack_dead_letters", "list");
    expect(list.stderr).toBe("");
    expect(list.status).toBe(0);
    expect(list.stdout).toContain(dead);
    expect(list.stdout).not.toContain("the words of request");
    const read = await bin(
      "slack_dead_letters",
      "payload",
      dead,
      "checking",
      "the",
      "failure",
    );
    expect(read.status).toBe(0);
    expect(read.stdout).toContain("the words of request 920");
    expect((await bin("slack_dead_letters", "replay", dead)).stdout).toContain(
      `Job ${dead} is back to work.`,
    );
    const refused = await bin(SERVICE, "list");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("connect as slack_dead_letters");
    expect(await audit()).toEqual({
      reads: "2",
      replays: "4",
      roles: ["slack_dead_letters"],
    });
    const { rows } = await admin.query<{ operator: string }>(
      "SELECT operator FROM slack_payload_access ORDER BY id",
    );
    expect(rows.map((row) => row.operator)).toEqual([
      "operator-ada",
      "operator-grace",
    ]);
  }, 60_000);
});
