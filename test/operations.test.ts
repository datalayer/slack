import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createBoltApp, BOT_SCOPES } from "../src/bolt.js";
import { readConfig } from "../src/config.js";
import {
  healthRoutes,
  healthServer,
  readiness,
  timestampWithinWindow,
} from "../src/health.js";
import {
  Logger,
  LogTracer,
  pseudonym,
  redact,
  REDACTED,
  traceAttributes,
} from "../src/observability.js";

describe("health and readiness (S-101)", () => {
  it("is ready only when the store and the queue answer, never asking Slack or Datalayer", async () => {
    await expect(
      readiness({ database: async () => true, queue: async () => true }),
    ).resolves.toEqual({
      checks: { database: true, queue: true },
      ready: true,
    });
    await expect(
      readiness({ database: async () => false, queue: async () => true }),
    ).resolves.toMatchObject({
      ready: false,
    });
    await expect(
      readiness({
        database: async () => {
          throw new Error("down");
        },
        queue: async () => true,
      }),
    ).resolves.toMatchObject({ checks: { database: false }, ready: false });
    // A check that hangs is not ready, within its timeout.
    await expect(
      readiness({ database: () => new Promise<boolean>(() => undefined) }, 20),
    ).resolves.toMatchObject({ ready: false });
  });

  it("serves /healthz and /readyz", () => {
    expect(healthRoutes({}).map((route) => route.path)).toEqual([
      "/healthz",
      "/readyz",
    ]);
  });

  it("refuses a request timestamp five minutes away either way", () => {
    const now = 1_700_000_000;
    expect(timestampWithinWindow(String(now - 299), now)).toBe(true);
    expect(timestampWithinWindow(String(now + 299), now)).toBe(true);
    expect(timestampWithinWindow(String(now - 301), now)).toBe(false);
    expect(timestampWithinWindow(String(now + 301), now)).toBe(false);
    expect(timestampWithinWindow(undefined, now)).toBe(false);
    expect(timestampWithinWindow("soon", now)).toBe(false);
  });

  it("guards the receiver of the app it builds for HTTP", () => {
    const app = createBoltApp(
      readConfig({
        NODE_ENV: "test",
        SLACK_CLIENT_ID: "1.2",
        SLACK_CLIENT_SECRET: "client-secret",
        SLACK_REDIRECT_URI: "https://slack.example/slack/oauth/callback",
        SLACK_SIGNING_SECRET: "signing-secret",
        SLACK_STATE_SECRET: "s".repeat(32),
      }),
    );
    const receiver = (
      app as unknown as { receiver: { requestListener: { name: string } } }
    ).receiver;
    expect(receiver.requestListener.name).not.toBe(
      "bound unboundRequestListener",
    );
  });
});

describe("redacted logs and pseudonymous traces (S-101, §9)", () => {
  const secrets = {
    // Split so that a secret scanner does not take the fixture for a token.
    authorization: `Bearer ${"eyJ"}hbGciOiJIUzI1NiJ9.${"eyJ"}zdWIiOiJhbGljZSJ9.c2lnbmF0dXJl`,
    bot: "xoxb-123456789012-abcdefghijkl",
    code: "dlhc_abcdefghijklmnop",
    host_key: "dlhk_abcdefghijklmnop",
    prompt: "my salary is 100k",
    text: "the words someone wrote",
  };

  it("never writes tokens, codes, keys or words", () => {
    const lines: string[] = [];
    const logger = new Logger((line) => lines.push(line));
    logger.info("turn.started", {
      ...secrets,
      nested: {
        body: "a body",
        deeper: { value: "xapp-1-AZZ-zzz-abcdefabcdef" },
      },
      note: `failed with ${secrets.bot} and ${secrets.host_key}`,
      error: new Error(`refused ${secrets.authorization}`),
    });
    logger.audit("identity.linked", {
      installation: "A1:-:T1",
      slackUser: "U123",
      reason: "person",
    });
    const output = lines.join("\n");
    for (const value of [
      ...Object.values(secrets),
      "xapp-1-AZZ-zzz-abcdefabcdef",
      "a body",
      "hbGciOiJIUzI1NiJ9",
      "U123",
      "A1:-:T1",
    ])
      expect(output).not.toContain(value);
    expect(output).toContain(REDACTED);
    expect(output).toContain(pseudonym("U123"));
  });

  it("redacts nested arrays and errors", () => {
    expect(redact([{ token: "x" }, "xoxb-123456789012-abc"])).toEqual([
      { token: REDACTED },
      REDACTED,
    ]);
  });

  it("traces with pseudonymous attributes and no words", async () => {
    const lines: string[] = [];
    let now = 0;
    const tracer = new LogTracer(
      new Logger((line) => lines.push(line)),
      () => (now += 5),
    );
    await tracer.span(
      "slack.turn",
      {
        ...traceAttributes({ appId: "A1", channelId: "C1", teamId: "T1" }),
        job: 3,
      },
      async () => undefined,
    );
    const span = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(span).toMatchObject({
      event: "span",
      job: 3,
      name: "slack.turn",
      outcome: "ok",
    });
    expect(lines[0]).not.toContain("C1");
    expect(span["datalayer.slack.installation"]).toBe(pseudonym("A1:-:T1"));
  });
});

describe("the manifests (S-006, S-107)", () => {
  const manifest = (name: string) =>
    readFileSync(new URL(`../manifests/${name}.yaml`, import.meta.url), "utf8");

  /** The bot scopes a manifest requests, and whether it requests any user scope. */
  function scopesOf(text: string): { bot: string[]; user: boolean } {
    const lines = text.split("\n");
    const start = lines.findIndex((line) => /^\s+bot:\s*$/.test(line));
    const bot: string[] = [];
    for (const line of lines.slice(start + 1)) {
      const item = /^\s+-\s+(\S+)\s*$/.exec(line);
      if (!item) break;
      bot.push(item[1] ?? "");
    }
    return { bot, user: lines.some((line) => /^\s+user:\s*$/.test(line)) };
  }

  it.each(["development", "staging", "production"])(
    "%s requests exactly the baseline bot scopes and no user scope",
    (name) => {
      const text = manifest(name);
      expect(scopesOf(text)).toEqual({ bot: [...BOT_SCOPES], user: false });
      expect(text).not.toContain("chat:write.public");
      expect(text).not.toMatch(
        /history:\s*$|channels:history|groups:history|mpim:history|files:|search:read|users:read/m,
      );
    },
  );

  it("asks OAuth for the same scopes the manifest grants", () => {
    expect(BOT_SCOPES).toEqual([
      "app_mentions:read",
      "chat:write",
      "im:history",
    ]);
  });

  it("subscribes only to the events the service handles", () => {
    const text = manifest("production");
    const events = [
      ...text.matchAll(/^\s+-\s+(app_\w+|message\.im|tokens_revoked)\s*$/gm),
    ].map((match) => match[1]);
    expect(events).toEqual([
      "app_home_opened",
      "app_mention",
      "app_uninstalled",
      "message.im",
      "tokens_revoked",
    ]);
  });

  it("uses Socket Mode only in development and rotates tokens elsewhere", () => {
    expect(manifest("development")).toContain("socket_mode_enabled: true");
    for (const name of ["staging", "production"]) {
      expect(manifest(name)).toContain("socket_mode_enabled: false");
      expect(manifest(name)).toContain("token_rotation_enabled: true");
    }
  });
});

describe("the guide, linked where people meet @Datalayer (S-108)", () => {
  it("links /docs/slack from the OAuth success and failure pages", () => {
    const source = readFileSync(
      new URL("../src/bolt.ts", import.meta.url),
      "utf8",
    );
    const pages = [
      ...source.matchAll(
        /page\(\s*"@Datalayer (is installed|was not installed)"[\s\S]*?\),\s*\);/g,
      ),
    ];
    expect(pages.map((one) => one[1])).toEqual([
      "is installed",
      "was not installed",
    ]);
    for (const [page] of pages) expect(page).toContain("/docs/slack");
  });
});

describe("ingress and workers scaled apart (§10, A-17)", () => {
  it("defaults to one process doing both, and needs the durable store to split", () => {
    expect(
      readConfig({ NODE_ENV: "test", SLACK_SIGNING_SECRET: "x" })
        .DATALAYER_SLACK_ROLE,
    ).toBe("all");
    expect(() =>
      readConfig({
        DATALAYER_SLACK_ROLE: "worker",
        NODE_ENV: "test",
        SLACK_SIGNING_SECRET: "x",
      }),
    ).toThrow(/durable queue/);
  });

  it("serves a worker's health and readiness, nothing else", async () => {
    const server = healthServer({
      database: async () => true,
      queue: async () => false,
    }).listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(
        200,
      );
      const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({
        checks: { database: true, queue: false },
        ready: false,
      });
      expect(
        (
          await fetch(`http://127.0.0.1:${port}/slack/events`, {
            method: "POST",
          })
        ).status,
      ).toBe(404);
    } finally {
      server.close();
    }
  });
});
