import { describe, expect, it } from "vitest";

import {
  HostRefusedError,
  type SemanticEvent,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import { OPEN_ACTION, openValueOf, STOP_ACTION } from "../src/presentation.js";
import { SlackAgentService, type StopValue } from "../src/service.js";
import { MemorySlackStore } from "../src/store.js";
import {
  FakeAgents,
  FakeClock,
  FakeLinks,
  FakeSlack,
  installedStore,
  keptLogger,
  platformError,
  promptOf,
  streamOf,
} from "./support/fakes.js";

function serviceOf(
  store: MemorySlackStore,
  agents = new FakeAgents(),
  slack = new FakeSlack(),
  links = new FakeLinks(),
  clock = new FakeClock(),
) {
  const { lines, logger } = keptLogger();
  const service = new SlackAgentService(
    store,
    agents,
    slack,
    "https://datalayer.ai",
    links,
    { clock, logger },
  );
  return { agents, clock, lines, links, service, slack };
}

const texts = (slack: FakeSlack, method: string) =>
  slack.of(method).map((call) => call.message?.text ?? "");

describe("resolving a Slack message to a person and an application (S-202)", () => {
  it("asks an unlinked person to connect, privately, and starts no run", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    const run = serviceOf(
      store,
      new FakeAgents(),
      new FakeSlack(),
      new FakeLinks(new Map(), "https://datalayer.ai/hosts/link?code=dlhc_x"),
    );
    await run.service.handlePrompt(promptOf(), "B1");
    expect(texts(run.slack, "private")[0]).toContain(
      "<https://datalayer.ai/hosts/link?code=dlhc_x|Connect your Datalayer account>",
    );
    expect(run.slack.of("private")[0]?.key).toMatchObject({
      channelId: "C1",
      threadTs: "1.0",
    });
    expect(run.agents.requests).toHaveLength(0);
    expect(run.slack.of("chat.postMessage")).toHaveLength(0);
  });

  it("offers the private selector when no application is set, and holds the prompt", async () => {
    const store = await installedStore({
      allow: [
        { id: "dep-1", name: "Launch Review" },
        { id: "dep-2", name: "Desk", directOnly: true },
      ],
    });
    const run = serviceOf(store);
    await run.service.handlePrompt(promptOf(), "B1");
    const selector = run.slack.of("private")[0]?.message;
    expect(JSON.stringify(selector?.blocks)).toContain("Launch Review");
    // A direct-only application is not offered in a channel.
    expect(JSON.stringify(selector?.blocks)).not.toContain("Desk");
    expect(run.agents.requests).toHaveLength(0);
    await expect(
      store.takeHeldPrompt(promptOf(), "Ev1", "U1"),
    ).resolves.toMatchObject({ eventId: "Ev1" });
  });

  it("says no application is available when the installation allows none", async () => {
    const store = await installedStore();
    const run = serviceOf(store);
    await run.service.handlePrompt(promptOf(), "B1");
    expect(texts(run.slack, "private")[0]).toContain(
      "No application is available from Slack here yet",
    );
    expect(run.agents.requests).toHaveLength(0);
  });

  it("refuses a channel the administrator turned off", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    await store.putChannelBindings(promptOf(), [
      {
        appId: "A1",
        channelId: "C1",
        state: "deny",
        teamId: "T1",
        updatedAt: new Date(0).toISOString(),
        updatedBy: "owner",
      },
    ]);
    const run = serviceOf(store);
    await run.service.handlePrompt(promptOf(), "B1");
    expect(texts(run.slack, "private")[0]).toContain(
      "turned off in this channel",
    );
    expect(run.agents.requests).toHaveLength(0);
  });

  it("uses the channel's own application before the workspace default", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    await store.putChannelBindings(promptOf(), [
      {
        appId: "A1",
        applicationId: "dep-2",
        channelId: "C1",
        state: "allow",
        teamId: "T1",
        updatedAt: new Date(0).toISOString(),
        updatedBy: "owner",
      },
    ]);
    const run = serviceOf(store);
    await run.service.handlePrompt(promptOf(), "B1");
    expect(run.agents.requests[0]?.applicationId).toBe("dep-2");
  });

  it("uses an explicit choice before the channel and the default", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    const run = serviceOf(store);
    await run.service.handlePrompt(promptOf({ applicationId: "dep-3" }), "B1");
    expect(run.agents.requests[0]?.applicationId).toBe("dep-3");
  });

  it("refuses an application no longer allowed, and a direct-only one in a channel", async () => {
    const store = await installedStore({
      allow: [{ id: "dep-2", name: "Desk", directOnly: true }],
      defaultApplication: "dep-1",
    });
    const run = serviceOf(store);
    await run.service.handlePrompt(promptOf(), "B1");
    expect(texts(run.slack, "private")[0]).toContain("no longer available");
    await run.service.handlePrompt(
      promptOf({ applicationId: "dep-2", eventId: "Ev2" }),
      "B1",
    );
    expect(texts(run.slack, "private")[1]).toContain(
      "answers only in a direct message",
    );
    expect(run.agents.requests).toHaveLength(0);
  });

  it("fails closed in Slack Connect and for a person of another workspace", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    const run = serviceOf(store);
    await run.service.handlePrompt(promptOf({ isExtShared: true }), "B1");
    await run.service.handlePrompt(
      promptOf({ eventId: "Ev2", userTeamId: "T9" }),
      "B1",
    );
    expect(texts(run.slack, "private")).toHaveLength(2);
    expect(texts(run.slack, "private")[0]).toContain("Slack Connect");
    expect(run.agents.requests).toHaveLength(0);
  });

  it("refuses guests and people of another organization by default, offering them no link (S-209)", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    const slack = new FakeSlack();
    slack.members.set("U1", {
      deactivated: false,
      external: false,
      guest: true,
    });
    slack.members.set("U2", {
      deactivated: false,
      external: true,
      guest: false,
    });
    const links = new FakeLinks(
      new Map([
        ["U1", "alice"],
        ["U2", "bob"],
      ]),
      "https://datalayer.ai/hosts/link?code=dlhc_x",
    );
    const run = serviceOf(store, new FakeAgents(), slack, links);
    await run.service.handlePrompt(promptOf(), "B1");
    await run.service.handlePrompt(
      promptOf({ eventId: "Ev2", userId: "U2" }),
      "B1",
    );
    const said = texts(run.slack, "private");
    expect(said).toHaveLength(2);
    expect(said[0]).toContain("does not answer guests of this workspace");
    expect(said[1]).toContain("people of another organization");
    for (const words of said) {
      expect(words).toContain("/docs/slack#limits-and-availability");
      expect(words).not.toContain("hosts/link");
    }
    expect(slack.lookedUp).toEqual(["U1", "U2"]);
    expect(run.agents.requests).toHaveLength(0);
    expect(run.lines.join("\n")).toMatch(/"reason":"guest"/);
    expect(run.lines.join("\n")).toMatch(/"reason":"external"/);
  });

  it("unlinks a person Slack says is deactivated, says nothing and runs nothing (S-103)", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    const slack = new FakeSlack();
    slack.members.set("U1", {
      deactivated: true,
      external: false,
      guest: false,
    });
    const run = serviceOf(store, new FakeAgents(), slack);
    await run.service.handlePrompt(promptOf(), "B1");
    expect(run.links.unlinked).toEqual(["U1"]);
    expect(run.slack.calls).toHaveLength(0);
    expect(run.agents.requests).toHaveLength(0);
    const logged = run.lines.join("\n");
    expect(logged).toMatch(/"identity.unlinked"[^\n]*"reason":"deleted"/);
    expect(logged).toMatch(/"identity.refused"[^\n]*"reason":"deactivated"/);
  });

  it("answers a member of another workspace of the installation's Enterprise Grid organization (S-209)", async () => {
    const grid = { appId: "A1", enterpriseId: "E1", teamId: "T1" };
    const store = new MemorySlackStore();
    await store.putInstallation({
      ...grid,
      botToken: "xoxb-test",
      botUserId: "B1",
      installedBy: "U0",
      scopes: ["app_mentions:read", "chat:write", "im:history"],
      status: "active",
      updatedAt: new Date(0).toISOString(),
    });
    await store.setDefaultApplication(grid, "dep-1");
    const slack = new FakeSlack();
    const run = serviceOf(store, new FakeAgents(), slack);
    await run.service.handlePrompt(
      promptOf({ ...grid, userTeamId: "T2" }),
      "B1",
    );
    expect(slack.lookedUp).toEqual(["U1"]);
    expect(run.agents.requests).toHaveLength(1);
    // users.info decides: another organization is still refused.
    slack.members.set("U1", {
      deactivated: false,
      external: true,
      guest: false,
    });
    await run.service.handlePrompt(
      promptOf({ ...grid, eventId: "Ev2", threadTs: "2.0", userTeamId: "T8" }),
      "B1",
    );
    expect(run.agents.requests).toHaveLength(1);
    expect(texts(run.slack, "private").at(-1)).toContain(
      "people of another organization",
    );
  });

  it("answers a full member after asking Slack who they are, and fails the turn when Slack cannot say", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    const slack = new FakeSlack();
    const run = serviceOf(store, new FakeAgents(), slack);
    await run.service.handlePrompt(promptOf(), "B1");
    expect(slack.lookedUp).toEqual(["U1"]);
    expect(run.agents.requests).toHaveLength(1);
    slack.fail("users.info", platformError("missing_scope"));
    await expect(
      run.service.handlePrompt(
        promptOf({ eventId: "Ev2", threadTs: "2.0" }),
        "B1",
      ),
    ).rejects.toThrow(/missing_scope/);
    expect(run.agents.requests).toHaveLength(1);
  });

  it("refuses privately when Datalayer refuses the linked person the application", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    const agents = new FakeAgents(() => {
      throw new HostRefusedError(
        403,
        "You may not open this deployment.",
        "exchange",
      );
    });
    const run = serviceOf(store, agents);
    await run.service.handlePrompt(promptOf(), "B1");
    expect(texts(run.slack, "private")[0]).toContain(
      "You may not open this deployment.",
    );
    expect(run.slack.of("chat.postMessage")).toHaveLength(0);
    expect(run.lines.some((line) => line.includes('"identity.refused"'))).toBe(
      true,
    );
  });

  it("asks for words after the mention", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    const run = serviceOf(store);
    await run.service.handlePrompt(promptOf({ text: "<@B1>" }), "B1");
    expect(texts(run.slack, "private")[0]).toBe(
      "Add a question after @Datalayer.",
    );
    expect(run.agents.requests).toHaveLength(0);
  });
});

describe("a session per thread, with the speaker and Slack provenance (S-204)", () => {
  it("opens the session as the linked person and resumes it within the thread", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    const run = serviceOf(
      store,
      undefined,
      undefined,
      new FakeLinks(
        new Map([
          ["U1", "alice"],
          ["U2", "bob"],
        ]),
      ),
    );
    await run.service.handlePrompt(promptOf(), "B1");
    await run.service.handlePrompt(
      promptOf({ eventId: "Ev2", text: "<@B1> and the costs?", userId: "U2" }),
      "B1",
    );
    const [first, second] = run.agents.requests;
    expect(first).toMatchObject({
      applicationId: "dep-1",
      externalEventId: "Ev1",
      externalUserId: "U1",
      principalId: "alice",
      prompt: "compare the launch options",
      provenance: {
        appId: "A1",
        channelId: "C1",
        teamId: "T1",
        threadTs: "1.0",
      },
      sessionGeneration: 0,
    });
    expect(first?.sessionId).toBeUndefined();
    // The second person's turn enters as their own principal, in the same session.
    expect(second).toMatchObject({
      externalEventId: "Ev2",
      externalUserId: "U2",
      principalId: "bob",
      sessionId: "S-0",
    });
    await expect(store.getThread(promptOf())).resolves.toMatchObject({
      lastEventId: "Ev2",
      lastRunId: "t1",
      openedByPrincipalId: "alice",
      sessionId: "S-0",
      visibility: "channel",
    });
  });

  it("marks a direct message's thread as direct", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    const run = serviceOf(store);
    await run.service.handlePrompt(promptOf({ channelId: "D1" }), "B1");
    await expect(
      store.getThread(promptOf({ channelId: "D1" })),
    ).resolves.toMatchObject({
      visibility: "direct",
    });
  });
});

describe("turns: serialization, Stop, duplicates and crashes (S-207)", () => {
  it("answers a duplicate event once", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    const run = serviceOf(store);
    await run.service.handlePrompt(promptOf(), "B1");
    await run.service.handlePrompt(promptOf(), "B1");
    await run.service.handlePrompt(promptOf(), "B1");
    expect(run.agents.requests).toHaveLength(1);
    expect(run.slack.of("chat.postMessage")).toHaveLength(1);
  });

  it("refuses a second prompt while the thread's turn runs, and names the run on Stop", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* slow(): AsyncIterable<SemanticEvent> {
      yield { kind: "text", text: "Working on it" };
      await held;
      yield { kind: "completion" };
    }
    const agents = new FakeAgents((request) => ({
      run: { id: "run-7" },
      sessionId: request.sessionId ?? "S1",
      updates: slow(),
    }));
    const run = serviceOf(store, agents);
    const first = run.service.handlePrompt(promptOf(), "B1");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await run.service.handlePrompt(
      promptOf({ eventId: "Ev2", text: "<@B1> also" }),
      "B1",
    );
    expect(texts(run.slack, "private")[0]).toContain(
      "still answering in this thread",
    );
    expect(agents.requests).toHaveLength(1);

    // The Stop button on the running answer names this run.
    const posted = run.slack.of("chat.postMessage")[0]?.message;
    const stop = JSON.stringify(posted?.blocks ?? []);
    expect(stop).toContain(STOP_ACTION);
    const turn = await store.getTurn(promptOf());
    expect(turn).toMatchObject({
      runId: "run-7",
      sessionId: "S1",
      state: "running",
    });

    // Stop with a value naming another run is refused; the right one stops.
    const value: StopValue = { e: "Ev1", r: "run-7", s: "S1" };
    await expect(
      run.service.stop(promptOf(), { ...value, r: "run-6" }, "U1"),
    ).resolves.toBe("not-running");
    await expect(run.service.stop(promptOf(), value, "U9")).resolves.toBe(
      "not-linked",
    );
    // A guest is offered no link to stop it either (S-209).
    run.slack.members.set("U8", {
      deactivated: false,
      external: false,
      guest: true,
    });
    await expect(run.service.stop(promptOf(), value, "U8")).resolves.toBe(
      "not-a-member",
    );
    await expect(run.service.stop(promptOf(), value, "U1")).resolves.toBe(
      "stopped",
    );
    expect(agents.stops).toHaveLength(1);
    expect(agents.stops[0]).toMatchObject({
      request: { principalId: "alice" },
      sessionId: "S1",
    });
    release();
    await first;
    await expect(run.service.stop(promptOf(), value, "U1")).resolves.toBe(
      "not-running",
    );
  });

  it("resumes the same message after a crash, without a second answer message", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    // The first worker posted its placeholder, then died: the turn is still running.
    const crashedAt = new Date(new FakeClock().now() - 6 * 60 * 1000);
    const claim = await store.beginTurn(
      promptOf(),
      "Ev1",
      crashedAt,
      60 * 60 * 1000,
    );
    expect(claim.outcome).toBe("started");
    await store.updateTurn(promptOf(), "Ev1", {
      messageTs: "9.0",
      sessionId: "S1",
    });
    const agents = new FakeAgents((request) => ({
      run: { id: "t1" },
      sessionId: "S1",
      // Datalayer replays the same event id: the original answer, nothing run again.
      updates: streamOf({
        kind: "completion",
        text: `Replayed ${request.externalEventId}`,
      }),
    }));
    const run = serviceOf(store, agents);
    await run.service.handlePrompt(promptOf(), "B1");
    expect(run.slack.of("chat.postMessage")).toHaveLength(0);
    const updates = run.slack.of("chat.update");
    expect(updates.every((call) => call.ts === "9.0")).toBe(true);
    expect(updates.at(-1)?.message?.text).toBe("Replayed Ev1");
    expect(agents.requests[0]?.externalEventId).toBe("Ev1");
    // Replayed once more (a second redelivery): done, nothing posted.
    await run.service.handlePrompt(promptOf(), "B1");
    expect(agents.requests).toHaveLength(1);
  });

  it("finishes with an error, and lets the next prompt run, when the stream breaks", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    async function* broken(): AsyncIterable<SemanticEvent> {
      yield { kind: "text", text: "Half" };
      throw new Error("socket closed");
    }
    const agents = new FakeAgents(() => ({
      run: {},
      sessionId: "S1",
      updates: broken(),
    }));
    const run = serviceOf(store, agents);
    await run.service.handlePrompt(promptOf(), "B1");
    expect(run.slack.of("chat.update").at(-1)?.message?.text).toContain(
      "The connection to Datalayer was interrupted.",
    );
    expect((await store.getTurn(promptOf()))?.state).toBe("done");
    agents.script = () => ({
      run: {},
      sessionId: "S1",
      updates: streamOf({ kind: "completion", text: "ok" }),
    });
    await run.service.handlePrompt(promptOf({ eventId: "Ev2" }), "B1");
    expect(agents.requests).toHaveLength(2);
  });

  it("serializes concurrent duplicates and prompts into one turn and one final answer", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    const run = serviceOf(store);
    await Promise.all([
      run.service.handlePrompt(promptOf(), "B1"),
      run.service.handlePrompt(promptOf(), "B1"),
      run.service.handlePrompt(promptOf({ eventId: "Ev2" }), "B1"),
    ]);
    expect(run.agents.requests).toHaveLength(1);
    const finals = run.slack
      .of("chat.update")
      .filter((call) => call.message?.text === "Hello from Datalayer.");
    expect(finals).toHaveLength(1);
  });
});

describe("people gone from Slack and late work (S-103, S-106)", () => {
  it("unlinks a person Slack says is deactivated, and audits it", async () => {
    const store = await installedStore();
    const slack = new FakeSlack();
    slack.fail("private", platformError("user_disabled"));
    const links = new FakeLinks(new Map([["U1", "alice"]]));
    const run = serviceOf(store, undefined, slack, links);
    await run.service.handlePrompt(promptOf(), "B1");
    expect(links.unlinked).toEqual(["U1"]);
    expect(
      run.lines.some(
        (line) =>
          line.includes('"identity.unlinked"') &&
          line.includes("user_disabled"),
      ),
    ).toBe(true);
    // The audit line names nobody: pseudonyms only.
    expect(run.lines.join("\n")).not.toContain("U1");
  });

  it("drops queued work after its workspace is uninstalled", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    await store.deleteInstallation({ appId: "A1", teamId: "T1" });
    const run = serviceOf(store);
    await run.service.handlePrompt(
      promptOf({ eventId: "Ev-after-uninstall" }),
      "B1",
    );
    expect(run.agents.requests).toHaveLength(0);
    expect(run.slack.calls).toHaveLength(0);
  });
});

describe("Open in Datalayer (S-305, S-306)", () => {
  it("is an action button naming the session and its person: no link is made at turn start", async () => {
    const store = await installedStore({ defaultApplication: "dep-1" });
    const slack = new FakeSlack();
    const agents = new FakeAgents();
    const service = new SlackAgentService(
      store,
      agents,
      slack,
      "https://datalayer.ai",
      new FakeLinks(),
      { clock: new FakeClock(), logger: keptLogger().logger },
    );
    await service.handlePrompt(promptOf(), "B1");
    const final = JSON.stringify(slack.of("chat.update").at(-1)?.message);
    expect(final).toContain(OPEN_ACTION);
    expect(final).toContain(JSON.stringify(openValueOf("S-0", "U1")));
    expect(final).not.toContain("hosts/open");
    expect(final).not.toContain("/loop/");
  });
});
