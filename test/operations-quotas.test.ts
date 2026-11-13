import { randomBytes } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import {
  payloadHash,
  quotaEntries,
  quotaWords,
  resetOf,
  SecretCipher,
  windowOf,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import { textOf } from "../src/solr/client.js";
import { SolrDeadLetters } from "../src/solr/dead-letters.js";
import { SolrWorkQueue } from "../src/solr/queue.js";
import { documentOf, SolrRecords } from "../src/solr/records.js";
import { SolrSlackStore } from "../src/solr-store.js";
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
import { emptied, solrTestUrl, testCollection } from "./support/solr.js";

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

describe.runIf(Boolean(solrTestUrl))("on Solr", () => {
  let records: SolrRecords;
  beforeAll(async () => {
    records = await testCollection("test_slack_operations");
  }, 60_000);
  const cipher = new SecretCipher(randomBytes(32).toString("base64"), 1);

  /** A job as the queue keeps it, written straight in. */
  async function job(payload: unknown, fields: Record<string, unknown>) {
    const doc = documentOf("job", null, {
      attempts_i: 0,
      available_dt: new Date(),
      kind_s: "prompt",
      payload_stored: JSON.stringify(payload),
      state_s: "ready",
      ...fields,
    });
    await records.client.add([doc]);
    return textOf(doc.uid);
  }

  it("takes quotas atomically, the same cases", async () => {
    await emptied(records);
    await quotaCases(new SolrSlackStore(records, cipher));
  }, 60_000);

  it("takes quotas once under concurrency, from two processes", async () => {
    await emptied(records);
    const other = new SolrRecords(records.client, {
      leaseMs: 5_000,
      stripes: records.stripes,
    });
    const stores = [
      new SolrSlackStore(records, cipher),
      new SolrSlackStore(other, cipher),
    ];
    const entries = entriesOf(
      { ...limits, installation: 100, user: 3 },
      { ...turn, externalUserId: "Ucc" },
    );
    const taken = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        stores[index % 2]!.takeQuota(entries, "2026-10-16T10"),
      ),
    );
    expect(taken.filter((one) => one.ok)).toHaveLength(3);
  }, 60_000);

  it("lists dead letters by metadata and hash, replays once, and reads a payload only for a reason, audited", async () => {
    await emptied(records);
    const queue = new SolrWorkQueue<unknown>(records);
    const payload = {
      prompt: { text: "my salary is 100k", token: "xoxb-123456789012-secret" }, // gitleaks:allow — a fake token the redaction test must strip
    };
    const id = await job(payload, {
      attempts_i: 5,
      last_error_stored: "refused Bearer abcdefghijklmnop",
      state_s: "dead",
    });
    const { lines, logger } = keptLogger();
    const letters = new SolrDeadLetters(queue, "slack", logger);
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
    expect(await records.find("payload_access", { job_uid_s: id })).toEqual([
      { jobUid: id, operator: "ops", reason: "a customer asked why it failed" },
    ]);
    expect(lines.some((line) => line.includes('"payload.read"'))).toBe(true);

    await expect(letters.replay(id, "ops")).resolves.toBe(true);
    await expect(letters.replay(id, "ops")).resolves.toBe(false);
    expect(await letters.list()).toEqual([]);
    // Every replay is kept with who asked, refused or not.
    expect(await records.find("job_replay", { job_uid_s: id })).toEqual([
      { jobUid: id, operator: "ops", replayed: true },
      { jobUid: id, operator: "ops", replayed: false },
    ]);
    await expect(letters.replay(id, " ")).rejects.toThrow(/Name who replays/);
  }, 60_000);

  it("reads a dead job's payload only: a live job or an unknown id is refused, and no read is recorded (S-405)", async () => {
    await emptied(records);
    const queue = new SolrWorkQueue<unknown>(records);
    const live = await job({ prompt: { text: "a live question" } }, {});
    const letters = new SolrDeadLetters(queue, "slack", keptLogger().logger);
    for (const id of [live, "01ZZZZZZZZZZZZZZZZZZZZZZZZ", "*:*"])
      await expect(
        letters.payload(id, "ops", "a customer asked why it failed"),
      ).rejects.toThrow(/not a dead job/);
    expect(await records.count("payload_access")).toBe(0);
  }, 60_000);
});
