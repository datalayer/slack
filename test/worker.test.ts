import { describe, expect, it } from "vitest";

import {
  LogTracer,
  MemoryWorkQueue,
  pseudonym,
  type SemanticEvent,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import { LOG_SALT } from "../src/observability.js";
import { SlackAgentService } from "../src/service.js";
import type { MemorySlackStore } from "../src/store.js";
import {
  NOT_A_MEMBER_HOME,
  SEND_EDITED_ACTION,
  SlackWorker,
  type SlackJob,
} from "../src/worker.js";
import {
  FakeAgents,
  FakeClock,
  FakeLinks,
  FakeSlack,
  installationKey,
  installedStore,
  keptLogger,
  promptOf,
} from "./support/fakes.js";

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

function workerOf(
  store: MemorySlackStore,
  links = new FakeLinks(
    new Map([
      ["U1", "alice"],
      ["U2", "bob"],
    ]),
  ),
) {
  const slack = new FakeSlack();
  const agents = new FakeAgents();
  const queue = new KeptQueue();
  const service = new SlackAgentService(
    store,
    agents,
    slack,
    "https://datalayer.ai",
    links,
    {
      clock: new FakeClock(),
      logger: keptLogger().logger,
    },
  );
  const homes: unknown[] = [];
  const worker = new SlackWorker(service, queue, {
    publishHome: async (_key, _user, view) => {
      homes.push(view);
    },
  });
  return { agents, homes, queue, service, slack, worker };
}

const allow = [
  { id: "dep-1", name: "Launch Review" },
  { id: "dep-2", name: "Desk" },
];

describe("choosing and switching applications (S-208)", () => {
  it("runs a held prompt with the chosen application, for its own person only, once", async () => {
    const store = await installedStore({ allow });
    const { queue, service, worker } = workerOf(store);
    await service.handlePrompt(promptOf(), "B1"); // no default: the selector, the prompt held
    await expect(
      worker.selected(installationKey, { app: "dep-2", ev: "Ev1" }, "U2"),
    ).resolves.toBe("refused");
    await expect(
      worker.selected(installationKey, { app: "dep-9", ev: "Ev1" }, "U1"),
    ).resolves.toBe("refused");
    await expect(
      worker.selected(installationKey, { app: "dep-2", ev: "Ev1" }, "U1"),
    ).resolves.toBe("started");
    await expect(
      worker.selected(installationKey, { app: "dep-2", ev: "Ev1" }, "U1"),
    ).resolves.toBe("refused");
    expect(promptsOf(queue)).toEqual([
      expect.objectContaining({
        applicationId: "dep-2",
        eventId: "Ev1",
      }),
    ]);
  });

  it("switches application into a new session, keeping the old binding's record", async () => {
    const store = await installedStore({ allow, defaultApplication: "dep-1" });
    const { agents, service, slack, worker } = workerOf(store);
    await service.handlePrompt(promptOf(), "B1");
    const before = await store.getThread(promptOf());
    expect(before).toMatchObject({ applicationId: "dep-1", sessionId: "S-0" });

    // Bob did not open the session: he cannot switch it.
    await expect(
      worker.selected(
        installationKey,
        { app: "dep-2", ev: "", sw: true },
        "U2",
        promptOf(),
      ),
    ).resolves.toBe("refused");
    await expect(
      worker.selected(
        installationKey,
        { app: "dep-2", ev: "", sw: true },
        "U1",
        promptOf(),
      ),
    ).resolves.toBe("switched");
    expect(await store.getThread(promptOf())).toBeUndefined();
    expect(await store.getArchivedThreads(promptOf())).toEqual([before]);
    expect(slack.of("chat.postMessage").at(-1)?.message?.text).toContain(
      "opens a new session with Desk",
    );

    await service.handlePrompt(promptOf({ eventId: "Ev2" }), "B1");
    const second = agents.requests.at(-1);
    expect(second).toMatchObject({
      applicationId: "dep-2",
      sessionGeneration: 1,
    });
    expect(second?.sessionId).toBeUndefined();
    expect(await store.getThread(promptOf())).toMatchObject({
      applicationId: "dep-2",
      sessionId: "S-1",
    });
    expect(await store.getNextApplication(promptOf())).toBeUndefined();
  });

  it("starts over only for the person who opened the session, never mid-answer", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    const { service, worker } = workerOf(store);
    await service.handlePrompt(promptOf(), "B1");
    await expect(worker.startOver(promptOf(), "U2")).resolves.toBe(false);
    await expect(worker.startOver(promptOf(), "U9")).resolves.toBe(false);
    await store.beginTurn(
      promptOf(),
      "Ev5",
      new Date(new FakeClock().now()),
      60_000,
    );
    await expect(worker.startOver(promptOf(), "U1")).resolves.toBe(false);
    await store.endTurn(promptOf(), "Ev5");
    await expect(worker.startOver(promptOf(), "U1")).resolves.toBe(true);
    expect(await store.getArchivedThreads(promptOf())).toHaveLength(1);
  });
});

describe("edits, deletes and answers in Slack (S-209, S-307)", () => {
  it("offers to send an edited direct message as a new turn, which only its person can send, once", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    const { queue, slack, worker } = workerOf(store);
    const edited = promptOf({
      channelId: "D1",
      eventId: "EvEdit",
      text: "the new words",
    });
    await worker.handle({ kind: "edited", originalTs: "1.0", prompt: edited });
    const offer = slack.of("private")[0]?.message;
    expect(offer?.text).toContain("Your edit was not sent");
    expect(JSON.stringify(offer?.blocks)).toContain(SEND_EDITED_ACTION);
    await expect(
      worker.sendEdited(installationKey, { ev: "EvEdit" }, "U2", "5.5"),
    ).resolves.toBe(false);
    await expect(
      worker.sendEdited(installationKey, { ev: "EvEdit" }, "U1", "5.5"),
    ).resolves.toBe(true);
    await expect(
      worker.sendEdited(installationKey, { ev: "EvEdit" }, "U1", "5.6"),
    ).resolves.toBe(false);
    expect(promptsOf(queue)).toEqual([
      expect.objectContaining({
        eventId: "edit:EvEdit:5.5",
        text: "the new words",
      }),
    ]);
  });

  it("says a deleted message stays in Datalayer's record", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    const { service, slack, worker } = workerOf(store);
    await service.handlePrompt(promptOf({ channelId: "D1" }), "B1");
    await worker.handle({
      deletedTs: "1.0",
      kind: "deleted",
      thread: promptOf({ channelId: "D1" }),
      userId: "U1",
    });
    expect(slack.of("private").at(-1)?.message?.text).toContain(
      "does not delete it from Datalayer",
    );
  });

  it("sends a choice as the presser's own turn in the thread, once per asking event", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    const { queue, worker } = workerOf(store);
    const asked = { askedBy: "Ev1", option: "Option B" };
    await expect(worker.answered(promptOf(), asked, "U2")).resolves.toBe(true);
    // A second click (a new action_ts), another option, another person.
    await expect(worker.answered(promptOf(), asked, "U2")).resolves.toBe(false);
    await expect(
      worker.answered(promptOf(), { askedBy: "Ev1", option: "Option A" }, "U2"),
    ).resolves.toBe(false);
    await expect(worker.answered(promptOf(), asked, "U1")).resolves.toBe(false);
    // The next question in the thread is answered on its own.
    await expect(
      worker.answered(promptOf(), { askedBy: "Ev2", option: "Yes" }, "U1"),
    ).resolves.toBe(true);
    expect(promptsOf(queue)).toEqual([
      expect.objectContaining({
        eventId: "ask:1.0:Ev1",
        text: "Option B",
        threadTs: "1.0",
        userId: "U2",
      }),
      expect.objectContaining({
        eventId: "ask:1.0:Ev2",
        text: "Yes",
        userId: "U1",
      }),
    ]);
  });
});

describe("App Home and unlinking (S-103, S-104)", () => {
  it("unlinks the person from Home, audits it and republishes their Home", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    const links = new FakeLinks(new Map([["U1", "alice"]]));
    const { homes, worker } = workerOf(store, links);
    await worker.unlink(installationKey, "U1");
    expect(links.unlinked).toEqual(["U1"]);
    expect(JSON.stringify(homes.at(-1))).toContain("Not connected");
  });
});

describe("uninstall races (S-106, §12.1 persistence)", () => {
  it("drops a queued mention, an action and a delivery after app_uninstalled", async () => {
    const store = await installedStore({ allow, defaultApplication: "dep-1" });
    const { agents, slack, worker } = workerOf(store);
    await store.holdPrompt(promptOf({ eventId: "EvHeld" }));
    await store.deleteInstallation(installationKey); // app_uninstalled, tokens_revoked
    await worker.handle({ prompt: promptOf({ eventId: "EvLate" }) });
    await worker.handle({ key: installationKey, kind: "home", userId: "U1" });
    await worker.handle({
      kind: "edited",
      originalTs: "1.0",
      prompt: promptOf({ channelId: "D1" }),
    });
    await expect(
      worker.selected(installationKey, { app: "dep-1", ev: "EvHeld" }, "U1"),
    ).resolves.toBe("refused");
    expect(agents.requests).toHaveLength(0);
    expect(slack.calls).toHaveLength(0);
  });

  it("stops a turn mid-stream when the workspace is uninstalled under it", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    const slack = new FakeSlack();
    const real = slack.updateMessage.bind(slack);
    // Slack's real port refuses a call for an installation no longer active.
    slack.updateMessage = async (key, ts, message) => {
      if (!(await store.getInstallation(key)))
        throw new Error("No active Slack installation was found.");
      return real(key, ts, message);
    };
    let uninstalled = false;
    async function* stream(): AsyncIterable<SemanticEvent> {
      yield { kind: "text", text: "Half of an answer" };
      await store.deleteInstallation(installationKey);
      uninstalled = true;
      yield { kind: "text", text: " that never shows" };
      yield { kind: "completion" };
    }
    const agents = new FakeAgents(() => ({
      run: {},
      sessionId: "S1",
      updates: stream(),
    }));
    const service = new SlackAgentService(
      store,
      agents,
      slack,
      "https://datalayer.ai",
      new FakeLinks(),
      {
        clock: new FakeClock(),
        logger: keptLogger().logger,
      },
    );
    await service.handlePrompt(promptOf(), "B1");
    expect(uninstalled).toBe(true);
    expect(
      slack
        .of("chat.update")
        .map((call) => call.message?.text)
        .join(" "),
    ).not.toContain("never shows");
    // Nothing of the workspace is left behind, and a redelivery is dropped.
    expect(await store.getThread(promptOf())).toBeUndefined();
    await service.handlePrompt(promptOf(), "B1");
    expect(agents.requests).toHaveLength(1);
  });
});

describe("tracing a job (S-101, §12.2)", () => {
  it("spans each job by its kind with pseudonymous ids, never its words", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    const { lines, logger } = keptLogger();
    const service = new SlackAgentService(
      store,
      new FakeAgents(),
      new FakeSlack(),
      "https://datalayer.ai",
      new FakeLinks(),
      {
        clock: new FakeClock(),
        logger: keptLogger().logger,
      },
    );
    const worker = new SlackWorker(service, new KeptQueue(), {
      tracer: new LogTracer(logger, () => 0),
    });
    await worker.handle({ prompt: promptOf({ text: "<@B1> my secret plan" }) });
    const span = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(span).toMatchObject({
      event: "span",
      name: "slack.job.prompt",
      outcome: "ok",
    });
    expect(span["datalayer.slack.installation"]).toBe(
      pseudonym("A1:-:T1", LOG_SALT),
    );
    expect(lines.join("\n")).not.toContain("secret plan");
    expect(lines.join("\n")).not.toContain("C1");
  });
});

describe("the direct message's suggested prompts and guests' Home (S-104, S-209)", () => {
  const thread = { ...installationKey, channelId: "D1", threadTs: "9.0" };

  function assistantOf(
    store: MemorySlackStore,
    startersOf: (
      applicationId: string,
    ) => Promise<ReadonlyArray<{ label: string; message: string }>>,
  ) {
    const slack = new FakeSlack();
    const { lines, logger } = keptLogger();
    const service = new SlackAgentService(
      store,
      new FakeAgents(),
      slack,
      "https://datalayer.ai",
      new FakeLinks(),
      { clock: new FakeClock(), logger },
    );
    const asked: string[] = [];
    const homes: unknown[] = [];
    const worker = new SlackWorker(service, new KeptQueue(), {
      publishHome: async (_key, _user, view) => {
        homes.push(view);
      },
      starters: {
        startersOf: async (_key, userId, applicationId) => {
          asked.push(`${userId}:${applicationId}`);
          return startersOf(applicationId);
        },
      },
    });
    return { asked, homes, lines, slack, worker };
  }

  const five = Array.from({ length: 5 }, (_, index) => ({
    label: `Starter ${index + 1}`,
    message: `Ask ${index + 1}`,
  }));

  it("suggests the default application's first four starters, read as the person", async () => {
    const store = await installedStore({ allow, defaultApplication: "dep-1" });
    const run = assistantOf(store, async () => five);
    await run.worker.handle({ kind: "assistant", thread, userId: "U1" });
    expect(run.asked).toEqual(["U1:dep-1"]);
    const [call] = run.slack.of("assistant.threads.setSuggestedPrompts");
    expect(call?.key).toEqual(thread);
    expect(call?.title).toBe("Try asking Launch Review");
    expect(call?.prompts).toEqual(
      five
        .slice(0, 4)
        .map((one) => ({ message: one.message, title: one.label })),
    );
  });

  it("suggests nothing to a guest, someone not connected, or with no default for direct messages", async () => {
    const store = await installedStore({ allow, defaultApplication: "dep-1" });
    const run = assistantOf(store, async () => five);
    run.slack.members.set("U1", {
      deactivated: false,
      external: false,
      guest: true,
    });
    await run.worker.assistant(thread, "U1");
    await run.worker.assistant(thread, "U9"); // not linked
    expect(run.asked).toEqual([]);
    const none = await installedStore({ allow });
    const other = assistantOf(none, async () => five);
    await other.worker.assistant(thread, "U1");
    expect(other.asked).toEqual([]);
    expect(
      [run, other].flatMap((one) =>
        one.slack.of("assistant.threads.setSuggestedPrompts"),
      ),
    ).toEqual([]);
  });

  it("opens the thread without prompts when the starters cannot be read, and logs it", async () => {
    const store = await installedStore({ allow, defaultApplication: "dep-1" });
    const run = assistantOf(store, async () => {
      throw new Error("the runtime answers no starters");
    });
    await run.worker.assistant(thread, "U1");
    expect(run.slack.of("assistant.threads.setSuggestedPrompts")).toEqual([]);
    expect(run.lines.join("\n")).toContain("assistant.starters_unread");
  });

  it("shows a guest or a person of another organization a Home with no link", async () => {
    const store = await installedStore({ allow, defaultApplication: "dep-1" });
    const run = assistantOf(store, async () => five);
    run.slack.members.set("U1", {
      deactivated: false,
      external: true,
      guest: false,
    });
    await run.worker.home(installationKey, "U1");
    expect(JSON.stringify(run.homes)).toContain(NOT_A_MEMBER_HOME);
    expect(JSON.stringify(run.homes)).not.toContain("hosts/link");
    expect(run.asked).toEqual([]);
  });

  it("shows a guest the same Home with no link, and a deactivated member too (S-103, S-209)", async () => {
    const store = await installedStore({ allow, defaultApplication: "dep-1" });
    const run = assistantOf(store, async () => five);
    run.slack.members.set("U1", {
      deactivated: false,
      external: false,
      guest: true,
    });
    run.slack.members.set("U2", {
      deactivated: true,
      external: false,
      guest: false,
    });
    await run.worker.home(installationKey, "U1");
    await run.worker.home(installationKey, "U2");
    expect(run.homes).toHaveLength(2);
    for (const home of run.homes) {
      expect(JSON.stringify(home)).toContain(NOT_A_MEMBER_HOME);
      expect(JSON.stringify(home)).not.toContain("hosts/link");
    }
    expect(run.asked).toEqual([]);
  });

  it("answers a guest's Stop with the sentence, never the connect link (S-209)", async () => {
    const store = await installedStore({ allow, defaultApplication: "dep-1" });
    const run = assistantOf(store, async () => five);
    await store.beginTurn(thread, "Ev1", new Date(0), 60_000);
    await store.updateTurn(thread, "Ev1", { sessionId: "S1" });
    run.slack.members.set("U7", {
      deactivated: false,
      external: false,
      guest: true,
    });
    await run.worker.stop(thread, { e: "Ev1", s: "S1" }, "U7");
    const said = JSON.stringify(run.slack.of("private"));
    expect(said).toContain(NOT_A_MEMBER_HOME);
    expect(said).not.toContain("Connect your Datalayer account");
  });
});
