import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import {
  bindCodeOf,
  bindCodeOfInstallation,
  SignedStateStore,
  startBoundInstall,
  STATE_COOKIE,
} from "../src/oauth-state.js";
import { MemorySlackStore } from "../src/store.js";

const SECRET = "a-state-secret-of-at-least-thirty-two-characters";
const CODE = "dlhc_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_xyz";

function response() {
  const headers: Record<string, unknown> = {};
  const sent = { body: "", status: 0 };
  const res = {
    end: (body: string) => {
      sent.body = body;
    },
    setHeader: (name: string, value: unknown) => {
      headers[name.toLowerCase()] = value;
    },
    writeHead: (status: number, more?: Record<string, unknown>) => {
      sent.status = status;
      Object.assign(headers, more ?? {});
    },
  } as unknown as ServerResponse;
  return { headers, res, sent };
}

describe("Slack OAuth state that carries the Ship card's bind code", () => {
  it("is signed, carries the install options and is spent once", async () => {
    const store = new MemorySlackStore();
    const states = new SignedStateStore(SECRET, (nonce) =>
      store.claimEvent(nonce),
    );
    const now = new Date();
    const state = await states.generateStateParam(
      {
        metadata: JSON.stringify({ datalayer_bind: CODE }),
        scopes: ["chat:write"],
      },
      now,
    );
    const options = await states.verifyStateParam(now, state);
    expect(bindCodeOfInstallation(options)).toBe(CODE);
    await expect(states.verifyStateParam(now, state)).rejects.toThrow(
      /already used/,
    );
  });

  it("refuses a forged, foreign or expired state", async () => {
    const states = new SignedStateStore(SECRET, async () => true);
    const now = new Date();
    const state = await states.generateStateParam({ scopes: [] }, now);
    const [payload] = state.split(".");
    await expect(
      states.verifyStateParam(now, `${payload}.forged`),
    ).rejects.toThrow(/signature/);
    await expect(
      new SignedStateStore(
        `${SECRET}-other`,
        async () => true,
      ).verifyStateParam(now, state),
    ).rejects.toThrow(/signature/);
    await expect(
      states.verifyStateParam(new Date(now.getTime() + 601_000), state),
    ).rejects.toThrow(/expired/);
  });

  it("reads only a well-formed bind code", () => {
    expect(bindCodeOf(`/slack/install?datalayer_bind=${CODE}`)).toBe(CODE);
    expect(bindCodeOf("/slack/install?datalayer_bind=dlhk_not-a-code")).toBe(
      undefined,
    );
    expect(bindCodeOf("/slack/install")).toBeUndefined();
    expect(bindCodeOfInstallation({ metadata: "not json" })).toBeUndefined();
  });

  it("redirects an install with the code to Slack, its state in a cookie", async () => {
    const store = new MemorySlackStore();
    const stateStore = new SignedStateStore(SECRET, (nonce) =>
      store.claimEvent(nonce),
    );
    const { headers, res, sent } = response();
    const proceed = await startBoundInstall(
      { url: `/slack/install?datalayer_bind=${CODE}` } as IncomingMessage,
      res,
      {
        clientId: "123.456",
        redirectUri: "https://slack.example/slack/oauth/callback",
        requireBind: true,
        scopes: ["app_mentions:read", "chat:write", "im:history"],
        stateStore,
        webUrl: "https://datalayer.ai",
      },
    );
    expect(proceed).toBe(false);
    expect(sent.status).toBe(302);
    const location = new URL(String(headers.location));
    expect(location.origin + location.pathname).toBe(
      "https://slack.com/oauth/v2/authorize",
    );
    expect(location.searchParams.get("scope")).toBe(
      "app_mentions:read,chat:write,im:history",
    );
    const state = location.searchParams.get("state")!;
    expect(String(headers["set-cookie"])).toContain(
      `${STATE_COOKIE}=${state};`,
    );
    expect(String(headers["set-cookie"])).toContain("HttpOnly");
    // The code is in the signed state, never in the URL Slack is sent to.
    expect(location.toString()).not.toContain(CODE);
    const options = await stateStore.verifyStateParam(new Date(), state);
    expect(bindCodeOfInstallation(options)).toBe(CODE);
  });

  it("refuses an install without a code outside development, and lets development go on", async () => {
    const stateStore = new SignedStateStore(SECRET, async () => true);
    const base = {
      clientId: "123.456",
      scopes: ["chat:write"],
      stateStore,
      webUrl: "https://datalayer.ai",
    };
    const refused = response();
    expect(
      await startBoundInstall(
        { url: "/slack/install" } as IncomingMessage,
        refused.res,
        { ...base, requireBind: true },
      ),
    ).toBe(false);
    expect(refused.sent.status).toBe(400);
    expect(refused.sent.body).toContain("Ship tab");
    const development = response();
    expect(
      await startBoundInstall(
        { url: "/slack/install" } as IncomingMessage,
        development.res,
        { ...base, requireBind: false },
      ),
    ).toBe(true);
  });
});
