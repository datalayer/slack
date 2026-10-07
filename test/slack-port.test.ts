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
