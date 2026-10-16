import { randomBytes } from "node:crypto";

import type { Installation } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { BoltSlackPort } from "../src/bolt.js";
import {
  BotTokens,
  REFRESH_BEFORE_MS,
  slackTokenRefresh,
  type RefreshBotToken,
} from "../src/bot-tokens.js";
import { SecretCipher } from "../src/crypto.js";
import type { SlackInstallation } from "../src/domain.js";
import type { HostInstallations } from "../src/host-installations.js";
import { PostgresInstallationStore } from "../src/oauth-store.js";
import { MemorySlackStore } from "../src/store.js";

const KEY = { appId: "A1", teamId: "T1" } as const;
const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 16, 8, 0, 0);

function clock(start = T0) {
  let now = start;
  return {
    advance: (ms: number) => (now += ms),
    now: () => now,
  };
}

async function installed(
  store: MemorySlackStore,
  fields: Partial<SlackInstallation> = {},
): Promise<void> {
  await store.putInstallation({
    ...KEY,
    botToken: "xoxe.xoxb-first",
    botRefreshToken: "xoxe-1-refresh-first",
    // Twelve hours from T0, as Slack answers with rotation on.
    botTokenExpiresAt: Math.floor(T0 / 1000) + 12 * 60 * 60,
    botUserId: "UB1",
    installedBy: "U1",
    scopes: ["app_mentions:read", "chat:write", "im:history"],
    status: "active",
    updatedAt: new Date(T0).toISOString(),
    ...fields,
  });
}

function refresher(): RefreshBotToken & { calls: string[] } {
  let n = 0;
  const calls: string[] = [];
  const refresh = (async (refreshToken: string) => {
    calls.push(refreshToken);
    n += 1;
    return {
      accessToken: `xoxe.xoxb-${n + 1}`,
      expiresIn: 12 * 60 * 60,
      refreshToken: `xoxe-1-refresh-${n + 1}`,
    };
  }) as RefreshBotToken & { calls: string[] };
  refresh.calls = calls;
  return refresh;
}

describe("Bot token rotation (S-102)", () => {
  it("answers a token without rotation as stored, never refreshing", async () => {
    const store = new MemorySlackStore();
    await installed(store, {
      botRefreshToken: undefined,
      botToken: "xoxb-static",
      botTokenExpiresAt: undefined,
    });
    const refresh = refresher();
    const tokens = new BotTokens(store, { now: clock().now, refresh });
    await expect(tokens.token(KEY)).resolves.toBe("xoxb-static");
    expect(refresh.calls).toEqual([]);
  });

  it("keeps a rotating token until two hours before it expires", async () => {
    const store = new MemorySlackStore();
    await installed(store);
    const time = clock();
    const refresh = refresher();
    const tokens = new BotTokens(store, { now: time.now, refresh });
    await expect(tokens.token(KEY)).resolves.toBe("xoxe.xoxb-first");
    time.advance(12 * HOUR - REFRESH_BEFORE_MS - 1000);
    await expect(tokens.token(KEY)).resolves.toBe("xoxe.xoxb-first");
    expect(refresh.calls).toEqual([]);
  });

  it("refreshes after a quiet spell, keeps the new token, refresh token and expiry, and tells Bolt's row", async () => {
    const store = new MemorySlackStore();
    await installed(store);
    const time = clock();
    const refresh = refresher();
    const rotated = vi.fn(async () => undefined);
    const tokens = new BotTokens(store, { now: time.now, refresh, rotated });
    // Thirteen hours without an inbound event: the stored token has expired.
    time.advance(13 * HOUR);
    await expect(tokens.token(KEY)).resolves.toBe("xoxe.xoxb-2");
    expect(refresh.calls).toEqual(["xoxe-1-refresh-first"]);
    const kept = await store.getInstallation(KEY);
    expect(kept).toMatchObject({
      botRefreshToken: "xoxe-1-refresh-2",
      botToken: "xoxe.xoxb-2",
      botTokenExpiresAt: Math.floor(time.now() / 1000) + 12 * 60 * 60,
      status: "active",
    });
    expect(rotated).toHaveBeenCalledWith(
      KEY,
      expect.objectContaining({ botToken: "xoxe.xoxb-2" }),
    );
    // The next post uses the kept token: no second refresh.
    await expect(tokens.token(KEY)).resolves.toBe("xoxe.xoxb-2");
    expect(refresh.calls).toHaveLength(1);
  });

  it("refreshes once for concurrent posts of the same workspace", async () => {
    const store = new MemorySlackStore();
    await installed(store);
    const time = clock();
    time.advance(11 * HOUR);
    const refresh = refresher();
    const tokens = new BotTokens(store, { now: time.now, refresh });
    const answers = await Promise.all([
      tokens.token(KEY),
      tokens.token(KEY),
      tokens.token(KEY),
    ]);
    expect(answers).toEqual(["xoxe.xoxb-2", "xoxe.xoxb-2", "xoxe.xoxb-2"]);
    expect(refresh.calls).toHaveLength(1);
  });

  it("fails fast when a due token cannot be refreshed", async () => {
    const time = clock();
    time.advance(13 * HOUR);
    const missing = new MemorySlackStore();
    await installed(missing, { botRefreshToken: undefined });
    await expect(
      new BotTokens(missing, { now: time.now, refresh: refresher() }).token(
        KEY,
      ),
    ).rejects.toThrow(/no refresh token was kept/);

    const unconfigured = new MemorySlackStore();
    await installed(unconfigured);
    await expect(
      new BotTokens(unconfigured, { now: time.now }).token(KEY),
    ).rejects.toThrow(/SLACK_CLIENT_ID and SLACK_CLIENT_SECRET/);

    const failing = new MemorySlackStore();
    await installed(failing);
    await expect(
      new BotTokens(failing, {
        now: time.now,
        refresh: async () => {
          throw new Error("invalid_refresh_token");
        },
      }).token(KEY),
    ).rejects.toThrow(/invalid_refresh_token/);
    await expect(failing.getInstallation(KEY)).resolves.toMatchObject({
      botToken: "xoxe.xoxb-first",
    });
  });

  it("never revives a workspace uninstalled while its token was refreshed", async () => {
    const store = new MemorySlackStore();
    await installed(store);
    const time = clock();
    time.advance(13 * HOUR);
    const tokens = new BotTokens(store, {
      now: time.now,
      refresh: async () => {
        await store.deleteInstallation(KEY);
        return {
          accessToken: "xoxe.xoxb-late",
          expiresIn: 43200,
          refreshToken: "xoxe-1-late",
        };
      },
    });
    await expect(tokens.token(KEY)).rejects.toThrow(/No active Slack/);
    await expect(store.getInstallation(KEY)).resolves.toBeUndefined();

    await installed(store, { status: "disconnected" });
    await expect(tokens.token(KEY)).rejects.toThrow(/No active Slack/);
  });

  it("posts with the refreshed token through the Bolt port", async () => {
    const store = new MemorySlackStore();
    await installed(store);
    const time = clock();
    time.advance(13 * HOUR);
    const postMessage = vi.fn(async () => ({ ts: "2.0" }));
    const client = { chat: { postMessage } } as unknown as WebClient;
    const port = new BoltSlackPort(client, store, {
      tokens: new BotTokens(store, { now: time.now, refresh: refresher() }),
    });
    await port.postThread(
      { ...KEY, channelId: "C1", threadTs: "1.0" },
      { text: "Answer" },
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ token: "xoxe.xoxb-2" }),
    );
  });

  it("exchanges the refresh token at oauth.v2.access and refuses a partial answer", async () => {
    const access = vi.fn(async () => ({
      access_token: "xoxe.xoxb-new",
      expires_in: 43200,
      ok: true,
      refresh_token: "xoxe-1-new",
      token_type: "bot",
    }));
    const client = { oauth: { v2: { access } } } as unknown as WebClient;
    await expect(
      slackTokenRefresh(client, "cid", "csecret")("xoxe-1-old"),
    ).resolves.toEqual({
      accessToken: "xoxe.xoxb-new",
      expiresIn: 43200,
      refreshToken: "xoxe-1-new",
    });
    expect(access).toHaveBeenCalledWith({
      client_id: "cid",
      client_secret: "csecret",
      grant_type: "refresh_token",
      refresh_token: "xoxe-1-old",
    });
    access.mockResolvedValueOnce({ ok: true } as never);
    await expect(
      slackTokenRefresh(client, "cid", "csecret")("xoxe-1-old"),
    ).rejects.toThrow(/did not return a refreshed bot token/);
  });
});

describe("Bolt's installation row with rotation (S-102)", () => {
  function database() {
    let encrypted: unknown;
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes("INSERT INTO slack_oauth_installations"))
        encrypted = values?.[3];
      if (sql.includes("UPDATE slack_oauth_installations"))
        encrypted = values?.[3];
      if (sql.includes("SELECT installation"))
        return { rows: [{ installation: encrypted }] };
      return { rowCount: 1, rows: [] };
    });
    return { pool: { query } as unknown as Pool, query };
  }

  const rotating = (metadata?: string): Installation<"v2", false> => ({
    appId: "A1",
    authVersion: "v2",
    bot: {
      expiresAt: Math.floor(T0 / 1000) + 43200,
      id: "B1",
      refreshToken: "xoxe-1-refresh-first",
      scopes: ["app_mentions:read", "chat:write", "im:history"],
      token: "xoxe.xoxb-first",
      userId: "UB1",
    },
    enterprise: undefined,
    isEnterpriseInstall: false,
    metadata,
    team: { id: "T1", name: "Test" },
    tokenType: "bot",
    user: { id: "U1", scopes: undefined, token: undefined },
  });

  it("keeps the refresh token and expiry, binds once, and a refresh stored again binds nothing", async () => {
    const { pool } = database();
    const domain = new MemorySlackStore();
    const bind = vi.fn(async () => ({
      hostKey: "dlhk_x",
      hostUid: "h1",
    }));
    const keep = vi.fn(async (installation: SlackInstallation) =>
      domain.putInstallation(installation),
    );
    const hosts = { bind, keep } as unknown as HostInstallations;
    const store = new PostgresInstallationStore(
      "A1",
      pool,
      new SecretCipher(randomBytes(32).toString("base64"), 1),
      domain,
      hosts,
    );
    await store.storeInstallation(
      rotating(JSON.stringify({ datalayer_bind: "dlhc_abcdefghijklmnop" })),
    );
    await expect(domain.getInstallation(KEY)).resolves.toMatchObject({
      botRefreshToken: "xoxe-1-refresh-first",
      botTokenExpiresAt: Math.floor(T0 / 1000) + 43200,
    });
    expect(bind).toHaveBeenCalledTimes(1);

    // Bolt's authorize refreshes: it stores the installation it fetched,
    // with the new token. The spent bind code is not in it any more.
    const fetched = await store.fetchInstallation({
      enterpriseId: undefined,
      isEnterpriseInstall: false,
      teamId: "T1",
    });
    expect(fetched.metadata).toBeUndefined();
    await store.storeInstallation({
      ...fetched,
      bot: { ...fetched.bot!, token: "xoxe.xoxb-2" },
    });
    expect(bind).toHaveBeenCalledTimes(1);
    await expect(domain.getInstallation(KEY)).resolves.toMatchObject({
      botToken: "xoxe.xoxb-2",
    });
  });

  it("follows a worker's refresh in Bolt's row", async () => {
    const { pool } = database();
    const domain = new MemorySlackStore();
    const store = new PostgresInstallationStore(
      "A1",
      pool,
      new SecretCipher(randomBytes(32).toString("base64"), 1),
      domain,
    );
    await store.storeInstallation(rotating());
    const time = clock();
    time.advance(13 * HOUR);
    const tokens = new BotTokens(domain, {
      now: time.now,
      refresh: refresher(),
      rotated: (key, installation) => store.rotateBot(key, installation),
    });
    await tokens.token(KEY);
    const fetched = await store.fetchInstallation({
      enterpriseId: undefined,
      isEnterpriseInstall: false,
      teamId: "T1",
    });
    expect(fetched.bot).toMatchObject({
      expiresAt: Math.floor(time.now() / 1000) + 43200,
      refreshToken: "xoxe-1-refresh-2",
      token: "xoxe.xoxb-2",
    });
  });
});
