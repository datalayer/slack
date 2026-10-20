import { App } from "@slack/bolt";
import { describe, expect, it } from "vitest";

import {
  MemoryWorkQueue,
  type SemanticEvent,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import { registerSlackListeners } from "../src/bolt.js";
import { readConfig } from "../src/config.js";
import { STOP_ACTION, TurnPresentation } from "../src/presentation.js";
import {
  busyNotice,
  SlackAgentService,
  type StopValue,
} from "../src/service.js";
import type { MemorySlackStore } from "../src/store.js";
import type { SlackJob } from "../src/worker.js";
import {
  FakeAgents,
  FakeClock,
  FakeLinks,
  FakeSlack,
  installedStore,
  keptLogger,
  platformError,
  promptOf,
} from "./support/fakes.js";

/**
 * Stop, said and reachable (S-205, S-206): a stopped session's stream just
 * ends, so the Stop leaves its mark on the turn and the answer says who
 * stopped it; and while an answer streams (Slack's stream carries no button)
 * the busy notice carries the Stop, naming its thread.
 */

/** A turn that runs until Datalayer is asked to stop it, then its stream just ends. */
function stoppable() {
  let ended!: () => void;
  const stopped = new Promise<void>((resolve) => {
    ended = resolve;
  });
  async function* updates(): AsyncIterable<SemanticEvent> {
    yield { kind: "text", text: "Working on the report" };
    await stopped;
  }
  const agents = new FakeAgents((request) => ({
    run: { id: "run-7" },
    sessionId: request.sessionId ?? "S1",
    updates: updates(),
  }));
  const stopTurn = agents.stopTurn.bind(agents);
  agents.stopTurn = async (sessionId, request) => {
    await stopTurn(sessionId, request);
    ended();
  };
  return agents;
}

function serviceOf(
  store: MemorySlackStore,
  agents: FakeAgents,
  slack: FakeSlack,
) {
  return new SlackAgentService(
    store,
    agents,
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
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const allText = (value: unknown) => JSON.stringify(value ?? null);

describe("the host says stop after its own Stop (S-205)", () => {
  for (const streaming of [false, true])
    it(`names who stopped the answer when its stream just ends (${streaming ? "streamed" : "placeholder"})`, async () => {
      const store = await installedStore({ defaultApplication: "dep-1" });
      const slack = new FakeSlack({ streaming });
      const agents = stoppable();
      const service = serviceOf(store, agents, slack);
      const turn = service.handlePrompt(promptOf(), "B1");
      await tick();
      const value: StopValue = { e: "Ev1", r: "run-7", s: "S1" };
      await expect(service.stop(promptOf(), value, "U2")).resolves.toBe(
        "stopped",
      );
      await turn;
      const final = streaming
        ? slack.of("chat.stopStream").at(-1)?.message
        : slack.of("chat.update").at(-1)?.message;
      expect(allText(final?.blocks)).toContain("Stopped by <@U2>");
      // Ended: no Stop left on it, and no `turn.completed` waited for.
      expect(allText(final?.blocks)).not.toContain(STOP_ACTION);
      expect(
        (await store.getThread(promptOf()))?.pendingMessageTs,
      ).toBeUndefined();
    });

  it("says nothing of a Stop when the stream ended on its own", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    const slack = new FakeSlack();
    const service = serviceOf(store, new FakeAgents(), slack);
    await service.handlePrompt(promptOf(), "B1");
    expect(allText(slack.of("chat.update").at(-1)?.message)).not.toContain(
      "Stopped",
    );
  });

  it("unmarks the turn when Datalayer refuses the stop", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    const slack = new FakeSlack();
    const agents = stoppable();
    agents.stopTurn = async () => {
      throw new Error("Datalayer is unreachable");
    };
    const service = serviceOf(store, agents, slack);
    void service.handlePrompt(promptOf(), "B1");
    await tick();
    await expect(
      service.stop(promptOf(), { e: "Ev1", s: "S1" }, "U1"),
    ).rejects.toThrow("unreachable");
    expect((await store.getTurn(promptOf()))?.stoppedBy).toBeUndefined();
  });

  it("never writes a mention that is not a Slack member id", () => {
    const presentation = new TurnPresentation();
    presentation.apply({ kind: "stop" });
    const forged = presentation.message("", { stoppedBy: "here> <!channel" });
    expect(allText(forged.blocks)).not.toContain("<!channel");
    expect(allText(forged.blocks)).toContain("_Stopped_");
  });
});

class KeptQueue extends MemoryWorkQueue<SlackJob> {
  override start(): void {}
}

describe("Stop while an answer streams: the busy notice (S-206)", () => {
  it("carries Stop only while the running answer has a session", () => {
    const thread = promptOf();
    expect(busyNotice(thread, { eventId: "Ev1" }).blocks).toBeUndefined();
    const notice = busyNotice(thread, {
      eventId: "Ev1",
      runId: "run-7",
      sessionId: "S1",
    });
    expect(notice.text).toContain("stop it here");
    const button = allText(notice.blocks);
    expect(button).toContain(STOP_ACTION);
    for (const part of [
      '\\"c\\":\\"C1\\"',
      '\\"t\\":\\"1.0\\"',
      '\\"s\\":\\"S1\\"',
    ])
      expect(button).toContain(part);
  });

  it("stops a streamed answer from the notice's Stop, pressed in its ephemeral, in that channel only", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    const slack = new FakeSlack({ streaming: true });
    const agents = stoppable();
    const service = serviceOf(store, agents, slack);
    const app = new App({
      authorize: async () => ({ botToken: "xoxb-test", botUserId: "B1" }),
      signingSecret: "signing-secret",
    });
    registerSlackListeners(
      app,
      readConfig({
        NODE_ENV: "test",
        DATALAYER_SLACK_SIGNING_SECRET: "signing-secret",
      }),
      service,
      new KeptQueue(),
      { consume: false },
    );
    const first = service.handlePrompt(promptOf(), "B1");
    await tick();
    // The streamed answer has no Stop: Bob asks again and gets the notice.
    await service.handlePrompt(
      promptOf({ eventId: "Ev2", text: "<@B1> stop that", userId: "U2" }),
      "B1",
    );
    const notice = slack.of("private").at(-1);
    expect(notice?.userId).toBe("U2");
    const value = (
      JSON.parse(allText(notice?.message?.blocks)) as Array<{
        elements?: Array<{ value?: string }>;
      }>
    )[1]?.elements?.[0]?.value;
    expect(value).toBeDefined();

    const press = (channel: string) =>
      app.processEvent({
        ack: async () => undefined,
        body: {
          actions: [
            {
              action_id: STOP_ACTION,
              action_ts: "9.1",
              type: "button",
              value,
            },
          ],
          api_app_id: "A1",
          channel: { id: channel },
          // An ephemeral: Slack sends no message, only the container.
          container: {
            channel_id: channel,
            is_ephemeral: true,
            type: "message",
          },
          team: { id: "T1" },
          type: "block_actions",
          user: { id: "U2", team_id: "T1" },
        },
      });
    await press("C2"); // Pressed elsewhere: nothing is stopped.
    expect(agents.stops).toHaveLength(0);
    await press("C1");
    expect(agents.stops).toHaveLength(1);
    expect(agents.stops[0]).toMatchObject({
      request: { principalId: "bob" },
      sessionId: "S1",
    });
    await first;
    expect(allText(slack.of("chat.stopStream").at(-1)?.message)).toContain(
      "Stopped by <@U2>",
    );
  });
});

/** The app of these tests, its listeners registered on `service`. */
function appOf(service: SlackAgentService): App {
  const app = new App({
    authorize: async () => ({ botToken: "xoxb-test", botUserId: "B1" }),
    signingSecret: "signing-secret",
  });
  registerSlackListeners(
    app,
    readConfig({
      NODE_ENV: "test",
      DATALAYER_SLACK_SIGNING_SECRET: "signing-secret",
    }),
    service,
    new KeptQueue(),
    { consume: false },
  );
  return app;
}

/** Slack's own Stop pressed in a thread (`agent_session_stopped`). */
const slackStop = (app: App, user: string, threadTs = "1.0") =>
  app.processEvent({
    ack: async () => undefined,
    body: {
      api_app_id: "A1",
      authorizations: [{ is_bot: true, user_id: "B1" }],
      event: {
        channel: "C1",
        event_ts: "9.2",
        streaming_message_ts: ["2.0"],
        thread_ts: threadTs,
        type: "agent_session_stopped",
        user,
      },
      event_id: `EvStop-${user}`,
      event_time: 1,
      team_id: "T1",
      type: "event_callback",
    },
  });

describe("Slack's own Stop on a streamed answer (S-206, agent_session_stopped)", () => {
  it("stops the thread's running turn as the person who pressed it, and says who", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    const slack = new FakeSlack({ streaming: true });
    const agents = stoppable();
    const service = serviceOf(store, agents, slack);
    const app = appOf(service);
    const turn = service.handlePrompt(promptOf(), "B1");
    await tick();
    await slackStop(app, "U2");
    expect(agents.stops).toHaveLength(1);
    expect(agents.stops[0]).toMatchObject({
      request: { principalId: "bob" },
      sessionId: "S1",
    });
    await turn;
    expect(allText(slack.of("chat.stopStream").at(-1)?.message)).toContain(
      "Stopped by <@U2>",
    );
  });

  it("stops nothing in another thread, and says nothing once the answer is done", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    const slack = new FakeSlack({ streaming: true });
    const service = serviceOf(store, new FakeAgents(), slack);
    const app = appOf(service);
    await service.handlePrompt(promptOf(), "B1");
    await slackStop(app, "U1");
    await slackStop(app, "U1", "7.0");
    expect(slack.of("private")).toHaveLength(0);
  });

  it("asks a person who is not connected to connect, and stops nothing", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    const slack = new FakeSlack({ streaming: true });
    const agents = stoppable();
    const service = serviceOf(store, agents, slack);
    const app = appOf(service);
    void service.handlePrompt(promptOf(), "B1");
    await tick();
    await slackStop(app, "U9");
    expect(agents.stops).toHaveLength(0);
    expect(allText(slack.of("private").at(-1)?.message)).toContain(
      "Connect your Datalayer account to stop an answer",
    );
  });

  it("writes the whole answer once Slack has ended its stream", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    const slack = new FakeSlack({ streaming: true });
    // Slack ended the stream on its own Stop: appending to it is refused.
    slack.fail(
      "chat.appendStream",
      platformError("message_not_in_streaming_state"),
    );
    slack.fail(
      "chat.stopStream",
      platformError("message_not_in_streaming_state"),
    );
    const service = serviceOf(store, new FakeAgents(), slack);
    await service.handlePrompt(promptOf(), "B1");
    const final = slack.of("chat.update").at(-1)?.message;
    expect(final).toBeDefined();
    expect(allText(final)).not.toContain(
      "connection to Datalayer was interrupted",
    );
    expect(allText(final)).toContain("Hello from Datalayer.");
  });
});
