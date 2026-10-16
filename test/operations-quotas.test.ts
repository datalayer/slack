import { randomBytes } from "node:crypto";

import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DeadLetters,
  payloadHash,
  PostgresWorkQueue,
  quotaEntries,
  quotaWords,
  resetOf,
  SecretCipher,
  windowOf,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import { PostgresSlackStore } from "../src/postgres-store.js";
import { SlackAgentService } from "../src/service.js";
import { MemorySlackStore, type SlackStore } from "../src/store.js";
import {
  FakeAgents,
  FakeClock,
  FakeLinks,
  FakeSlack,
  installedStore,
  keptLogger,
  promptOf,
} from "./support/fakes.js";
import { testDatabase } from "./support/postgres.js";

const limits = { application: 5, installation: 3, organization: 5, user: 2 };
const turn = {
  applicationId: "dep-1",
  externalUserId: "U1",
  installation: "A1:-:T1",
};
// Slack keeps its counts under `workspace:<id>` (DISCORD DC-004).
const entriesOf = (
  limit: typeof limits,
  one: typeof turn & { organizationId?: string },
) => quotaEntries(limit, one, "workspace");

async function quotaCases(store: SlackStore) {
  const window = "2026-10-16T08";
  const entries = entriesOf(limits, turn);
  expect((await store.takeQuota(entries, window)).ok).toBe(true);
  expect((await store.takeQuota(entries, window)).ok).toBe(true);
  // The person's two are spent: refused, and nothing else counted.
  expect(await store.takeQuota(entries, window)).toMatchObject({
    entry: { scope: "user" },
    ok: false,
  });
  expect(await store.quotaUsed("workspace:A1:-:T1", window)).toBe(2);
  // Another person: the workspace's third, then the workspace is spent.
  const bob = entriesOf(limits, { ...turn, externalUserId: "U2" });
  expect((await store.takeQuota(bob, window)).ok).toBe(true);
  expect(await store.takeQuota(bob, window)).toMatchObject({
    entry: { scope: "installation" },
    ok: false,
  });
  // The next hour starts again.
  expect((await store.takeQuota(entries, "2026-10-16T09")).ok).toBe(true);
}

describe("quotas before costly work (S-404)", () => {
  it("counts per person, workspace and application, all or none, by the hour (memory)", async () => {
    await quotaCases(new MemorySlackStore());
  });

  it("counts an organization when the installation names one", () => {
    expect(
      entriesOf(limits, { ...turn, organizationId: "org-1" }).map(
        (one) => one.scope,
      ),
    ).toEqual(["user", "installation", "organization", "application"]);
  });

  it("says which limit and when it resets", () => {
    const now = new Date("2026-10-16T08:41:00Z");
    expect(windowOf(now)).toBe("2026-10-16T08");
    expect(resetOf(now).toISOString()).toBe("2026-10-16T09:00:00.000Z");
    expect(
      quotaWords(
        {
          limit: 60,
          ok: false,
          resetsAt: resetOf(now),
          scope: "user",
        },
        "this workspace",
      ),
    ).toBe(
      "@Datalayer has answered 60 questions this hour for you, its limit. Ask again after 09:00 UTC.",
    );
  });

  it("refuses privately before the turn starts at Datalayer, and does not count a resumed turn", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    const slack = new FakeSlack();
    const agents = new FakeAgents();
    const service = new SlackAgentService(
      store,
      agents,
      slack,
      "https://datalayer.ai",
      new FakeLinks(),
      {
        clock: new FakeClock(),
        logger: keptLogger().logger,
        quotas: { ...limits, user: 1 },
      },
    );
    await service.handlePrompt(promptOf(), "B1");
    await service.handlePrompt(
      promptOf({ eventId: "Ev2", threadTs: "2.0" }),
      "B1",
    );
    expect(agents.requests).toHaveLength(1);
    expect(slack.of("private").at(-1)?.message?.text).toContain(
      "questions this hour for you",
    );
  });
});

const DATABASE_URL = process.env.DATALAYER_SLACK_TEST_DATABASE_URL;

describe.runIf(Boolean(DATABASE_URL))("on Postgres", () => {
  let database: Pool;
  beforeAll(async () => {
    database = await testDatabase(DATABASE_URL ?? "", "slack_test_operations");
  });
  afterAll(async () => {
    await database?.end();
  });

  it("takes quotas atomically, the same cases", async () => {
    await quotaCases(
      new PostgresSlackStore(
        database,
        new SecretCipher(randomBytes(32).toString("base64"), 1),
      ),
    );
  });

  it("takes quotas once under concurrency", async () => {
    const store = new PostgresSlackStore(
      database,
      new SecretCipher(randomBytes(32).toString("base64"), 1),
    );
    const entries = entriesOf(
      { ...limits, installation: 100, user: 3 },
      { ...turn, externalUserId: "Ucc" },
    );
    const taken = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.takeQuota(entries, "2026-10-16T10"),
      ),
    );
    expect(taken.filter((one) => one.ok)).toHaveLength(3);
  });

  it("lists dead letters by metadata and hash, replays once, and reads a payload only for a reason, audited", async () => {
    const queue = new PostgresWorkQueue<unknown>(database, "slack");
    const payload = {
      prompt: { text: "my salary is 100k", token: "xoxb-123456789012-secret" }, // gitleaks:allow — a fake token the redaction test must strip
    };
    const inserted = await database.query<{ id: string }>(
      "INSERT INTO slack_jobs (payload, state, attempts, last_error) VALUES ($1, 'dead', 5, $2) RETURNING id::text",
      [payload, "refused Bearer abcdefghijklmnop"],
    );
    const id = inserted.rows[0]!.id;
    const { lines, logger } = keptLogger();
    const letters = new DeadLetters(database, queue, logger);
    const listed = await letters.list();
    expect(listed).toEqual([
      expect.objectContaining({
        attempts: 5,
        id,
        kind: "prompt",
        payloadHash: payloadHash(payload),
      }),
    ]);
    expect(JSON.stringify(listed)).not.toContain("salary");
    expect(JSON.stringify(listed)).not.toContain("abcdefghijklmnop");

    await expect(letters.payload(id, "ops", "why")).rejects.toThrow(/Say why/);
    const read = (await letters.payload(
      id,
      "ops",
      "a customer asked why it failed",
    )) as {
      prompt: { text: string; token: string };
    };
    expect(read.prompt.token).toBe("[redacted]");
    // The words are what the privileged read is for.
    expect(read.prompt.text).toBe("my salary is 100k");
    const access = await database.query(
      "SELECT operator, reason FROM slack_payload_access WHERE job_id = $1",
      [id],
    );
    expect(access.rows).toEqual([
      { operator: "ops", reason: "a customer asked why it failed" },
    ]);
    expect(lines.some((line) => line.includes('"payload.read"'))).toBe(true);

    await expect(letters.replay(id, "ops")).resolves.toBe(true);
    await expect(letters.replay(id, "ops")).resolves.toBe(false);
    expect(await letters.list()).toEqual([]);
    // Every replay is kept with who asked, refused or not.
    const replays = await database.query(
      "SELECT operator, replayed FROM slack_job_replays WHERE job_id = $1 ORDER BY id",
      [id],
    );
    expect(replays.rows).toEqual([
      { operator: "ops", replayed: true },
      { operator: "ops", replayed: false },
    ]);
    await expect(letters.replay(id, " ")).rejects.toThrow(/Name who replays/);
  });

  it("reads a dead job's payload only: a live job or an unknown id is refused, and no read is recorded (S-405)", async () => {
    const queue = new PostgresWorkQueue<unknown>(database, "slack");
    const live = await database.query<{ id: string }>(
      "INSERT INTO slack_jobs (payload, state, attempts) VALUES ($1, 'ready', 0) RETURNING id::text",
      [{ prompt: { text: "a live question" } }],
    );
    const letters = new DeadLetters(database, queue, keptLogger().logger);
    const reads = async () =>
      (await database.query("SELECT 1 FROM slack_payload_access")).rowCount;
    const before = await reads();
    for (const id of [
      live.rows[0]!.id,
      "999999999",
      "1; DROP TABLE slack_jobs",
    ])
      await expect(
        letters.payload(id, "ops", "a customer asked why it failed"),
      ).rejects.toThrow(/not a dead job/);
    expect(await reads()).toBe(before);
  });
});
