import { readFileSync } from "node:fs";

import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";

import { BoltSlackPort } from "../src/bolt.js";
import { slackMemberOf, type SlackUserInfo } from "../src/slack-port.js";
import { MemorySlackStore } from "../src/store.js";
import { platformError } from "./support/fakes.js";

const usersInfo = JSON.parse(
  readFileSync(new URL("./fixtures/users-info.json", import.meta.url), "utf8"),
) as Record<string, { ok: boolean; user: SlackUserInfo }>;
const userOf = (name: string): SlackUserInfo => {
  const answer = usersInfo[name];
  if (!answer) throw new Error(`No users.info fixture ${name}.`);
  return answer.user;
};

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
    await expect(port.streaming?.start(key, "U1")).resolves.toBe("9.0");
    await port.streaming?.append(key, "9.0", "Option B");
    await port.streaming?.stop(key, "9.0", {
      blocks: [{ type: "divider" }],
      text: "Option B",
    });
    // Started empty: no seed stays in the answer (S-206).
    expect(startStream).toHaveBeenCalledWith({
      channel: "C1",
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

describe("who a member is, from Slack's users.info (S-103, S-209)", () => {
  const team = { teamId: "T1" };
  const grid = { enterpriseId: "E1", teamId: "T1" };
  const none = { deactivated: false, external: false, guest: false };

  it("reads each users.info shape as @Datalayer decides it", () => {
    expect(slackMemberOf(userOf("full_member"), team)).toEqual(none);
    expect(slackMemberOf(userOf("multi_channel_guest"), team)).toEqual({
      ...none,
      guest: true,
    });
    expect(slackMemberOf(userOf("single_channel_guest"), team)).toEqual({
      ...none,
      guest: true,
    });
    expect(slackMemberOf(userOf("slack_connect_stranger"), team)).toEqual({
      ...none,
      external: true,
    });
    expect(slackMemberOf(userOf("other_home_team"), team)).toEqual({
      ...none,
      external: true,
    });
    expect(slackMemberOf(userOf("deactivated"), team)).toEqual({
      ...none,
      deactivated: true,
    });
  });

  it("keeps a member of another workspace of the same Enterprise Grid organization, not of another one", () => {
    expect(
      slackMemberOf(userOf("grid_member_of_another_workspace"), grid),
    ).toEqual(none);
    expect(
      slackMemberOf(userOf("grid_member_of_another_organization"), grid),
    ).toEqual({ ...none, external: true });
    // Outside Grid, another home team stays another organization.
    expect(
      slackMemberOf(userOf("grid_member_of_another_workspace"), team),
    ).toEqual({ ...none, external: true });
    // A stranger is external whatever its enterprise says.
    expect(
      slackMemberOf(
        {
          ...userOf("slack_connect_stranger"),
          enterprise_user: { enterprise_id: "E1" },
        },
        grid,
      ),
    ).toEqual({ ...none, external: true });
  });

  async function portOf(info: (args: unknown) => Promise<unknown>) {
    const store = new MemorySlackStore();
    await store.putInstallation({
      appId: "A1",
      botToken: "xoxb-team-one",
      botUserId: "B1",
      installedBy: "U1",
      scopes: ["users:read"],
      status: "active",
      teamId: "T1",
      updatedAt: new Date(0).toISOString(),
    });
    const users = { info: vi.fn(info) };
    const client = { users } as unknown as WebClient;
    return { port: new BoltSlackPort(client, store), users };
  }

  it("asks users.info with the workspace's token through BoltSlackPort.memberOf", async () => {
    const answers: Record<string, string> = {
      U01FULL: "full_member",
      U03SCG: "single_channel_guest",
      U04EXT: "slack_connect_stranger",
      U08GONE: "deactivated",
    };
    const { port, users } = await portOf(async (args) => {
      const { user } = args as { user: string };
      return usersInfo[answers[user] ?? ""];
    });
    const key = { appId: "A1", teamId: "T1" };
    await expect(port.memberOf(key, "U01FULL")).resolves.toEqual(none);
    await expect(port.memberOf(key, "U03SCG")).resolves.toEqual({
      ...none,
      guest: true,
    });
    await expect(port.memberOf(key, "U04EXT")).resolves.toEqual({
      ...none,
      external: true,
    });
    await expect(port.memberOf(key, "U08GONE")).resolves.toEqual({
      ...none,
      deactivated: true,
    });
    expect(users.info).toHaveBeenCalledWith({
      token: "xoxb-team-one",
      user: "U01FULL",
    });
  });

  it("fails when users.info names no user, or Slack refuses the call (no fail-open)", async () => {
    const key = { appId: "A1", teamId: "T1" };
    const empty = await portOf(async () => ({ ok: true }));
    await expect(empty.port.memberOf(key, "U1")).rejects.toThrow(
      "Slack did not return the member.",
    );
    const refused = await portOf(async () => {
      throw platformError("missing_scope");
    });
    await expect(refused.port.memberOf(key, "U1")).rejects.toThrow(
      /missing_scope/,
    );
  });
});
