import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SecretCipher } from "../src/crypto.js";
import type {
  IncomingPrompt,
  ThreadBinding,
  ThreadKey,
} from "../src/domain.js";
import { PostgresSlackStore } from "../src/postgres-store.js";
import { PostgresWorkQueue } from "../src/postgres-queue.js";
import { MemorySlackStore, type SlackStore } from "../src/store.js";
import { MemoryWorkQueue, type WorkQueue } from "../src/queue.js";

/**
 * The §5 Slack-side records (S-004), on the memory store always and on
 * Postgres when `SLACK_TEST_DATABASE_URL` names a throwaway database:
 * migrations 001–003 applied, then the same cases.
 */
const DATABASE_URL = process.env.SLACK_TEST_DATABASE_URL;

const key = { appId: "A1", teamId: "T1" } as const;
const thread: ThreadKey = { ...key, channelId: "C1", threadTs: "1.0" };
const at = new Date("2026-10-16T08:00:00Z");

async function installed(store: SlackStore, teamId = "T1"): Promise<void> {
  await store.putInstallation({
    appId: "A1",
    botToken: "xoxb-test",
    botUserId: "B1",
    installedBy: "U0",
    scopes: ["app_mentions:read", "chat:write", "im:history"],
    status: "active",
    teamId,
    updatedAt: at.toISOString(),
  });
}

type Opened = { store: SlackStore; queue: WorkQueue<unknown> };

function suite(name: string, fresh: () => Promise<Opened>) {
  describe(name, () => {
    let store: SlackStore;
    let queue: WorkQueue<unknown>;
    const reset = async () => {
      ({ store, queue } = await fresh());
    };

    it("keeps an installation's allowances, replaced whole", async () => {
      await reset();
      await installed(store);
      const allowance = {
        ...key,
        channelPolicy: "channels" as const,
        configuredBy: "owner",
        enabled: true,
        isDefault: true,
        updatedAt: at.toISOString(),
      };
      await store.putAllowances(key, [
        { ...allowance, applicationId: "dep-1", name: "Launch Review" },
        {
          ...allowance,
          applicationId: "dep-2",
          channelPolicy: "direct-only",
          isDefault: false,
          name: "Desk",
        },
      ]);
      expect(
        (await store.getAllowances(key)).map((one) => one.applicationId),
      ).toEqual(["dep-1", "dep-2"]);
      await store.putAllowances(key, [
        { ...allowance, applicationId: "dep-2", name: "Desk" },
      ]);
      const after = await store.getAllowances(key);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({ applicationId: "dep-2", name: "Desk" });
    });

    it("keeps a channel binding per channel", async () => {
      await reset();
      await installed(store);
      await store.putChannelBinding({
        ...key,
        channelId: "C1",
        state: "deny",
        updatedAt: at.toISOString(),
        updatedBy: "owner",
      });
      await store.putChannelBinding({
        ...key,
        applicationId: "dep-2",
        channelId: "C2",
        state: "allow",
        updatedAt: at.toISOString(),
        updatedBy: "owner",
      });
      expect(await store.getChannelBinding(key, "C1")).toMatchObject({
        state: "deny",
      });
      expect(await store.getChannelBinding(key, "C2")).toMatchObject({
        applicationId: "dep-2",
        state: "allow",
      });
      expect(await store.getChannelBinding(key, "C3")).toBeUndefined();
    });

    it("keeps a delivery's target, version, status, attempts and last error", async () => {
      await reset();
      await installed(store);
      const delivery = {
        ...key,
        attempts: 1,
        deliveryId: "d1",
        payloadVersion: 1,
        status: "failed" as const,
        lastError: "ratelimited",
        target: { channelId: "C1", threadTs: "1.0" },
        updatedAt: at.toISOString(),
      };
      await store.putDelivery(delivery);
      await store.putDelivery({
        ...delivery,
        attempts: 2,
        status: "sent",
        lastError: undefined,
        slackTs: "2.0",
      });
      expect(await store.getDelivery(key, "d1")).toMatchObject({
        attempts: 2,
        payloadVersion: 1,
        slackTs: "2.0",
        status: "sent",
        target: { channelId: "C1", threadTs: "1.0" },
      });
    });

    it("runs one turn at a time per thread, resumes the same event and refuses a duplicate", async () => {
      await reset();
      await installed(store);
      const first = await store.beginTurn(thread, "Ev1", at, 60_000);
      expect(first.outcome).toBe("started");
      expect((await store.beginTurn(thread, "Ev2", at, 60_000)).outcome).toBe(
        "busy",
      );
      // The same event again: a redelivery after a crash, resumed.
      await store.updateTurn(thread, "Ev1", {
        messageTs: "2.0",
        runId: "t1",
        sessionId: "S1",
      });
      const resumed = await store.beginTurn(thread, "Ev1", at, 60_000);
      expect(resumed).toMatchObject({
        outcome: "resumed",
        turn: { messageTs: "2.0", runId: "t1", sessionId: "S1" },
      });
      await store.endTurn(thread, "Ev1");
      expect((await store.beginTurn(thread, "Ev1", at, 60_000)).outcome).toBe(
        "done",
      );
      expect((await store.beginTurn(thread, "Ev2", at, 60_000)).outcome).toBe(
        "started",
      );
      await store.endTurn(thread, "Ev2");
      // An older event redelivered after a newer one finished: still done.
      expect((await store.beginTurn(thread, "Ev1", at, 60_000)).outcome).toBe(
        "done",
      );
    });

    it("lets a stale running turn be taken over", async () => {
      await reset();
      await installed(store);
      await store.beginTurn(thread, "Ev1", at, 60_000);
      const later = new Date(at.getTime() + 120_000);
      expect(
        (await store.beginTurn(thread, "Ev2", later, 60_000)).outcome,
      ).toBe("started");
    });

    it("archives a binding, forgets it and remembers the next application", async () => {
      await reset();
      await installed(store);
      const binding: ThreadBinding = {
        ...thread,
        applicationId: "dep-1",
        lastEventId: "Ev1",
        lastRunId: "t1",
        openedByPrincipalId: "alice",
        sessionId: "S1",
        updatedAt: at.toISOString(),
        visibility: "channel",
      };
      await store.putThread(binding);
      expect(await store.getThread(thread)).toMatchObject({
        lastEventId: "Ev1",
        lastRunId: "t1",
        visibility: "channel",
      });
      await store.archiveThread(binding, "start-over");
      await store.deleteThread(thread);
      expect(await store.getThread(thread)).toBeUndefined();
      expect(await store.getArchivedThreads(thread)).toEqual([binding]);
      await store.setNextApplication(thread, "dep-2");
      expect(await store.getNextApplication(thread)).toBe("dep-2");
      await store.clearNextApplication(thread);
      expect(await store.getNextApplication(thread)).toBeUndefined();
    });

    it("hands a held prompt back once, to its own person only", async () => {
      await reset();
      await installed(store);
      const prompt: IncomingPrompt = {
        ...thread,
        eventId: "Ev9",
        text: "hello",
        userId: "U1",
      };
      await store.holdPrompt(prompt);
      expect(await store.takeHeldPrompt(key, "Ev9", "U2")).toBeUndefined();
      expect(await store.takeHeldPrompt(key, "Ev9", "U1")).toEqual(prompt);
      expect(await store.takeHeldPrompt(key, "Ev9", "U1")).toBeUndefined();
    });

    it("forgets every record of an uninstalled workspace", async () => {
      await reset();
      await installed(store);
      await store.putChannelBinding({
        ...key,
        channelId: "C1",
        state: "deny",
        updatedAt: at.toISOString(),
        updatedBy: "o",
      });
      await store.beginTurn(thread, "Ev1", at, 60_000);
      await store.holdPrompt({
        ...thread,
        eventId: "Ev2",
        text: "x",
        userId: "U1",
      });
      await store.deleteInstallation(key);
      expect(await store.getChannelBinding(key, "C1")).toBeUndefined();
      expect(await store.getTurn(thread)).toBeUndefined();
      expect(await store.takeHeldPrompt(key, "Ev2", "U1")).toBeUndefined();
    });

    it("enqueues a job once per idempotency key", async () => {
      await reset();
      expect(await queue.enqueue({ n: 1 }, "Ev1")).toBe(true);
      expect(await queue.enqueue({ n: 2 }, "Ev1")).toBe(false);
      expect(await queue.ready()).toBe(true);
    });
  });
}

suite("Slack records on the memory store", async () => ({
  queue: new MemoryWorkQueue<unknown>(),
  store: new MemorySlackStore(),
}));

if (DATABASE_URL) {
  let database: Pool;
  beforeAll(async () => {
    database = new Pool({ connectionString: DATABASE_URL, max: 4 });
    const folder = new URL("../migrations/", import.meta.url);
    for (const name of (await readdir(folder))
      .filter((one) => one.endsWith(".sql"))
      .sort())
      await database.query(await readFile(new URL(name, folder), "utf8"));
  });
  afterAll(async () => {
    await database?.end();
  });
  const cipher = new SecretCipher(randomBytes(32).toString("base64"), 1);
  suite("Slack records on Postgres", async () => {
    await database.query(
      "TRUNCATE slack_installations, slack_event_claims, slack_jobs CASCADE",
    );
    return {
      queue: new PostgresWorkQueue<unknown>(database),
      store: new PostgresSlackStore(database, cipher),
    };
  });
}
