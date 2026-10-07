import { describe, expect, it, vi } from "vitest";

import type { AgentClient } from "../src/agent-client.js";
import type { AgentUpdate, IncomingPrompt } from "../src/domain.js";
import { SlackAgentService } from "../src/service.js";
import type { SlackMessage, SlackPort } from "../src/slack-port.js";
import { MemorySlackStore } from "../src/store.js";

const prompt: IncomingPrompt = {
  appId: "A1",
  channelId: "C1",
  eventId: "Ev1",
  teamId: "T1",
  text: "<@B1> hello",
  threadTs: "1.0",
  userId: "U1",
};

async function* updates(): AsyncIterable<AgentUpdate> {
  yield { kind: "text", text: "Hello from Datalayer." };
  yield { kind: "complete" };
}

class FakeSlack implements SlackPort {
  privateMessages: SlackMessage[] = [];
  threadMessages: SlackMessage[] = [];
  updates: SlackMessage[] = [];

  async postDirect(
    _key: IncomingPrompt,
    _userId: string,
    message: SlackMessage,
  ): Promise<{ channelId: string; ts: string }> {
    this.privateMessages.push(message);
    return { channelId: "D1", ts: "3.0" };
  }

  async postPrivate(
    _key: IncomingPrompt,
    _userId: string,
    message: SlackMessage,
  ): Promise<void> {
    this.privateMessages.push(message);
  }

  async postThread(
    _key: IncomingPrompt,
    message: SlackMessage,
  ): Promise<string> {
    this.threadMessages.push(message);
    return "2.0";
  }

  async updateMessage(
    _key: IncomingPrompt,
    _messageTs: string,
    message: SlackMessage,
  ): Promise<void> {
    this.updates.push(message);
  }
}

describe("SlackAgentService", () => {
  it("asks an unlinked user to connect without starting a turn", async () => {
    const store = new MemorySlackStore();
    await store.putInstallation({
      appId: "A1",
      botToken: "token",
      botUserId: "B1",
      installedBy: "U0",
      scopes: [],
      status: "active",
      teamId: "T1",
      updatedAt: new Date(0).toISOString(),
    });
    const slack = new FakeSlack();
    const agents: AgentClient = { startTurn: vi.fn(), stopTurn: vi.fn() };
    const service = new SlackAgentService(
      store,
      agents,
      slack,
      "https://datalayer.ai",
    );

    await service.handlePrompt(prompt, "B1");

    expect(slack.privateMessages[0]?.text).toContain(
      "/docs/slack#install-and-connect",
    );
    expect(agents.startTurn).not.toHaveBeenCalled();
  });

  it("starts one session and binds the Slack thread", async () => {
    const store = new MemorySlackStore();
    await store.putInstallation({
      appId: "A1",
      botToken: "token",
      botUserId: "B1",
      installedBy: "U0",
      scopes: [],
      status: "active",
      teamId: "T1",
      updatedAt: new Date(0).toISOString(),
    });
    await store.putUserLink({
      appId: "A1",
      datalayerPrincipalId: "P1",
      linkedAt: new Date(0).toISOString(),
      slackUserId: "U1",
      status: "active",
      teamId: "T1",
    });
    await store.setDefaultApplication(
      { appId: "A1", teamId: "T1" },
      "launch-review",
    );
    const slack = new FakeSlack();
    const startTurn = vi.fn(async () => ({
      sessionId: "S1",
      updates: updates(),
    }));
    const service = new SlackAgentService(
      store,
      { startTurn, stopTurn: vi.fn() },
      slack,
      "https://datalayer.ai",
    );

    await service.handlePrompt(prompt, "B1");
    await service.handlePrompt(prompt, "B1");

    expect(startTurn).toHaveBeenCalledTimes(1);
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        applicationId: "launch-review",
        externalUserId: "U1",
        principalId: "P1",
        prompt: "hello",
      }),
    );
    await expect(store.getThread(prompt)).resolves.toMatchObject({
      sessionId: "S1",
    });
    expect(slack.updates.at(-1)?.text).toContain("Hello from Datalayer.");
  });

  it("drops queued work after its workspace is uninstalled", async () => {
    const store = new MemorySlackStore();
    await store.putInstallation({
      appId: "A1",
      botToken: "token",
      botUserId: "B1",
      installedBy: "U0",
      scopes: [],
      status: "active",
      teamId: "T1",
      updatedAt: new Date(0).toISOString(),
    });
    await store.deleteInstallation({ appId: "A1", teamId: "T1" });
    const slack = new FakeSlack();
    const agents: AgentClient = { startTurn: vi.fn(), stopTurn: vi.fn() };
    const service = new SlackAgentService(
      store,
      agents,
      slack,
      "https://datalayer.ai",
    );

    await service.handlePrompt({ ...prompt, eventId: "Ev-after-uninstall" });

    expect(agents.startTurn).not.toHaveBeenCalled();
    expect(slack.privateMessages).toHaveLength(0);
    expect(slack.threadMessages).toHaveLength(0);
  });

  it("sends an unlinked person a one-use link to connect, from the workspace's host", async () => {
    const store = new MemorySlackStore();
    await store.putInstallation({
      appId: "A1",
      botToken: "token",
      botUserId: "B1",
      installedBy: "U0",
      scopes: [],
      status: "active",
      teamId: "T1",
      updatedAt: new Date(0).toISOString(),
    });
    const slack = new FakeSlack();
    const agents: AgentClient = { startTurn: vi.fn(), stopTurn: vi.fn() };
    const service = new SlackAgentService(
      store,
      agents,
      slack,
      "https://datalayer.ai",
      {
        connectUrlOf: async () => "https://datalayer.ai/hosts/link?code=dlhc_x",
        linkOf: async () => undefined,
      },
    );

    await service.handlePrompt({ ...prompt, eventId: "Ev-unlinked" }, "B1");

    expect(slack.privateMessages[0]?.text).toContain(
      "<https://datalayer.ai/hosts/link?code=dlhc_x|Connect your Datalayer account>",
    );
    expect(agents.startTurn).not.toHaveBeenCalled();
  });

  it("keeps the status message pending while a turn is not finished", async () => {
    const store = new MemorySlackStore();
    await store.putInstallation({
      appId: "A1",
      botToken: "token",
      botUserId: "B1",
      installedBy: "U0",
      scopes: [],
      status: "active",
      teamId: "T1",
      updatedAt: new Date(0).toISOString(),
    });
    await store.setDefaultApplication({ appId: "A1", teamId: "T1" }, "dep-1");
    async function* paused(): AsyncIterable<AgentUpdate> {
      yield { kind: "status", label: "Waiting for your approval" };
    }
    const service = new SlackAgentService(
      store,
      {
        startTurn: vi.fn(async () => ({ sessionId: "S1", updates: paused() })),
        stopTurn: vi.fn(),
      },
      new FakeSlack(),
      "https://datalayer.ai",
      {
        connectUrlOf: async () => undefined,
        linkOf: async () => ({ principalId: "alice" }),
      },
    );

    await service.handlePrompt({ ...prompt, eventId: "Ev-paused" }, "B1");
    await expect(store.getThread(prompt)).resolves.toMatchObject({
      pendingMessageTs: "2.0",
    });
  });
});
