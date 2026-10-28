import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { HostRefusedError } from "@datalayer/agent-runtimes/lib/portable/hosts";
import { afterEach, describe, expect, it } from "vitest";

import { BOT_SCOPES } from "../src/bolt.js";
import type { Config } from "../src/config.js";
import {
  CUSTOM_BOT_EVENTS,
  CUSTOM_EVENTS_ROUTE,
  CUSTOM_INSTALL_PATH,
  CUSTOM_WORDS,
  createCustomAppsBolt,
  customAppRoutes,
  customEventsUrlOf,
  installCustomApp,
  slackAuthPort,
  slackBodyOf,
  type SlackAuthPort,
} from "../src/custom-apps.js";
import type { SlackInstallation, SlackInstallationKey } from "../src/domain.js";
import { MemorySlackStore } from "../src/store.js";

/**
 * A Slack app the person brings (decided 28 October 2026): installed from
 * the Ship card with its bot token pasted, bound at Datalayer as a custom
 * installation, its events verified with its own signing secret and handed
 * to the Bolt app made for custom apps, whose authorize reads the app from
 * the body and its token from the store. Nothing of Datalayer's own app's
 * OAuth is involved.
 */

const APP = "A0CUSTOM1";
const TEAM = "T0ACME";
const SECRET = "0123456789abcdef0123456789abcdef";
const TOKEN = `xoxb-${"1".repeat(12)}-${"2".repeat(12)}-abcdefghij`;
const CODE = "dlhc_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const PUBLIC = "https://slack.datalayer.run";
const WEB = "https://datalayer.ai";

/** Slack's answers of a token: alterable per case. */
class FakeAuth implements SlackAuthPort {
  appId = APP;
  scopes: readonly string[] = BOT_SCOPES;
  enterprise = false;
  refuse = false;
  async authTest(token: string) {
    if (this.refuse || token !== TOKEN) throw new Error("invalid_auth");
    return {
      botId: "B0BOT",
      botUserId: "U0BOT",
      isEnterpriseInstall: this.enterprise,
      scopes: this.scopes,
      teamId: TEAM,
      teamName: "Acme",
    };
  }
  async botAppId() {
    return this.appId;
  }
}

/** The host installations as the install uses them: bind, then keep. */
class FakeHosts {
  bound: Array<{ key: SlackInstallationKey; code: string; name?: string }> = [];
  kept: SlackInstallation[] = [];
  refuseBind = false;
  constructor(readonly store: MemorySlackStore) {}
  async bind(key: SlackInstallationKey, code: string, name?: string) {
    if (this.refuseBind) throw new HostRefusedError(404, "spent", "bind");
    this.bound.push({ code, key, name });
    return { defaultDeployment: "d1", hostKey: "dlhk_key", hostUid: "h1", name };
  }
  async keep(installation: SlackInstallation, bound?: { hostKey: string; hostUid: string }) {
    this.kept.push(installation);
    await this.store.putInstallation(
      bound
        ? { ...installation, datalayerHostKey: bound.hostKey, datalayerHostUid: bound.hostUid }
        : installation,
    );
  }
}

const quiet = { info: () => {}, warn: () => {} };

function dependencies(auth = new FakeAuth()) {
  const store = new MemorySlackStore();
  const hosts = new FakeHosts(store);
  return {
    auth,
    hosts,
    logger: quiet,
    now: () => new Date("2026-10-28T10:00:00Z"),
    publicUrl: PUBLIC,
    store,
    webUrl: WEB,
  };
}

const request = (over: Partial<Record<string, string>> = {}) => ({
  app_id: APP,
  bind_code: CODE,
  bot_token: TOKEN,
  signing_secret: SECRET,
  ...over,
});

describe("installing a custom Slack app from the Ship card", () => {
  it("checks the token, binds at Datalayer as app:-:team, keeps the installation and the secret, answers the Request URL", async () => {
    const deps = dependencies();
    const done = await installCustomApp(deps, request());
    expect(done).toEqual({
      botEvents: CUSTOM_BOT_EVENTS,
      hostUid: "h1",
      name: "Acme",
      ok: true,
      requestUrl: `${PUBLIC}/slack/apps/${APP}/events`,
    });
    expect(deps.hosts.bound).toEqual([
      { code: CODE, key: { appId: APP, enterpriseId: undefined, teamId: TEAM }, name: "Acme" },
    ]);
    const installation = await deps.store.getInstallation({ appId: APP, teamId: TEAM });
    expect(installation).toMatchObject({
      botToken: TOKEN,
      botUserId: "U0BOT",
      datalayerHostKey: "dlhk_key",
      datalayerHostUid: "h1",
      scopes: BOT_SCOPES,
      status: "active",
    });
    expect(await deps.store.getCustomApp(APP)).toEqual({
      appId: APP,
      botId: "B0BOT",
      createdAt: "2026-10-28T10:00:00.000Z",
      signingSecret: SECRET,
      teamId: TEAM,
    });
    expect(customEventsUrlOf(`${PUBLIC}/`, APP)).toBe(`${PUBLIC}/slack/apps/${APP}/events`);
  });

  it("refuses a token Slack refuses, another app's token, missing scopes and an organization-wide install, keeping nothing", async () => {
    const refused = new FakeAuth();
    refused.refuse = true;
    let deps = dependencies(refused);
    expect(await installCustomApp(deps, request())).toEqual({ error: CUSTOM_WORDS.token, ok: false });

    const other = new FakeAuth();
    other.appId = "A0OTHER";
    deps = dependencies(other);
    expect(await installCustomApp(deps, request())).toEqual({ error: CUSTOM_WORDS.notTheApp, ok: false });

    const narrow = new FakeAuth();
    narrow.scopes = ["chat:write"];
    deps = dependencies(narrow);
    const lacking = await installCustomApp(deps, request());
    expect(lacking.ok).toBe(false);
    if (!lacking.ok) {
      expect(lacking.error).toContain("app_mentions:read, assistant:write, im:history, users:read");
      expect(lacking.error).not.toContain("chat:write");
    }

    const grid = new FakeAuth();
    grid.enterprise = true;
    deps = dependencies(grid);
    expect(await installCustomApp(deps, request())).toEqual({ error: CUSTOM_WORDS.enterprise, ok: false });
    expect(deps.hosts.bound).toEqual([]);
    expect(await deps.store.getCustomApp(APP)).toBeUndefined();
  });

  it("keeps nothing when Datalayer refuses the bind code", async () => {
    const deps = dependencies();
    deps.hosts.refuseBind = true;
    expect(await installCustomApp(deps, request())).toEqual({ error: CUSTOM_WORDS.bind, ok: false });
    expect(await deps.store.getInstallation({ appId: APP, teamId: TEAM })).toBeUndefined();
    expect(await deps.store.getCustomApp(APP)).toBeUndefined();
  });

  it("reads Slack's auth.test (its scopes in response_metadata) and bots.info through the port", async () => {
    const port = slackAuthPort({
      auth: {
        test: async () => ({
          bot_id: "B0BOT",
          response_metadata: { scopes: ["chat:write", 7] },
          team: "Acme",
          team_id: TEAM,
          user_id: "U0BOT",
        }),
      },
      bots: { info: async () => ({ bot: { app_id: APP } }) },
    });
    expect(await port.authTest(TOKEN)).toEqual({
      botId: "B0BOT",
      botUserId: "U0BOT",
      enterpriseId: undefined,
      isEnterpriseInstall: false,
      scopes: ["chat:write"],
      teamId: TEAM,
      teamName: "Acme",
    });
    expect(await port.botAppId(TOKEN, "B0BOT")).toBe(APP);
  });
});

/** Slack's signature of a body, as Bolt verifies it. */
function signed(body: string, secret: string, at: number): Record<string, string> {
  const mac = createHmac("sha256", secret).update(`v0:${at}:${body}`).digest("hex");
  return { "x-slack-request-timestamp": String(at), "x-slack-signature": `v0=${mac}` };
}

describe("the custom app routes", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  /** The two Bolt custom routes, served as Bolt serves them (`request.params` for the app id). */
  async function serve(deps: ReturnType<typeof dependencies>, handled: Array<Record<string, unknown>> = []) {
    const routes = customAppRoutes({
      ...deps,
      bolt: {
        processEvent: async (event) => {
          handled.push(event.body);
          if (event.body.type === "event_callback") await event.ack();
        },
      },
    });
    const byPath = new Map(routes.map((route) => [route.path, route]));
    server = createServer((request, response) => {
      const path = (request.url ?? "/").split("?")[0] ?? "/";
      if (path === CUSTOM_INSTALL_PATH) return byPath.get(CUSTOM_INSTALL_PATH)!.handler(request, response);
      const match = /^\/slack\/apps\/([^/]+)\/events$/.exec(path);
      if (match) {
        Object.assign(request, { params: { appId: match[1] } });
        return byPath.get(CUSTOM_EVENTS_ROUTE)!.handler(request, response);
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => server!.listen(0, resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { handled, url };
  }

  it("installs from the card's origin only, with a CORS preflight, and refuses another shape", async () => {
    const deps = dependencies();
    const { url } = await serve(deps);
    const preflight = await fetch(`${url}${CUSTOM_INSTALL_PATH}`, {
      headers: { origin: WEB },
      method: "OPTIONS",
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(WEB);
    expect((await fetch(`${url}${CUSTOM_INSTALL_PATH}`, { headers: { origin: "https://evil.example" }, method: "OPTIONS" })).status).toBe(403);
    const elsewhere = await fetch(`${url}${CUSTOM_INSTALL_PATH}`, {
      body: JSON.stringify(request()),
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      method: "POST",
    });
    expect(elsewhere.status).toBe(403);
    const odd = await fetch(`${url}${CUSTOM_INSTALL_PATH}`, {
      body: JSON.stringify({ ...request(), client_secret: "x" }),
      headers: { "content-type": "application/json", origin: WEB },
      method: "POST",
    });
    expect(odd.status).toBe(400);
    expect(await odd.json()).toEqual({ error: CUSTOM_WORDS.invalid });
    const done = await fetch(`${url}${CUSTOM_INSTALL_PATH}`, {
      body: JSON.stringify(request()),
      headers: { "content-type": "application/json", origin: WEB },
      method: "POST",
    });
    expect(done.status).toBe(200);
    expect(done.headers.get("access-control-allow-origin")).toBe(WEB);
    expect(await done.json()).toEqual({
      bot_events: [...CUSTOM_BOT_EVENTS],
      connected: true,
      name: "Acme",
      request_url: `${PUBLIC}/slack/apps/${APP}/events`,
    });
  });

  it("answers url_verification, verifies each request with the app's own secret, and hands events to the custom apps' Bolt", async () => {
    const deps = dependencies();
    await installCustomApp(deps, request());
    const { handled, url } = await serve(deps);
    const at = Math.floor(deps.now().getTime() / 1000);
    const post = (appId: string, body: string, headers: Record<string, string>) =>
      fetch(`${url}/slack/apps/${appId}/events`, {
        body,
        headers: { "content-type": "application/json", ...headers },
        method: "POST",
      });
    const challenge = JSON.stringify({ challenge: "c-1", token: "t", type: "url_verification" });
    const verified = await post(APP, challenge, signed(challenge, SECRET, at));
    expect(verified.status).toBe(200);
    expect(await verified.json()).toEqual({ challenge: "c-1" });
    // Another secret, a stale timestamp, an unknown app: refused, nothing handed on.
    expect((await post(APP, challenge, signed(challenge, "f".repeat(32), at))).status).toBe(401);
    expect((await post(APP, challenge, signed(challenge, SECRET, at - 600))).status).toBe(401);
    expect((await post("A0NOBODY", challenge, signed(challenge, SECRET, at))).status).toBe(404);
    expect(handled).toEqual([]);
    const event = JSON.stringify({
      api_app_id: APP,
      event: { channel: "C1", text: "<@U0BOT> hi", ts: "1.0", type: "app_mention", user: "U1" },
      event_id: "Ev1",
      team_id: TEAM,
      type: "event_callback",
    });
    const handed = await post(APP, event, signed(event, SECRET, at));
    expect(handed.status).toBe(200);
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({ api_app_id: APP, event_id: "Ev1" });
    // A body naming another app under this app's route is not handed on.
    const foreign = event.replace(APP, "A0OTHER");
    expect((await post(APP, foreign, signed(foreign, SECRET, at))).status).toBe(400);
    expect(handled).toHaveLength(1);
  });

  it("reads an interaction's form payload, and JSON otherwise", () => {
    expect(slackBodyOf("application/x-www-form-urlencoded", `payload=${encodeURIComponent('{"type":"block_actions"}')}`)).toEqual({ type: "block_actions" });
    expect(slackBodyOf("application/json", '{"type":"event_callback"}')).toEqual({ type: "event_callback" });
    expect(slackBodyOf("application/json", "{")).toBeUndefined();
  });
});

describe("the Bolt app for custom apps", () => {
  it("authorizes each request as the app the body names, with the token the person pasted", async () => {
    const deps = dependencies();
    await installCustomApp(deps, request());
    const bolt = createCustomAppsBolt({ NODE_ENV: "test" } as unknown as Config, deps.store);
    const seen: Array<{ token?: string; botUserId?: string; botId?: string }> = [];
    bolt.event("app_mention", async ({ context }) => {
      seen.push({ botId: context.botId, botUserId: context.botUserId, token: context.botToken });
    });
    const body = (appId: string) => ({
      api_app_id: appId,
      event: { channel: "C1", text: "hi", ts: "1.0", type: "app_mention", user: "U1" },
      event_id: "Ev1",
      team_id: TEAM,
      type: "event_callback",
    });
    let acked = 0;
    await bolt.processEvent({ ack: async () => void (acked += 1), body: body(APP) });
    expect(seen).toEqual([{ botId: "B0BOT", botUserId: "U0BOT", token: TOKEN }]);
    expect(acked).toBe(1);
    // An app nobody connected: no listener runs.
    await bolt.processEvent({ ack: async () => void (acked += 1), body: body("A0NOBODY") }).catch(() => undefined);
    expect(seen).toHaveLength(1);
  });
});
