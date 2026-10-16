import { randomBytes } from "node:crypto";

import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MemoryWorkQueue,
  PostgresWorkQueue,
  SecretCipher,
  type WorkQueue,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import type {
  IncomingPrompt,
  ThreadBinding,
  ThreadKey,
} from "../src/domain.js";
import { PostgresSlackStore } from "../src/postgres-store.js";
import { MemorySlackStore, type SlackStore } from "../src/store.js";
import { testDatabase } from "./support/postgres.js";

/**
 * The Slack-side records (S-004), on the memory store always and on
 * Postgres when `SLACK_TEST_DATABASE_URL` names a throwaway database:
 * every migration applied, then the same cases.
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

    it("keeps a rotating bot token, rotates it only while active (S-102)", async () => {
      await reset();
      await store.putInstallation({
        ...key,
        botRefreshToken: "xoxe-1-first",
        botToken: "xoxe.xoxb-first",
        botTokenExpiresAt: 1_792_000_000,
        botUserId: "B1",
        installedBy: "U0",
        scopes: ["app_mentions:read", "chat:write", "im:history"],
        status: "active",
        updatedAt: at.toISOString(),
      });
      expect(await store.getInstallation(key)).toMatchObject({
        botRefreshToken: "xoxe-1-first",
        botTokenExpiresAt: 1_792_000_000,
      });
      const rotated = {
        botRefreshToken: "xoxe-1-second",
        botToken: "xoxe.xoxb-second",
        botTokenExpiresAt: 1_792_043_200,
        updatedAt: at.toISOString(),
      };
      expect(await store.rotateBotToken(key, rotated)).toBe(true);
      expect(await store.getInstallation(key)).toMatchObject({
        ...rotated,
        status: "active",
      });
      await store.deleteInstallation(key);
      expect(await store.rotateBotToken(key, rotated)).toBe(false);
      expect(await store.getInstallation(key)).toBeUndefined();
      await installed(store);
      const plain = await store.getInstallation(key);
      expect(plain?.botRefreshToken).toBeUndefined();
      expect(plain?.botTokenExpiresAt).toBeUndefined();
    });

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

    it("starts one of two concurrent first turns of a thread, the other busy (S-207)", async () => {
      await reset();
      await installed(store);
      // A thread with no turn row yet: the review reproduced both starting on Postgres.
      const fresh: ThreadKey = { ...thread, threadTs: "7.0" };
      const claims = await Promise.all(
        ["Ev1", "Ev2", "Ev3", "Ev4"].map((eventId) =>
          store.beginTurn(fresh, eventId, at, 60_000),
        ),
      );
      expect(claims.filter((one) => one.outcome === "started")).toHaveLength(1);
      expect(claims.filter((one) => one.outcome === "busy")).toHaveLength(3);
    });

    it("keeps a heartbeat that keeps a long turn from being taken over (S-207)", async () => {
      await reset();
      await installed(store);
      await store.beginTurn(thread, "Ev1", at, 60_000);
      const beat = new Date(at.getTime() + 100_000);
      await store.updateTurn(thread, "Ev1", {
        heartbeatAt: beat.toISOString(),
      });
      expect((await store.getTurn(thread))?.heartbeatAt).toBe(
        beat.toISOString(),
      );
      // Two minutes after the start, but twenty seconds after the heartbeat.
      const later = new Date(at.getTime() + 120_000);
      expect(
        (await store.beginTurn(thread, "Ev2", later, 60_000)).outcome,
      ).toBe("busy");
      // Its heartbeat stops (the worker died): taken over once stale, and the
      // new turn starts with no heartbeat of the old one.
      const much = new Date(at.getTime() + 300_000);
      const taken = await store.beginTurn(thread, "Ev3", much, 60_000);
      expect(taken.outcome).toBe("started");
      expect(taken.turn.heartbeatAt).toBeUndefined();
    });

    it("marks who stopped a running turn, unmarks it, and starts the next turn unmarked (S-205)", async () => {
      await reset();
      await installed(store);
      await store.beginTurn(thread, "Ev1", at, 60_000);
      // Another event's mark is not this turn's.
      await store.markStopped(thread, "Ev0", "U9");
      expect((await store.getTurn(thread))?.stoppedBy).toBeUndefined();
      await store.markStopped(thread, "Ev1", "U1");
      expect((await store.getTurn(thread))?.stoppedBy).toBe("U1");
      await store.markStopped(thread, "Ev1", undefined);
      expect((await store.getTurn(thread))?.stoppedBy).toBeUndefined();
      await store.markStopped(thread, "Ev1", "U1");
      await store.endTurn(thread, "Ev1");
      const next = await store.beginTurn(
        thread,
        "Ev2",
        new Date(at.getTime() + 1_000),
        60_000,
      );
      expect(next.outcome).toBe("started");
      expect(next.turn.stoppedBy).toBeUndefined();
      expect((await store.getTurn(thread))?.stoppedBy).toBeUndefined();
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
    database = await testDatabase(DATABASE_URL, "slack_test_records");
  });
  afterAll(async () => {
    await database?.end();
  });
  const cipher = new SecretCipher(randomBytes(32).toString("base64"), 1);
  describe("the Postgres turn lock on a thread's first turn (S-207)", () => {
    it("serializes two workers even when both read the thread before either writes", async () => {
      await database.query(
        "TRUNCATE slack_installations, slack_event_claims, slack_jobs CASCADE",
      );
      // Each worker pauses right after reading the thread's turn row, so
      // both read "no turn" before either inserts: the review's reproduction.
      const pause = async (client: PoolClient): Promise<PoolClient> => {
        const query = client.query.bind(client) as (
          text: string,
          values?: unknown[],
        ) => Promise<unknown>;
        return Object.assign(Object.create(client) as PoolClient, {
          query: async (text: string, values?: unknown[]) => {
            const result = await query(text, values);
            if (text.includes("FOR UPDATE"))
              await new Promise((resolve) => setTimeout(resolve, 150));
            return result;
          },
          release: () => client.release(),
        });
      };
      const slowed = Object.assign(Object.create(database) as Pool, {
        connect: async () => pause(await database.connect()),
        query: database.query.bind(database),
      });
      const store = new PostgresSlackStore(slowed, cipher);
      await installed(store);
      const fresh: ThreadKey = { ...thread, threadTs: "8.0" };
      const claims = await Promise.all([
        store.beginTurn(fresh, "Ev1", at, 60_000),
        store.beginTurn(fresh, "Ev2", at, 60_000),
      ]);
      expect(claims.map((one) => one.outcome).sort()).toEqual([
        "busy",
        "started",
      ]);
    });
  });
  describe("the Postgres work queue's lease (S-207)", () => {
    it("renews a job's lease while it is worked, so a long turn is not reclaimed", async () => {
      await database.query("TRUNCATE slack_jobs");
      const queue = new PostgresWorkQueue<{ n: number }>(
        database,
        "slack",
        10,
        50,
      );
      await queue.enqueue({ n: 1 });
      const leases: number[] = [];
      let finish!: () => void;
      const done = new Promise<void>((resolve) => (finish = resolve));
      queue.start(async () => {
        for (let read = 0; read < 4; read += 1) {
          await new Promise((resolve) => setTimeout(resolve, 120));
          const row = await database.query<{ locked_at: Date }>(
            "SELECT locked_at FROM slack_jobs WHERE state = 'processing'",
          );
          leases.push(new Date(row.rows[0]?.locked_at ?? 0).getTime());
        }
        finish();
      });
      await done;
      await queue.stop();
      expect(leases.every((lease) => lease > 0)).toBe(true);
      // Renewed while worked: the lease never goes back and has moved on by
      // the end. Two reads 120 ms apart may see the same renewal on a slow
      // runner (CI run 38913319947), so each step is only never earlier.
      for (let index = 1; index < leases.length; index += 1)
        expect(leases[index]).toBeGreaterThanOrEqual(leases[index - 1] ?? 0);
      expect(leases.at(-1)).toBeGreaterThan(leases[0] ?? 0);
      const left = await database.query("SELECT 1 FROM slack_jobs");
      expect(left.rowCount).toBe(0);
    });
  });
  suite("Slack records on Postgres", async () => {
    await database.query(
      "TRUNCATE slack_installations, slack_event_claims, slack_jobs CASCADE",
    );
    return {
      queue: new PostgresWorkQueue<unknown>(database, "slack"),
      store: new PostgresSlackStore(database, cipher),
    };
  });
}
