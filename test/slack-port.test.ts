import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";

import { BoltSlackPort } from "../src/bolt.js";
import { MemorySlackStore } from "../src/store.js";

describe("BoltSlackPort", () => {
  it("uses the bot token for the prompt's workspace", async () => {
    const store = new MemorySlackStore();
    await store.putInstallation({
      appId: "A1",
      botToken: "xoxb-team-one",
      botUserId: "B1",
      installedBy: "U1",
      scopes: ["chat:write"],
      status: "active",
      teamId: "T1",
      updatedAt: new Date(0).toISOString(),
    });
    await store.putInstallation({
      appId: "A1",
      botToken: "xoxb-team-two",
      botUserId: "B2",
      installedBy: "U2",
      scopes: ["chat:write"],
      status: "active",
      teamId: "T2",
      updatedAt: new Date(0).toISOString(),
    });
    const postMessage = vi.fn(async () => ({ ts: "2.0" }));
    const client = { chat: { postMessage } } as unknown as WebClient;
    const slack = new BoltSlackPort(client, store);

    await slack.postThread(
      {
        appId: "A1",
        channelId: "C2",
        teamId: "T2",
        threadTs: "1.0",
      },
      { text: "hello" },
    );

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ token: "xoxb-team-two" }),
    );
  });
});

describe("Slack's text streaming (S-206)", () => {
  it("is offered only when turned on, and streams in the thread to its person with the workspace's token", async () => {
    const store = new MemorySlackStore();
    await store.putInstallation({
      appId: "A1",
      botToken: "xoxb-team-one",
      botUserId: "B1",
      installedBy: "U1",
      scopes: ["chat:write"],
      status: "active",
      teamId: "T1",
      updatedAt: new Date(0).toISOString(),
    });
    const startStream = vi.fn(async () => ({ ts: "9.0" }));
    const appendStream = vi.fn(async () => ({}));
    const stopStream = vi.fn(async () => ({}));
    const client = {
      chat: { appendStream, startStream, stopStream },
    } as unknown as WebClient;
    expect(new BoltSlackPort(client, store).streaming).toBeUndefined();
    const port = new BoltSlackPort(client, store, { streaming: true });
    const key = { appId: "A1", channelId: "C1", teamId: "T1", threadTs: "1.0" };
    await expect(port.streaming?.start(key, "U1", "_Working…_")).resolves.toBe(
      "9.0",
    );
    await port.streaming?.append(key, "9.0", "Option B");
    await port.streaming?.stop(key, "9.0", {
      blocks: [{ type: "divider" }],
      text: "Option B",
    });
    expect(startStream).toHaveBeenCalledWith({
      channel: "C1",
      markdown_text: "_Working…_",
      recipient_team_id: "T1",
      recipient_user_id: "U1",
      thread_ts: "1.0",
      token: "xoxb-team-one",
    });
    expect(appendStream).toHaveBeenCalledWith({
      channel: "C1",
      markdown_text: "Option B",
      token: "xoxb-team-one",
      ts: "9.0",
    });
    expect(stopStream).toHaveBeenCalledWith({
      blocks: [{ type: "divider" }],
      channel: "C1",
      token: "xoxb-team-one",
      ts: "9.0",
    });
  });
});
