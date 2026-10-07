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

  async postPrivate(_userId: string, message: SlackMessage): Promise<void> {
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
    _channelId: string,
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
        principalId: "P1",
        prompt: "hello",
      }),
    );
    await expect(store.getThread(prompt)).resolves.toMatchObject({
      sessionId: "S1",
    });
    expect(slack.updates.at(-1)?.text).toContain("Hello from Datalayer.");
  });
});
