import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import { HostKeyCredentials } from "../src/agent-client.js";
import { APPROVE_ACTION } from "../src/approval-card.js";
import {
  DeliveryHandler,
  DeliveryPoller,
  deliveryRoute,
  type DeliveryJob,
} from "../src/deliveries.js";
import type { SlackInstallation, ThreadKey } from "../src/domain.js";
import { DatalayerHostClient } from "../src/host-client.js";
import type { HostDelivery } from "../src/host-contracts.js";
import type { SlackMessage, SlackPort } from "../src/slack-port.js";
import { MemorySlackStore } from "../src/store.js";

const contracts = JSON.parse(
  readFileSync(new URL("./contracts/contracts.json", import.meta.url), "utf8"),
) as {
  decision: { request: Record<string, unknown> };
  delivery: {
    signing: {
      body: string;
      secret: string;
      signature: string;
      timestamp: number;
    };
  };
  headers: Record<string, string>;
  presentation: { example: Record<string, unknown> };
  routes: Record<string, string>;
};

const API = "https://prod1.datalayer.run";
const WEB = "https://datalayer.ai";
const KEY = "dlhk_the-installation-key";
const SECRET = contracts.delivery.signing.secret;

const route = (name: string, values: Record<string, string> = {}) => {
  const [method, template] = contracts.routes[name]!.split(" ") as [
    string,
    string,
  ];
  let path = template;
  for (const [key, value] of Object.entries(values))
    path = path.replace(`{${key}}`, value);
  return `${method} ${API}${path.split("?")[0]}`;
};

const installation: SlackInstallation = {
  appId: "A1",
  botToken: "xoxb",
  botUserId: "B1",
  datalayerHostKey: KEY,
  datalayerHostUid: "inst-1",
  deliverySecret: SECRET,
  installedBy: "U0",
  scopes: [],
  status: "active",
  teamId: "T1",
  updatedAt: new Date(0).toISOString(),
};

const target = (channelId: string, userId = "U0ALICE") => ({
  appId: "A1",
  channelId,
  teamId: "T1",
  threadTs: "1700000000.000001",
  userId,
});

const exchanged = {
  success: true,
  access_token: "host-token",
  token_type: "Bearer",
  expires_in: 900,
  exp: 4102444800,
  principal_uid: "alice",
  host_uid: "inst-1",
  deployment: { uid: "dep-1", app_uid: "app-1", app_name: "Desk", version: 5 },
  session_api: { url: `${API}/rt-1/api/v1/apps/sessions`, agent: "agent-desk" },
};

const presentation = {
  ...contracts.presentation.example,
  digest: "a".repeat(64),
};

class FakeSlack implements SlackPort {
  direct: Array<{ message: SlackMessage; userId: string }> = [];
  thread: Array<{ key: ThreadKey; message: SlackMessage }> = [];
  updates: Array<{ channelId: string; message: SlackMessage; ts: string }> = [];
  #ts = 10;

  async postDirect(_key: unknown, userId: string, message: SlackMessage) {
    this.direct.push({ message, userId });
    return { channelId: "D0ALICE", ts: `${(this.#ts += 1)}.0` };
  }
  async postPrivate(key: ThreadKey, userId: string, message: SlackMessage) {
    await this.postDirect(key, userId, message);
  }
  async postThread(key: ThreadKey, message: SlackMessage) {
    this.thread.push({ key, message });
    return `${(this.#ts += 1)}.0`;
  }
  async updateMessage(key: ThreadKey, ts: string, message: SlackMessage) {
    this.updates.push({ channelId: key.channelId, message, ts });
  }
}

type Call = {
  body?: Record<string, unknown>;
  headers: Record<string, string>;
  key: string;
};

function wire(answers: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fetchImplementation = (async (
    input: string | URL,
    init?: RequestInit,
  ) => {
    const key = `${init?.method ?? "GET"} ${String(input).split("?")[0]}`;
    calls.push({
      body: init?.body
        ? (JSON.parse(init.body as string) as Record<string, unknown>)
        : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
      key,
    });
    const answer = answers[key];
    if (!answer) throw new Error(`unexpected ${key}`);
    return answer();
  }) as typeof fetch;
  return { calls, fetchImplementation };
}

async function setup(answers: Record<string, () => Response>) {
  const store = new MemorySlackStore();
  await store.putInstallation(installation);
  const slack = new FakeSlack();
  const { calls, fetchImplementation } = wire({
    [route("exchange")]: () => Response.json(exchanged),
    [route("ack", { delivery_uid: "d1" })]: () =>
      Response.json({ success: true }),
    ...answers,
  });
  const client = new DatalayerHostClient(API, fetchImplementation);
  const handler = new DeliveryHandler(
    store,
    client,
    new HostKeyCredentials(API, async () => KEY, fetchImplementation),
    slack,
    WEB,
    fetchImplementation,
  );
  return { calls, client, handler, slack, store };
}

const requested = (channelId: string): DeliveryJob => ({
  delivery: {
    delivery: "d1",
    event: "approval.requested",
    payload: {
      approval_id: "ap-1",
      deployment_uid: "dep-1",
      presentation: "/api/ai-agents/v1/tool-approvals/ap-1/presentation",
      session_uid: "S1",
      target: target(channelId),
      tool_name: "send_email",
    },
  },
  hostUid: "inst-1",
});

const presented = () => Response.json({ success: true, presentation });

describe("The delivery webhook", () => {
  function request(
    body: string,
    headers: Record<string, string>,
    hostUid = "inst-1",
  ) {
    return Object.assign(Readable.from([Buffer.from(body)]), {
      headers: Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
      ),
      params: { hostUid },
    }) as unknown as IncomingMessage & { params: Record<string, string> };
  }
  function response() {
    const sent = { body: "", status: 0 };
    const res = {
      end: (body: string) => {
        sent.body = body;
      },
      writeHead: (status: number) => {
        sent.status = status;
      },
    } as unknown as ServerResponse;
    return { res, sent };
  }

  it("queues a push signed with the installation's secret, and answers at once", async () => {
    const store = new MemorySlackStore();
    await store.putInstallation(installation);
    const queued: DeliveryJob[] = [];
    const { body, signature, timestamp } = contracts.delivery.signing;
    const handle = deliveryRoute(
      store,
      async (job) => void queued.push(job),
      () => timestamp + 5,
    );
    const { res, sent } = response();
    await handle(
      request(body, {
        [contracts.headers.signature!]: signature,
        [contracts.headers.timestamp!]: String(timestamp),
        [contracts.headers.delivery!]: "d0c1",
      }),
      res,
    );
    expect(sent.status).toBe(200);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.hostUid).toBe("inst-1");
    expect(queued[0]?.delivery.event).toBe("approval.requested");
  });

  it("refuses a tampered, replayed or unknown installation's push and queues nothing", async () => {
    const store = new MemorySlackStore();
    await store.putInstallation(installation);
    const queued: DeliveryJob[] = [];
    const { body, signature, timestamp } = contracts.delivery.signing;
    const headers = {
      [contracts.headers.signature!]: signature,
      [contracts.headers.timestamp!]: String(timestamp),
    };
    const at = (now: number) =>
      deliveryRoute(
        store,
        async (job) => void queued.push(job),
        () => now,
      );
    const tampered = response();
    await at(timestamp)(
      request(body.replace("ap-1", "ap-2"), headers),
      tampered.res,
    );
    expect(tampered.sent.status).toBe(401);
    const replayed = response();
    await at(timestamp + 3600)(request(body, headers), replayed.res);
    expect(replayed.sent.status).toBe(401);
    const unknown = response();
    await at(timestamp)(request(body, headers, "inst-unknown"), unknown.res);
    expect(unknown.sent.status).toBe(404);
    expect(queued).toHaveLength(0);
  });
});

describe("The outbox poller", () => {
  it("queues what each bound installation has not acknowledged", async () => {
    const store = new MemorySlackStore();
    await store.putInstallation(installation);
    await store.putInstallation({
      ...installation,
      datalayerHostKey: undefined,
      teamId: "T2",
      datalayerHostUid: undefined,
    });
    const { calls, fetchImplementation } = wire({
      [route("outbox")]: () =>
        Response.json({
          success: true,
          deliveries: [
            {
              uid: "d1",
              event: "turn.completed",
              payload: {
                record_entry: "e1",
                session_uid: "S1",
                deployment_uid: "dep-1",
                target: target("D1"),
              },
              state: "pending",
            },
          ],
        }),
    });
    const queued: DeliveryJob[] = [];
    const poller = new DeliveryPoller(
      store,
      new DatalayerHostClient(API, fetchImplementation),
      async (job) => void queued.push(job),
    );
    expect(await poller.pollOnce()).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers[contracts.headers.host_key!]).toBe(KEY);
    expect(queued[0]).toMatchObject({
      hostUid: "inst-1",
      delivery: { delivery: "d1", event: "turn.completed" },
    });
  });
});

describe("approval.requested", () => {
  it("shows the card in a direct message's thread, read as the person it waits on, once", async () => {
    const { calls, handler, slack, store } = await setup({
      [route("presentation", { approval_id: "ap-1" })]: presented,
    });
    await handler.receive(requested("D0ALICE"));
    await handler.receive(requested("D0ALICE"));

    expect(slack.thread).toHaveLength(1);
    expect(slack.direct).toHaveLength(0);
    expect(slack.thread[0]?.key.threadTs).toBe("1700000000.000001");
    expect(JSON.stringify(slack.thread[0]?.message.blocks)).toContain(
      APPROVE_ACTION,
    );
    expect(JSON.stringify(slack.thread[0]?.message.blocks)).toContain(
      "We go with option B.",
    );
    const exchange = calls.find((call) => call.key === route("exchange"));
    expect(exchange?.body).toEqual({
      deployment_uid: "dep-1",
      external_user_id: "U0ALICE",
    });
    const read = calls.find(
      (call) => call.key === route("presentation", { approval_id: "ap-1" }),
    );
    expect(read?.headers.authorization).toBe("Bearer host-token");
    // Acknowledged each time; shown once.
    expect(
      calls.filter((call) => call.key === route("ack", { delivery_uid: "d1" })),
    ).toHaveLength(2);
    await expect(
      store.getApprovalCards(installation, "ap-1"),
    ).resolves.toHaveLength(1);
  });

  it("sends a channel session's card privately and leaves only a waiting line in the thread", async () => {
    const { handler, slack, store } = await setup({
      [route("presentation", { approval_id: "ap-1" })]: presented,
    });
    await handler.receive(requested("C0LAUNCH"));
    expect(slack.direct).toHaveLength(1);
    expect(slack.direct[0]?.userId).toBe("U0ALICE");
    expect(JSON.stringify(slack.direct[0]?.message.blocks)).toContain(
      "release@example.com",
    );
    expect(slack.thread).toHaveLength(1);
    expect(slack.thread[0]?.message.text).toContain(
      "Waiting for <@U0ALICE>'s decision",
    );
    expect(JSON.stringify(slack.thread[0]?.message)).not.toContain(
      "release@example.com",
    );
    const cards = await store.getApprovalCards(installation, "ap-1");
    expect(cards.map((card) => card.kind)).toEqual(["card", "waiting"]);
  });

  it("ignores a target that is not this workspace's", async () => {
    const { calls, handler, slack } = await setup({});
    const job = requested("D0ALICE");
    await handler.receive({
      ...job,
      delivery: {
        ...job.delivery,
        payload: {
          ...job.delivery.payload,
          target: { ...target("D0ALICE"), teamId: "T9" },
        },
      } as HostDelivery,
    });
    expect(slack.thread).toHaveLength(0);
    expect(calls.map((call) => call.key)).toEqual([
      route("ack", { delivery_uid: "d1" }),
    ]);
  });

  it("drops a delivery for an installation uninstalled meanwhile", async () => {
    const { calls, handler, slack, store } = await setup({});
    await store.deleteInstallation(installation);
    await handler.receive(requested("D0ALICE"));
    expect(calls).toHaveLength(0);
    expect(slack.thread).toHaveLength(0);
  });
});

describe("Deciding from Slack", () => {
  const metadata = {
    a: "ap-1",
    app: "A1",
    approve: true,
    d: "a".repeat(64),
    p: "dep-1",
    team: "T1",
  };

  it("decides with the digest shown, as the person who pressed, and updates every card", async () => {
    const { calls, handler, slack } = await setup({
      [route("presentation", { approval_id: "ap-1" })]: presented,
      [route("decision", { approval_id: "ap-1" })]: () =>
        Response.json({
          success: true,
          approval: { id: "ap-1", status: "approved" },
        }),
    });
    await handler.receive(requested("C0LAUNCH"));
    expect(await handler.decide({ metadata, slackUserId: "U0ALICE" })).toBe(
      "decided",
    );
    const decision = calls.find(
      (call) => call.key === route("decision", { approval_id: "ap-1" }),
    );
    expect(decision?.headers.authorization).toBe("Bearer host-token");
    expect(decision?.body).toEqual({
      approve: true,
      digest: "a".repeat(64),
      note: null,
    });
    expect(Object.keys(decision!.body!).sort()).toEqual(
      Object.keys(contracts.decision.request).sort(),
    );
    expect(slack.updates.map((update) => update.channelId).sort()).toEqual([
      "C0LAUNCH",
      "D0ALICE",
    ]);
    for (const update of slack.updates) {
      expect(update.message.text).toBe("Approved by <@U0ALICE>: send_email");
      expect(JSON.stringify(update.message.blocks)).not.toContain(
        APPROVE_ACTION,
      );
    }
  });

  it("decides nothing when the approval changed since the card was shown", async () => {
    const { calls, handler } = await setup({
      [route("presentation", { approval_id: "ap-1" })]: presented,
    });
    await handler.receive(requested("D0ALICE"));
    expect(
      await handler.decide({
        metadata: { ...metadata, d: "b".repeat(64) },
        slackUserId: "U0ALICE",
      }),
    ).toBe("changed");
    expect(
      calls.some(
        (call) => call.key === route("decision", { approval_id: "ap-1" }),
      ),
    ).toBe(false);
  });

  it("says it is not theirs when Datalayer does not show it to the person who pressed", async () => {
    let first = true;
    const { handler } = await setup({
      [route("presentation", { approval_id: "ap-1" })]: () => {
        if (first) {
          first = false;
          return presented();
        }
        return Response.json(
          { detail: "Tool approval not found" },
          { status: 404 },
        );
      },
    });
    await handler.receive(requested("D0ALICE"));
    expect(await handler.decide({ metadata, slackUserId: "U0MALLORY" })).toBe(
      "not-yours",
    );
  });

  it("refuses metadata naming another workspace", async () => {
    const { handler } = await setup({});
    expect(
      await handler.decide({
        metadata: { ...metadata, team: "T9" },
        slackUserId: "U0ALICE",
      }),
    ).toBe("not-here");
  });
});

describe("approval.decided and turn.completed", () => {
  it("updates the cards when it is decided in Datalayer", async () => {
    const { handler, slack } = await setup({
      [route("presentation", { approval_id: "ap-1" })]: presented,
      [route("ack", { delivery_uid: "d2" })]: () =>
        Response.json({ success: true }),
    });
    await handler.receive(requested("D0ALICE"));
    await handler.receive({
      delivery: {
        delivery: "d2",
        event: "approval.decided",
        payload: {
          approval_id: "ap-1",
          status: "rejected",
          decided_by: "alice",
          session_uid: "S1",
          deployment_uid: "dep-1",
          target: target("D0ALICE"),
        },
      },
      hostUid: "inst-1",
    });
    expect(slack.updates).toHaveLength(1);
    expect(slack.updates[0]?.message.text).toBe(
      "Declined in Datalayer: send_email",
    );
  });

  it("finishes the thread's status with the session's answer", async () => {
    const { handler, slack, store } = await setup({
      [`GET ${exchanged.session_api.url}/S1/messages`]: () =>
        Response.json({ messages: [{ role: "assistant", content: "Sent." }] }),
      [route("ack", { delivery_uid: "d3" })]: () =>
        Response.json({ success: true }),
    });
    const thread = {
      appId: "A1",
      channelId: "D0ALICE",
      teamId: "T1",
      threadTs: "1700000000.000001",
    };
    await store.putThread({
      ...thread,
      applicationId: "dep-1",
      openedByPrincipalId: "alice",
      pendingMessageTs: "5.0",
      sessionId: "S1",
      updatedAt: new Date(0).toISOString(),
    });
    const completed: DeliveryJob = {
      delivery: {
        delivery: "d3",
        event: "turn.completed",
        payload: {
          record_entry: "e1",
          session_uid: "S1",
          deployment_uid: "dep-1",
          target: target("D0ALICE"),
        },
      },
      hostUid: "inst-1",
    };
    await handler.receive(completed);
    expect(slack.updates).toEqual([
      expect.objectContaining({ channelId: "D0ALICE", ts: "5.0" }),
    ]);
    expect(slack.updates[0]?.message.text).toContain("Sent.");
    await expect(store.getThread(thread)).resolves.toMatchObject({
      pendingMessageTs: undefined,
    });
  });
});
