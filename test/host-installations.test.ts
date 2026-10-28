import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import type { Installation } from "@slack/bolt";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { uninstallSlackWorkspace } from "../src/bolt.js";
import {
  DatalayerHostClient,
  SecretCipher,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import type { SlackInstallation, SlackInstallationKey } from "../src/domain.js";
import { HostInstallations } from "../src/host-installations.js";
import { PostgresInstallationStore } from "../src/oauth-store.js";
import { PostgresSlackStore } from "../src/postgres-store.js";
import { MemorySlackStore } from "../src/store.js";
import { SlackAgentService } from "../src/service.js";
import {
  FakeAgents,
  FakeClock,
  FakeLinks,
  FakeSlack,
  keptLogger,
  promptOf,
} from "./support/fakes.js";
import { CONTRACTS_PATH } from "./support/contracts.js";

/** The fixture ai-agents tests its half against: the routes and request shapes. */
const contracts = JSON.parse(readFileSync(CONTRACTS_PATH, "utf8")) as {
  bind: { request: Record<string, string>; response_keys: string[] };
  headers: Record<string, string>;
  link_code: { request: Record<string, string>; response_keys: string[] };
  routes: Record<string, string>;
  webhook: { request: Record<string, unknown>; response_keys: string[] };
};

const API = "https://prod1.datalayer.run";
const WEB = "https://datalayer.ai";
const CODE = "dlhc_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_xyz";
const KEY = "dlhk_the-installation-key";
const SECRET = "f".repeat(64);

/** A route of the fixture, as the URL the adapter calls. */
const route = (name: string, values: Record<string, string> = {}) => {
  const [method, template] = contracts.routes[name]!.split(" ") as [
    string,
    string,
  ];
  let path = template;
  for (const [key, value] of Object.entries(values))
    path = path.replace(`{${key}}`, value);
  return `${method} ${API}${path}`;
};

type Call = {
  body?: Record<string, unknown>;
  headers: Record<string, string>;
  key: string;
};

function wire(answers: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fetchImplementation = (async (
    input: string | URL,
    init?: RequestInit,
  ) => {
    const key = `${init?.method ?? "GET"} ${String(input).split("?")[0]}`;
    calls.push({
      body: init?.body
        ? (JSON.parse(init.body as string) as Record<string, unknown>)
        : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
      key,
    });
    const answer = answers[key];
    if (!answer) throw new Error(`unexpected ${key}`);
    return answer();
  }) as typeof fetch;
  return { calls, fetchImplementation };
}

const bound = () =>
  Response.json({
    success: true,
    host: {
      uid: "inst-1",
      state: "active",
      name: "Acme",
      default_deployment: "dep-1",
    },
    host_key: KEY,
  });
const webhook = () =>
  Response.json({
    success: true,
    url: "https://slack.example/datalayer/deliveries/inst-1",
    events: ["approval.requested", "approval.decided", "turn.completed"],
    version: 1,
    signing_secret: SECRET,
  });

const installation: Installation<"v2", false> = {
  appId: "A1",
  authVersion: "v2",
  bot: {
    id: "B1",
    scopes: ["app_mentions:read", "chat:write", "im:history"],
    token: "xoxb-test-value",
    userId: "UB1",
  },
  enterprise: undefined,
  isEnterpriseInstall: false,
  metadata: JSON.stringify({ datalayer_bind: CODE }),
  team: { id: "T1", name: "Acme" },
  tokenType: "bot",
  user: { id: "U1", scopes: undefined, token: undefined },
};

const active: SlackInstallation = {
  appId: "A1",
  botToken: "xoxb",
  botUserId: "B1",
  installedBy: "U0",
  scopes: [],
  status: "active",
  teamId: "T1",
  updatedAt: new Date(0).toISOString(),
};

function hostsOver(
  store: MemorySlackStore | PostgresSlackStore,
  fetchImplementation: typeof fetch,
) {
  return new HostInstallations(
    store,
    new DatalayerHostClient(API, fetchImplementation),
    {
      deliveryUrlOf: (hostUid) =>
        `https://slack.example/datalayer/deliveries/${hostUid}`,
      webUrl: WEB,
    },
  );
}

describe("Bind at install", () => {
  it("binds the workspace with the Ship card's code, keeps its key and registers its deliveries", async () => {
    const store = new MemorySlackStore();
    const { calls, fetchImplementation } = wire({
      [route("bind")]: bound,
      [route("webhook")]: webhook,
    });
    const oauth = new PostgresInstallationStore(
      "A1",
      {
        query: vi.fn(async () => ({ rowCount: 1, rows: [] })),
      } as unknown as Pool,
      new SecretCipher(randomBytes(32).toString("base64"), 1),
      store,
      hostsOver(store, fetchImplementation),
    );

    await oauth.storeInstallation(installation);

    const [bind, hook] = calls;
    expect(bind?.body).toEqual({
      code: CODE,
      custom_app_id: "",
      external_id: "A1:-:T1",
      name: "Acme",
      provider: "datalayer",
    });
    expect(Object.keys(bind!.body!).sort()).toEqual(
      Object.keys(contracts.bind.request).sort(),
    );
    expect(bind?.headers[contracts.headers.host_key!]).toBeUndefined();
    expect(hook?.headers[contracts.headers.host_key!]).toBe(KEY);
    expect(Object.keys(hook!.body!).sort()).toEqual(
      Object.keys(contracts.webhook.request).sort(),
    );
    expect(hook?.body?.url).toBe(
      "https://slack.example/datalayer/deliveries/inst-1",
    );
    await expect(
      store.getInstallation({ appId: "A1", teamId: "T1" }),
    ).resolves.toMatchObject({
      datalayerHostKey: KEY,
      datalayerHostUid: "inst-1",
      deliverySecret: SECRET,
    });
    await expect(
      store.getDefaultApplication({ appId: "A1", teamId: "T1" }),
    ).resolves.toBe("dep-1");
    await expect(
      store.getInstallationByHostUid("inst-1"),
    ).resolves.toMatchObject({
      teamId: "T1",
    });
  });

  it("stores nothing when Datalayer refuses the code", async () => {
    const store = new MemorySlackStore();
    const query = vi.fn(async () => ({ rowCount: 1, rows: [] }));
    const { fetchImplementation } = wire({
      [route("bind")]: () =>
        Response.json({ detail: "This code binds nothing" }, { status: 404 }),
    });
    const oauth = new PostgresInstallationStore(
      "A1",
      { query } as unknown as Pool,
      new SecretCipher(randomBytes(32).toString("base64"), 1),
      store,
      hostsOver(store, fetchImplementation),
    );
    await expect(oauth.storeInstallation(installation)).rejects.toThrow(/404/);
    expect(query).not.toHaveBeenCalled();
    await expect(
      store.getInstallation({ appId: "A1", teamId: "T1" }),
    ).resolves.toBeUndefined();
  });

  it("keeps the key a workspace had when Slack reinstalls it without a code", async () => {
    const store = new MemorySlackStore();
    await store.putInstallation({
      ...active,
      datalayerHostKey: KEY,
      datalayerHostUid: "inst-1",
    });
    const { calls, fetchImplementation } = wire({});
    await hostsOver(store, fetchImplementation).keep({
      ...active,
      botToken: "xoxb-new",
    });
    expect(calls).toHaveLength(0);
    await expect(store.getInstallation(active)).resolves.toMatchObject({
      botToken: "xoxb-new",
      datalayerHostKey: KEY,
    });
  });

  it("keeps the host key and the delivery secret encrypted beside the bot token", async () => {
    let row: unknown[] = [];
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes("INSERT INTO slack_installations")) row = values ?? [];
      return { rowCount: 1, rows: [] };
    });
    const store = new PostgresSlackStore(
      { query } as unknown as Pool,
      new SecretCipher(randomBytes(32).toString("base64"), 1),
    );
    await store.putInstallation({
      ...active,
      datalayerHostKey: KEY,
      datalayerHostUid: "inst-1",
      deliverySecret: SECRET,
    });
    expect(JSON.stringify(row)).not.toContain(KEY);
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(row).toContain("inst-1");
  });
});

describe("Link a person", () => {
  it("asks a one-use code and links to the landing's confirm page", async () => {
    const store = new MemorySlackStore();
    await store.putInstallation({
      ...active,
      datalayerHostKey: KEY,
      datalayerHostUid: "inst-1",
    });
    const { calls, fetchImplementation } = wire({
      [route("link_code")]: () =>
        Response.json({
          success: true,
          code: "dlhc_link code",
          expires_in: 600,
          confirm: "/api/ai-agents/v1/apps/hosts/links",
        }),
      [route("link_state", { external_user_id: "U0ALICE" })]: () =>
        Response.json({ success: true, linked: true, principal_uid: "alice" }),
      [route("link_state", { external_user_id: "U0BOB" })]: () =>
        Response.json({ success: true, linked: false }),
    });
    const hosts = hostsOver(store, fetchImplementation);

    await expect(hosts.connectUrlOf(active, "U0BOB")).resolves.toBe(
      `${WEB}/hosts/link?code=dlhc_link%20code`,
    );
    expect(calls[0]?.headers[contracts.headers.host_key!]).toBe(KEY);
    expect(Object.keys(calls[0]!.body!).sort()).toEqual(
      Object.keys(contracts.link_code.request).sort(),
    );
    await expect(hosts.linkOf(active, "U0ALICE")).resolves.toEqual({
      principalId: "alice",
    });
    await expect(hosts.linkOf(active, "U0BOB")).resolves.toBeUndefined();
  });

  it("offers no link for a workspace never bound, and reads the development seed", async () => {
    const store = new MemorySlackStore();
    await store.putInstallation(active);
    await store.putUserLink({
      appId: "A1",
      datalayerPrincipalId: "P1",
      linkedAt: new Date(0).toISOString(),
      slackUserId: "U1",
      status: "active",
      teamId: "T1",
    });
    const { calls, fetchImplementation } = wire({});
    const hosts = hostsOver(store, fetchImplementation);
    await expect(hosts.connectUrlOf(active, "U1")).resolves.toBeUndefined();
    await expect(hosts.linkOf(active, "U1")).resolves.toEqual({
      principalId: "P1",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("Uninstall", () => {
  it("ends the installation at Datalayer, then purges its key, bindings and cards", async () => {
    const store = new MemorySlackStore();
    await store.putInstallation({
      ...active,
      datalayerHostKey: KEY,
      datalayerHostUid: "inst-1",
    });
    await store.putThread({
      appId: "A1",
      applicationId: "dep-1",
      channelId: "C1",
      openedByPrincipalId: "alice",
      sessionId: "S1",
      teamId: "T1",
      threadTs: "1.0",
      updatedAt: new Date(0).toISOString(),
    });
    const { calls, fetchImplementation } = wire({
      [route("uninstalled")]: () =>
        Response.json({ success: true, links: 1, bindings: 1 }),
    });
    await hostsOver(store, fetchImplementation).uninstall(active);
    expect(calls.map((call) => call.key)).toEqual([route("uninstalled")]);
    expect(calls[0]?.headers[contracts.headers.host_key!]).toBe(KEY);
    await expect(store.getInstallation(active)).resolves.toBeUndefined();
    await expect(
      store.getInstallationByHostUid("inst-1"),
    ).resolves.toBeUndefined();
    await expect(
      store.getThread({ ...active, channelId: "C1", threadTs: "1.0" }),
    ).resolves.toBeUndefined();
  });

  it("purges even when Datalayer cannot be told", async () => {
    const store = new MemorySlackStore();
    await store.putInstallation({ ...active, datalayerHostKey: KEY });
    const { fetchImplementation } = wire({
      [route("uninstalled")]: () => Response.json({}, { status: 503 }),
    });
    const warn = vi.fn();
    await new HostInstallations(
      store,
      new DatalayerHostClient(API, fetchImplementation),
      {
        logger: { warn },
        webUrl: WEB,
      },
    ).uninstall(active);
    expect(warn).toHaveBeenCalled();
    await expect(store.getInstallation(active)).resolves.toBeUndefined();
  });

  it("purges a custom app's signing secret with its installation, and only that app's", async () => {
    const store = new MemorySlackStore();
    await store.putInstallation({ ...active, datalayerHostKey: KEY });
    const custom = {
      appId: "A1",
      botId: "B1",
      createdAt: new Date(0).toISOString(),
      signingSecret: SECRET,
      teamId: "T1",
    };
    await store.putCustomApp(custom);
    await store.putCustomApp({ ...custom, appId: "A2", teamId: "T2" });
    const { fetchImplementation } = wire({
      [route("uninstalled")]: () =>
        Response.json({ success: true, links: 0, bindings: 0 }),
    });
    await hostsOver(store, fetchImplementation).uninstall(active);
    await expect(store.getInstallation(active)).resolves.toBeUndefined();
    await expect(store.getCustomApp("A1")).resolves.toBeUndefined();
    await expect(store.getCustomApp("A2")).resolves.toMatchObject({
      appId: "A2",
    });
  });

  it("still purges a workspace without the Datalayer side (development)", async () => {
    const store = new MemorySlackStore();
    await store.putInstallation(active);
    await uninstallSlackWorkspace(store, active);
    await expect(store.getInstallation(active)).resolves.toBeUndefined();
  });
});

describe("What the installation allows, read from Datalayer (S-104, S-105, S-403)", () => {
  it("keeps the allowed applications, the default, the channel rules and the pause", async () => {
    const store = new MemorySlackStore();
    await store.putInstallation({
      ...active,
      datalayerHostKey: KEY,
      datalayerHostUid: "inst-1",
    });
    const { calls, fetchImplementation } = wire({
      [route("self")]: () =>
        Response.json({
          success: true,
          host: {
            uid: "inst-1",
            account_uid: "alice",
            state: "active",
            default_deployment: "dep-1",
            deployments: [
              {
                uid: "dep-1",
                app_uid: "app-1",
                app_name: "Launch Review",
                state: "live",
                kept: true,
              },
              {
                uid: "dep-2",
                app_uid: "app-2",
                app_name: "Desk",
                state: "live",
                kept: true,
              },
              {
                uid: "dep-3",
                app_uid: "app-3",
                app_name: "Off",
                state: "live",
                kept: false,
              },
            ],
            channels: [
              { id: "C0DENY", state: "deny" },
              { id: "C0DESK", state: "allow", deployment: "dep-2" },
            ],
            direct_only: ["dep-2"],
            paused: false,
          },
        }),
    });
    await hostsOver(store, fetchImplementation).refreshAllowances(active);
    expect(calls[0]?.headers[contracts.headers.host_key!]).toBe(KEY);
    const allowed = await store.getAllowances(active);
    expect(
      allowed.map(
        ({ applicationId, channelPolicy, enabled, isDefault, name }) => ({
          applicationId,
          channelPolicy,
          enabled,
          isDefault,
          name,
        }),
      ),
    ).toEqual([
      {
        applicationId: "dep-1",
        channelPolicy: "channels",
        enabled: true,
        isDefault: true,
        name: "Launch Review",
      },
      {
        applicationId: "dep-2",
        channelPolicy: "direct-only",
        enabled: true,
        isDefault: false,
        name: "Desk",
      },
      // Not kept always on: it answers nobody, so it is not offered.
      {
        applicationId: "dep-3",
        channelPolicy: "channels",
        enabled: false,
        isDefault: false,
        name: "Off",
      },
    ]);
    await expect(store.getDefaultApplication(active)).resolves.toBe("dep-1");
    await expect(
      store.getChannelBinding(active, "C0DENY"),
    ).resolves.toMatchObject({ state: "deny" });
    await expect(
      store.getChannelBinding(active, "C0DESK"),
    ).resolves.toMatchObject({ applicationId: "dep-2", state: "allow" });
  });

  it("offers nothing while its owner paused it", async () => {
    const store = new MemorySlackStore();
    await store.putInstallation({
      ...active,
      datalayerHostKey: KEY,
      datalayerHostUid: "inst-1",
    });
    const { fetchImplementation } = wire({
      [route("self")]: () =>
        Response.json({
          success: true,
          host: {
            uid: "inst-1",
            state: "active",
            default_deployment: "dep-1",
            deployments: [
              { uid: "dep-1", app_name: "Launch Review", kept: true },
            ],
            paused: true,
          },
        }),
    });
    await hostsOver(store, fetchImplementation).refreshAllowances(active);
    expect(
      (await store.getAllowances(active)).every((one) => !one.enabled),
    ).toBe(true);
  });

  it("unlinks a person at Datalayer, with the installation's key", async () => {
    const store = new MemorySlackStore();
    await store.putInstallation({
      ...active,
      datalayerHostKey: KEY,
      datalayerHostUid: "inst-1",
    });
    const { calls, fetchImplementation } = wire({
      [route("unlink", { external_user_id: "U1" })]: () =>
        Response.json({ success: true, revoked: 1 }),
    });
    await expect(
      hostsOver(store, fetchImplementation).unlink(active, "U1"),
    ).resolves.toBe(true);
    expect(calls[0]?.headers[contracts.headers.host_key!]).toBe(KEY);
  });
});

describe("Datalayer's channel rules hold at the next mention (S-403)", () => {
  it("reads them again before routing each prompt, without App Home, and drops what Datalayer dropped", async () => {
    const store = new MemorySlackStore();
    await store.putInstallation({
      ...active,
      datalayerHostKey: KEY,
      datalayerHostUid: "inst-1",
    });
    let channels: Array<Record<string, string>> = [
      { id: "C1", state: "allow", deployment: "dep-2" },
    ];
    const { calls, fetchImplementation } = wire({
      [route("self")]: () =>
        Response.json({
          success: true,
          host: {
            uid: "inst-1",
            account_uid: "alice",
            state: "active",
            default_deployment: "dep-1",
            deployments: [
              { uid: "dep-1", app_name: "Launch Review", kept: true },
              { uid: "dep-2", app_name: "Desk", kept: true },
            ],
            channels,
            paused: false,
          },
        }),
    });
    const hosts = hostsOver(store, fetchImplementation);
    const links = Object.assign(new FakeLinks(), {
      refreshAllowances: (key: SlackInstallationKey) =>
        hosts.refreshAllowances(key),
    });
    const agents = new FakeAgents();
    const slack = new FakeSlack();
    const service = new SlackAgentService(store, agents, slack, WEB, links, {
      clock: new FakeClock(),
      logger: keptLogger().logger,
    });

    // allow → a deployment: the very next mention goes to it.
    await service.handlePrompt(promptOf(), "B1");
    expect(agents.requests.map((one) => one.applicationId)).toEqual(["dep-2"]);

    // A deny set at Datalayer refuses the next mention with the channel's sentence.
    channels = [{ id: "C1", state: "deny" }];
    await service.handlePrompt(
      promptOf({ eventId: "Ev2", threadTs: "2.0" }),
      "B1",
    );
    expect(agents.requests).toHaveLength(1);
    expect(slack.of("private").map((call) => call.message?.text ?? "")).toEqual(
      [expect.stringContaining("turned off in this channel")],
    );

    // The rule removed at Datalayer is gone here: the default answers again.
    channels = [];
    await service.handlePrompt(
      promptOf({ eventId: "Ev3", threadTs: "3.0" }),
      "B1",
    );
    expect(agents.requests.map((one) => one.applicationId)).toEqual([
      "dep-2",
      "dep-1",
    ]);
    await expect(store.getChannelBinding(active, "C1")).resolves.toBe(
      undefined,
    );
    expect(calls.filter((call) => call.key === route("self"))).toHaveLength(3);
  });
});
