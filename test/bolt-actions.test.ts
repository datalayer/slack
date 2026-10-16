import { App } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import { describe, expect, it } from "vitest";

import { APPROVE_ACTION } from "../src/approval-card.js";
import { registerSlackListeners } from "../src/bolt.js";
import { readConfig } from "../src/config.js";
import {
  HostKeyCredentials,
  HttpAgentClient,
  MemoryWorkQueue,
  type AgentClient,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import { sessionUidOf, slackShape } from "../src/agent-client.js";
import type { ThreadKey, TurnRequest } from "../src/domain.js";
import {
  ASK_CHOICE_ACTION,
  askChoiceValue,
  OPEN_ACTION,
  openValueOf,
  START_OVER,
  THREAD_MENU_ACTION,
  USE_ANOTHER,
} from "../src/presentation.js";
import type { DeliveryHandler } from "../src/deliveries.js";
import { EVENTS_ACTION } from "../src/home.js";
import { SELECT_APPLICATION_ACTION } from "../src/routing.js";
import { SlackAgentService } from "../src/service.js";
import type { MemorySlackStore } from "../src/store.js";
import type { SlackJob } from "../src/worker.js";
import {
  FakeAgents,
  FakeClock,
  FakeLinks,
  FakeSlack,
  installedStore,
  keptLogger,
  promptOf,
} from "./support/fakes.js";

/**
 * The Bolt handlers themselves (S-208, S-307): each block action as Slack
 * posts it, through `app.processEvent`, to the worker and the fake Slack.
 */
class KeptQueue extends MemoryWorkQueue<SlackJob> {
  readonly kept: SlackJob[] = [];
  override async enqueue(item: SlackJob, key?: string): Promise<boolean> {
    const taken = await super.enqueue(item, key);
    if (taken) this.kept.push(item);
    return taken;
  }
  override start(): void {}
}

/** The prompts the queue kept, each job's own. */
const promptsOf = (queue: KeptQueue) =>
  queue.kept.map((job) => ("prompt" in job ? job.prompt : job));

const allow = [
  { id: "dep-1", name: "Launch Review" },
  { id: "dep-2", name: "Desk" },
];

function boltOf(
  store: MemorySlackStore,
  deliveries?: DeliveryHandler,
  /** The agent client, when not the fake one: the shared HttpAgentClient (S-307). */
  client?: AgentClient<ThreadKey>,
) {
  const slack = new FakeSlack();
  const agents = new FakeAgents();
  const queue = new KeptQueue();
  const service = new SlackAgentService(
    store,
    client ?? agents,
    slack,
    "https://datalayer.ai",
    new FakeLinks(
      new Map([
        ["U1", "alice"],
        ["U2", "bob"],
      ]),
    ),
    { clock: new FakeClock(), logger: keptLogger().logger },
  );
  const app = new App({
    authorize: async () => ({ botToken: "xoxb-test", botUserId: "B1" }),
    signingSecret: "signing-secret",
  });
  // App Home is published to the fake, never to Slack.
  const published: Array<{ user_id?: string; view?: unknown }> = [];
  (app.client.views as unknown as { publish: unknown }).publish = async (args: {
    user_id?: string;
    view?: unknown;
  }) => {
    published.push(args);
    return { ok: true };
  };
  registerSlackListeners(
    app,
    readConfig({
      NODE_ENV: "test",
      DATALAYER_SLACK_SIGNING_SECRET: "signing-secret",
    }),
    service,
    queue,
    { consume: false, deliveries },
  );
  const press = async (body: Record<string, unknown>) => {
    let acked = false;
    await app.processEvent({
      ack: async () => {
        acked = true;
      },
      body: {
        api_app_id: "A1",
        team: { id: "T1" },
        type: "block_actions",
        ...body,
      },
    });
    expect(acked).toBe(true);
  };
  return { agents, press, published, queue, service, slack };
}

describe("Use another application through the Bolt handlers (S-208)", () => {
  it("carries the thread in the private selector and switches that thread from it", async () => {
    const store = await installedStore({ allow, defaultApplication: "dep-1" });
    const { agents, press, service, slack } = boltOf(store);
    await service.handlePrompt(promptOf(), "B1");
    const before = await store.getThread(promptOf());

    // The finished answer's menu, in the thread.
    await press({
      actions: [
        {
          action_id: THREAD_MENU_ACTION,
          action_ts: "9.1",
          selected_option: { value: USE_ANOTHER },
          type: "overflow",
        },
      ],
      channel: { id: "C1" },
      container: { channel_id: "C1", message_ts: "2.0", type: "message" },
      message: { thread_ts: "1.0", ts: "2.0" },
      user: { id: "U1", team_id: "T1" },
    });
    const selector = slack.of("private").at(-1)?.message as unknown as {
      blocks: KnownBlock[];
    };
    const option = JSON.stringify(selector.blocks).match(
      /\\"app\\":\\"dep-2\\"[^}]*}/,
    );
    expect(option?.[0]).toContain('\\"c\\":\\"C1\\"');
    expect(option?.[0]).toContain('\\"t\\":\\"1.0\\"');
    const select = (
      selector.blocks[1] as {
        elements: Array<{ options: Array<{ value: string }> }>;
      }
    ).elements[0]!.options.find((one) => one.value.includes("dep-2"))!;

    // Pressed in the ephemeral: Slack sends no message, only the container.
    const pressSelect = (user: string) =>
      press({
        actions: [
          {
            action_id: SELECT_APPLICATION_ACTION,
            action_ts: "9.2",
            selected_option: { value: select.value },
            type: "static_select",
          },
        ],
        channel: { id: "C1" },
        container: { channel_id: "C1", is_ephemeral: true, type: "message" },
        user: { id: user, team_id: "T1" },
      });
    await pressSelect("U2"); // Bob did not open the session.
    expect(slack.of("private").at(-1)?.message?.text).toContain(
      "not available to you",
    );
    expect(await store.getThread(promptOf())).toEqual(before);

    await pressSelect("U1");
    expect(await store.getThread(promptOf())).toBeUndefined();
    expect(await store.getArchivedThreads(promptOf())).toEqual([before]);

    // The next mention opens a new generation with the chosen application.
    await service.handlePrompt(promptOf({ eventId: "Ev2" }), "B1");
    expect(await store.getThread(promptOf())).toMatchObject({
      applicationId: "dep-2",
    });
    expect(agents.requests.at(-1)?.sessionId).not.toBe(before?.sessionId);
  });

  it("refuses a switch value pressed in another channel", async () => {
    const store = await installedStore({ allow, defaultApplication: "dep-1" });
    const { press, service, slack } = boltOf(store);
    await service.handlePrompt(promptOf(), "B1");
    const before = await store.getThread(promptOf());
    await press({
      actions: [
        {
          action_id: SELECT_APPLICATION_ACTION,
          action_ts: "9.3",
          selected_option: {
            value: JSON.stringify({
              app: "dep-2",
              c: "C1",
              ev: "",
              sw: true,
              t: "1.0",
            }),
          },
          type: "static_select",
        },
      ],
      channel: { id: "C9" },
      container: { channel_id: "C9", is_ephemeral: true, type: "message" },
      user: { id: "U1", team_id: "T1" },
    });
    expect(slack.of("private").at(-1)?.message?.text).toContain(
      "not available to you",
    );
    expect(await store.getThread(promptOf())).toEqual(before);
  });

  it("starts over from the thread menu", async () => {
    const store = await installedStore({ allow, defaultApplication: "dep-1" });
    const { press, service, slack } = boltOf(store);
    await service.handlePrompt(promptOf(), "B1");
    await press({
      actions: [
        {
          action_id: THREAD_MENU_ACTION,
          action_ts: "9.4",
          selected_option: { value: START_OVER },
          type: "overflow",
        },
      ],
      channel: { id: "C1" },
      message: { thread_ts: "1.0", ts: "2.0" },
      user: { id: "U1", team_id: "T1" },
    });
    expect(await store.getThread(promptOf())).toBeUndefined();
    expect(slack.of("chat.postMessage").at(-1)?.message?.text).toContain(
      "started over",
    );
    // The next mention opens a new generation: another session uid.
    const archived = await store.getArchivedThreads(promptOf());
    await service.handlePrompt(promptOf({ eventId: "Ev2" }), "B1");
    const next = await store.getThread(promptOf());
    expect(next?.sessionId).toBeDefined();
    expect(next?.sessionId).not.toBe(archived[0]?.sessionId);
  });

  it("offers no direct-only application in a channel's selector, and offers it in a DM", async () => {
    const store = await installedStore({
      allow: [
        ...allow,
        { directOnly: true, id: "dep-3", name: "Private Desk" },
      ],
      defaultApplication: "dep-1",
    });
    const { press, service, slack } = boltOf(store);
    for (const channelId of ["C1", "D1"]) {
      await service.handlePrompt(
        promptOf({ channelId, eventId: `Ev-${channelId}` }),
        "B1",
      );
      await press({
        actions: [
          {
            action_id: THREAD_MENU_ACTION,
            action_ts: `9.${channelId}`,
            selected_option: { value: USE_ANOTHER },
            type: "overflow",
          },
        ],
        channel: { id: channelId },
        message: { thread_ts: "1.0", ts: "2.0" },
        user: { id: "U1", team_id: "T1" },
      });
      const offered = JSON.stringify(slack.of("private").at(-1)?.message);
      expect(offered).toContain("Desk");
      if (channelId === "C1") expect(offered).not.toContain("dep-3");
      else expect(offered).toContain("dep-3");
    }
  });
});

describe("A choice answered once through the Bolt handlers (S-307)", () => {
  it("sends the first press only, replaces the buttons, and tells a later presser", async () => {
    const store = await installedStore({ allow, defaultApplication: "dep-1" });
    const { press, queue, slack } = boltOf(store);
    const buttons: KnownBlock[] = [
      { text: { text: "*Which one?*", type: "mrkdwn" }, type: "section" },
      {
        elements: ["Option A", "Option B"].map((option, index) => ({
          action_id: `${ASK_CHOICE_ACTION}_${index}`,
          text: { text: option, type: "plain_text" as const },
          type: "button" as const,
          value: askChoiceValue(option, "EvAsk"),
        })),
        type: "actions",
      },
    ];
    const click = (user: string, index: number, actionTs: string) =>
      press({
        actions: [
          {
            action_id: `${ASK_CHOICE_ACTION}_${index}`,
            action_ts: actionTs,
            type: "button",
            value: askChoiceValue(index ? "Option B" : "Option A", "EvAsk"),
          },
        ],
        channel: { id: "C1" },
        message: {
          blocks: buttons,
          text: "Which one?",
          thread_ts: "1.0",
          ts: "3.0",
        },
        user: { id: user, team_id: "T1" },
      });
    await click("U2", 1, "7.7");
    await click("U2", 1, "7.8"); // a second click: a new action_ts
    await click("U1", 0, "7.9"); // another option, another person
    expect(promptsOf(queue)).toEqual([
      expect.objectContaining({
        eventId: "ask:1.0:EvAsk",
        text: "Option B",
        userId: "U2",
      }),
    ]);
    const updated = slack.of("chat.update");
    expect(updated).toHaveLength(1);
    expect(JSON.stringify(updated[0]?.message?.blocks)).not.toContain(
      ASK_CHOICE_ACTION,
    );
    expect(JSON.stringify(updated[0]?.message?.blocks)).toContain(
      "<@U2> answered: Option B",
    );
    expect(slack.of("private").map((call) => call.message?.text)).toEqual([
      "This question was already answered.",
      "This question was already answered.",
    ]);
  });
});

describe("the approval confirmation modal (S-206)", () => {
  it("opens through the limiter's retry, so a 429 waits Slack's Retry-After", async () => {
    const store = await installedStore({ allow, defaultApplication: "dep-1" });
    const { press, service } = boltOf(store);
    const retried: string[] = [];
    // Recorded, not sent: the modal's call is the limiter's to pace.
    service.limiter.retry = async <T>(method: string): Promise<T> => {
      retried.push(method);
      return undefined as T;
    };
    await press({
      actions: [
        {
          action_id: APPROVE_ACTION,
          action_ts: "8.1",
          type: "button",
          value: JSON.stringify({ a: "ap-1", d: "a".repeat(64), p: "dep-1" }),
        },
      ],
      channel: { id: "D1" },
      message: { blocks: [], text: "Approve?", ts: "4.0" },
      trigger_id: "trigger-1",
      user: { id: "U1", team_id: "T1" },
    });
    expect(retried).toEqual(["views.open"]);
  });
});

describe("Open in Datalayer through the Bolt handlers (S-306)", () => {
  it("hands each press, its thread and who pressed to the per-press handoff", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    const opens: unknown[][] = [];
    const deliveries = {
      open: async (...args: unknown[]) => {
        opens.push(args);
        return "opened";
      },
    } as unknown as DeliveryHandler;
    const { press } = boltOf(store, deliveries);
    const pressOpen = (user: string) =>
      press({
        actions: [
          {
            action_id: OPEN_ACTION,
            action_ts: "9.3",
            type: "button",
            value: openValueOf("S-0", "U1"),
          },
        ],
        channel: { id: "C1" },
        container: { channel_id: "C1", message_ts: "2.0", type: "message" },
        message: { thread_ts: "1.0", ts: "2.0" },
        user: { id: user, team_id: "T1" },
      });
    await pressOpen("U1");
    await pressOpen("U2");
    expect(opens).toEqual([
      [
        expect.objectContaining({ channelId: "C1", threadTs: "1.0" }),
        { s: "S-0", u: "U1" },
        "U1",
      ],
      [
        expect.objectContaining({ channelId: "C1", threadTs: "1.0" }),
        { s: "S-0", u: "U1" },
        "U2",
      ],
    ]);
  });
});

describe("A question asked in the AG-UI stream, answered in Slack, end to end (S-307)", () => {
  const API = "https://prod1.datalayer.run";
  const SESSIONS = `${API}/rt-1/api/v1/apps/sessions`;
  const exchanged = {
    success: true,
    access_token: "host-token",
    token_type: "Bearer",
    expires_in: 900,
    exp: 4102444800,
    principal_uid: "alice",
    host_uid: "inst-1",
    deployment: {
      uid: "dep-1",
      app_uid: "app-1",
      app_name: "Desk",
      version: 1,
    },
    session_api: { url: SESSIONS, agent: "agent-desk" },
  };
  const sse = (...events: unknown[]) =>
    new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  /** The runtime's stream of a turn that ends asking `asking`. */
  const asked = (asking: Record<string, unknown>) =>
    sse(
      {
        type: "CUSTOM",
        name: "loop.turn",
        value: { turn: "t1", replayed: false, state: "running" },
      },
      { type: "TEXT_MESSAGE_CONTENT", delta: "Before I compare them: " },
      { type: "CUSTOM", name: "loop.ask", value: asking },
      { type: "RUN_FINISHED", result: { asking } },
    );

  /** The shared client over a fake fetch: the exchange, the runtime and the thread's binding. */
  function wired(first: Response) {
    const calls: Array<{ body?: Record<string, unknown>; key: string }> = [];
    const answers: Record<string, () => Response> = {
      [`POST ${API}/api/ai-agents/v1/apps/hosts/self/token`]: () =>
        Response.json(exchanged),
      [`POST ${SESSIONS}`]: () => first,
    };
    const fetchImplementation = (async (
      input: string | URL,
      init?: RequestInit,
    ) => {
      const key = `${init?.method ?? "GET"} ${String(input)}`;
      calls.push({
        body: init?.body
          ? (JSON.parse(init.body as string) as Record<string, unknown>)
          : undefined,
        key,
      });
      if (key.startsWith(`PUT ${API}/api/ai-agents/v1/apps/hosts/sessions/`))
        return Response.json({ success: true });
      const answer = answers[key];
      if (!answer) throw new Error(`unexpected ${key}`);
      return answer();
    }) as typeof fetch;
    const hostKey = async () => "dlhk_key";
    const agents = new HttpAgentClient<ThreadKey>(
      API,
      new HostKeyCredentials(API, hostKey, slackShape, fetchImplementation),
      slackShape,
      fetchImplementation,
      hostKey,
    );
    return { agents, answers, calls };
  }

  it("shows a choice as buttons, sends the press as the next turn, and replaces the buttons", async () => {
    const store = await installedStore({ allow, defaultApplication: "dep-1" });
    const question = {
      kind: "choice",
      prompt: "Which quarter?",
      options: ["Q3", "Q4"],
    };
    const { agents, answers, calls } = wired(asked(question));
    const { press, queue, service, slack } = boltOf(store, undefined, agents);

    await service.handlePrompt(promptOf(), "B1");
    const shown = slack.of("chat.update").at(-1)?.message;
    const blocks = (shown?.blocks ?? []) as KnownBlock[];
    const buttons = JSON.stringify(blocks);
    expect(buttons).toContain("Which quarter?");
    expect(buttons).toContain(`${ASK_CHOICE_ACTION}_0`);
    expect(buttons).toContain(`${ASK_CHOICE_ACTION}_1`);
    expect(buttons).toContain(JSON.stringify(askChoiceValue("Q4", "Ev1")));
    const questionTs = slack.of("chat.postMessage")[0]?.ts;
    expect(questionTs).toBeDefined();

    // The runtime answers the next message of the same session.
    const session = sessionUidOf({
      provenance: promptOf(),
    } as unknown as TurnRequest);
    answers[`POST ${SESSIONS}/${session}/messages`] = () =>
      sse(
        {
          type: "CUSTOM",
          name: "loop.turn",
          value: { turn: "t2", replayed: false, state: "running" },
        },
        { type: "TEXT_MESSAGE_CONTENT", delta: "Q4 is the safer quarter." },
        { type: "RUN_FINISHED" },
      );

    await press({
      actions: [
        {
          action_id: `${ASK_CHOICE_ACTION}_1`,
          action_ts: "8.1",
          type: "button",
          value: askChoiceValue("Q4", "Ev1"),
        },
      ],
      channel: { id: "C1" },
      message: { blocks, text: shown?.text, thread_ts: "1.0", ts: questionTs },
      user: { id: "U1", team_id: "T1" },
    });
    // The buttons are replaced by who answered what.
    const replaced = slack
      .of("chat.update")
      .filter((call) => call.ts === questionTs)
      .at(-1);
    expect(JSON.stringify(replaced?.message?.blocks)).not.toContain(
      ASK_CHOICE_ACTION,
    );
    expect(JSON.stringify(replaced?.message?.blocks)).toContain(
      "<@U1> answered: Q4",
    );

    // The press is one new turn: its answer, sent to the same session.
    const jobs = promptsOf(queue);
    expect(jobs).toEqual([
      expect.objectContaining({
        eventId: "ask:1.0:Ev1",
        text: "Q4",
        userId: "U1",
      }),
    ]);
    const posted = slack.of("chat.postMessage").length;
    await service.handlePrompt(
      jobs[0] as Parameters<typeof service.handlePrompt>[0],
      "B1",
    );
    const sent = calls.find(
      (call) => call.key === `POST ${SESSIONS}/${session}/messages`,
    );
    expect(sent?.body).toMatchObject({
      external_event_id: "ask:1.0:Ev1",
      text: "Q4",
    });
    expect(slack.of("chat.postMessage")).toHaveLength(posted + 1);
    expect(slack.of("chat.update").at(-1)?.message?.text).toBe(
      "Q4 is the safer quarter.",
    );
  });

  it("asks a text question in the thread, and hands a form or a file to Open in Datalayer", async () => {
    for (const [question, expected] of [
      [
        { kind: "text", prompt: "What budget?" },
        "Answer in this thread by mentioning @Datalayer with your answer.",
      ],
      [
        { kind: "form", prompt: "Your details" },
        "press *Open in Datalayer* to answer it.",
      ],
      [
        { kind: "file", prompt: "Upload the ledger" },
        "press *Open in Datalayer* to answer it.",
      ],
    ] as const) {
      const store = await installedStore({
        allow,
        defaultApplication: "dep-1",
      });
      const { agents } = wired(asked(question));
      const { service, slack } = boltOf(store, undefined, agents);
      await service.handlePrompt(promptOf(), "B1");
      const blocks = JSON.stringify(
        slack.of("chat.update").at(-1)?.message?.blocks,
      );
      expect(blocks).toContain(question.prompt);
      expect(blocks).toContain(expected);
      expect(blocks).not.toContain(ASK_CHOICE_ACTION);
      if (question.kind !== "text") expect(blocks).toContain(OPEN_ACTION);
    }
  });
});

describe("Quiet or noisy, chosen on the Home through the Bolt handlers (S-308)", () => {
  it("keeps the person's choice for their installation only", async () => {
    const store = await installedStore({ allow, defaultApplication: "dep-1" });
    const { press, published } = boltOf(store);
    const choose = (value: string, user = "U1") =>
      press({
        actions: [
          {
            action_id: EVENTS_ACTION,
            action_ts: "9.4",
            selected_option: {
              text: { text: value, type: "plain_text" },
              value,
            },
            type: "radio_buttons",
          },
        ],
        container: { type: "view", view_id: "V1" },
        user: { id: user, team_id: "T1" },
        view: { id: "V1", type: "home" },
      });
    await choose("noisy");
    await expect(store.getEventPolicy(promptOf(), "U1")).resolves.toBe("noisy");
    // Their Home shown again, the choice selected.
    expect(published.at(-1)?.user_id).toBe("U1");
    expect(JSON.stringify(published.at(-1)?.view)).toContain(
      '"initial_option":{"text":{"type":"plain_text","text":"Noisy: every tool it used, listed"},"value":"noisy"}',
    );
    await expect(
      store.getEventPolicy(promptOf(), "U2"),
    ).resolves.toBeUndefined();
    await choose("loud"); // not an option: nothing kept
    await expect(store.getEventPolicy(promptOf(), "U1")).resolves.toBe("noisy");
    await choose("quiet");
    await expect(store.getEventPolicy(promptOf(), "U1")).resolves.toBe("quiet");
  });
});
