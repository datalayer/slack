import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { App } from "@slack/bolt";
import { afterEach, describe, expect, it } from "vitest";

import { registerSlackListeners, SLACK_EVENTS_PATH } from "../src/bolt.js";
import { guardRequestTimestamps } from "../src/health.js";
import { readConfig } from "../src/config.js";
import { MemoryWorkQueue } from "../src/queue.js";
import { SlackAgentService } from "../src/service.js";
import type { SlackJob } from "../src/worker.js";
import {
  FakeAgents,
  FakeLinks,
  FakeSlack,
  installedStore,
  keptLogger,
} from "./support/fakes.js";

/**
 * The HTTP ingress end to end (S-201): Bolt's receiver over a real socket,
 * this service's listeners behind it. Signed with the signing secret as
 * Slack signs; forged, replayed and skewed requests are refused before any
 * listener runs; URL verification never enqueues; each event is persisted
 * once, before the acknowledgement.
 */
const SECRET = ["test", "signing", "secret", "for", "fixtures"].join("-");

function sign(body: string, timestamp: number, secret = SECRET): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

class CountingQueue extends MemoryWorkQueue<SlackJob> {
  readonly persisted: SlackJob[] = [];
  failNext = false;
  override async enqueue(item: SlackJob, key?: string): Promise<boolean> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("database down");
    }
    const taken = await super.enqueue(item, key);
    if (taken) this.persisted.push(item);
    return taken;
  }
  override start(): void {
    // Jobs stay persisted: the test reads them, nothing works them.
  }
}

let server: Server | undefined;
let app: App | undefined;

afterEach(async () => {
  await app?.stop();
  app = undefined;
  server = undefined;
});

async function started() {
  const queue = new CountingQueue();
  app = new App({
    authorize: async () => ({
      botId: "Bx",
      botToken: "xoxb-test",
      botUserId: "B1",
    }),
    processBeforeResponse: true,
    signingSecret: SECRET,
  });
  guardRequestTimestamps(app, [SLACK_EVENTS_PATH]);
  const config = readConfig({ NODE_ENV: "test", SLACK_SIGNING_SECRET: SECRET });
  const store = await installedStore({ defaultApplication: "dep-1" });
  const service = new SlackAgentService(
    store,
    new FakeAgents(),
    new FakeSlack(),
    "https://datalayer.ai",
    new FakeLinks(),
    {
      logger: keptLogger().logger,
    },
  );
  registerSlackListeners(app, config, service, queue);
  server = (await app.start(0)) as Server;
  const port = (server.address() as AddressInfo).port;
  const post = (body: string, headers: Record<string, string>) =>
    fetch(`http://127.0.0.1:${port}/slack/events`, {
      body,
      headers: { "content-type": "application/json", ...headers },
      method: "POST",
    });
  return { post, queue };
}

const mention = (eventId = "Ev1") =>
  JSON.stringify({
    api_app_id: "A1",
    authorizations: [{ is_bot: true, user_id: "B1" }],
    event: {
      channel: "C1",
      event_ts: "1.0",
      text: "<@B1> hi",
      ts: "1.0",
      type: "app_mention",
      user: "U1",
    },
    event_id: eventId,
    event_time: 1,
    team_id: "T1",
    type: "event_callback",
  });

const now = () => Math.floor(Date.now() / 1000);

describe("signed HTTPS ingress (S-201)", () => {
  it("persists a signed mention once and acknowledges it", async () => {
    const { post, queue } = await started();
    const body = mention();
    const stamp = now();
    const response = await post(body, {
      "x-slack-request-timestamp": String(stamp),
      "x-slack-signature": sign(body, stamp),
    });
    expect(response.status).toBe(200);
    expect(queue.persisted).toHaveLength(1);
    // Slack's retry of the same event: acknowledged, not enqueued again.
    const retry = await post(body, {
      "x-slack-request-timestamp": String(stamp),
      "x-slack-retry-num": "1",
      "x-slack-retry-reason": "http_timeout",
      "x-slack-signature": sign(body, stamp),
    });
    expect(retry.status).toBe(200);
    expect(queue.persisted).toHaveLength(1);
  });

  it("refuses a forged signature", async () => {
    const { post, queue } = await started();
    const body = mention();
    const stamp = now();
    const response = await post(body, {
      "x-slack-request-timestamp": String(stamp),
      "x-slack-signature": sign(
        body,
        stamp,
        "another-secret-0123456789abcdefgh",
      ),
    });
    expect(response.status).toBe(401);
    expect(queue.persisted).toHaveLength(0);
  });

  it("refuses a body changed after signing", async () => {
    const { post, queue } = await started();
    const stamp = now();
    const response = await post(mention("Ev2"), {
      "x-slack-request-timestamp": String(stamp),
      "x-slack-signature": sign(mention("Ev1"), stamp),
    });
    expect(response.status).toBe(401);
    expect(queue.persisted).toHaveLength(0);
  });

  it.each([
    ["replayed six minutes later", -6 * 60],
    ["skewed six minutes ahead", 6 * 60],
  ])("refuses a request %s", async (_name, offset) => {
    const { post, queue } = await started();
    const body = mention();
    const stamp = now() + offset;
    const response = await post(body, {
      "x-slack-request-timestamp": String(stamp),
      "x-slack-signature": sign(body, stamp),
    });
    expect(response.status).toBe(401);
    expect(queue.persisted).toHaveLength(0);
  });

  it("answers URL verification without enqueuing anything", async () => {
    const { post, queue } = await started();
    const body = JSON.stringify({
      challenge: "c-123",
      token: "t",
      type: "url_verification",
    });
    const stamp = now();
    const response = await post(body, {
      "x-slack-request-timestamp": String(stamp),
      "x-slack-signature": sign(body, stamp),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("c-123");
    expect(queue.persisted).toHaveLength(0);
  });

  it("does not acknowledge an event it could not persist, so Slack retries it", async () => {
    const { post, queue } = await started();
    queue.failNext = true;
    const body = mention();
    const stamp = now();
    const response = await post(body, {
      "x-slack-request-timestamp": String(stamp),
      "x-slack-signature": sign(body, stamp),
    });
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(queue.persisted).toHaveLength(0);
  });

  it("ignores its own bot's message without enqueuing", async () => {
    const { post, queue } = await started();
    const body = JSON.stringify({
      api_app_id: "A1",
      authorizations: [{ is_bot: true, user_id: "B1" }],
      event: {
        bot_id: "Bx",
        channel: "D1",
        channel_type: "im",
        text: "answer",
        ts: "3.0",
        type: "message",
        user: "B1",
      },
      event_id: "Ev3",
      event_time: 1,
      team_id: "T1",
      type: "event_callback",
    });
    const stamp = now();
    const response = await post(body, {
      "x-slack-request-timestamp": String(stamp),
      "x-slack-signature": sign(body, stamp),
    });
    expect(response.status).toBe(200);
    expect(queue.persisted).toHaveLength(0);
  });
});
