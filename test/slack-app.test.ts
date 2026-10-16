import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  apply,
  createdEntries,
  deployEntries,
  exportOf,
  rotate,
  SlackApiError,
  withExports,
  type Fetch,
} from "../scripts/slack-app.js";

type Call = { method: string; params: URLSearchParams; auth: string | null };

/** A fake Slack API: records each call, answers from the table. */
function fakeSlack(answers: Record<string, Record<string, unknown>>) {
  const calls: Call[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = url.split("/api/")[1] ?? "";
    const headers = new Headers(init?.headers);
    calls.push({
      method,
      params: new URLSearchParams(
        typeof init?.body === "string" ? init.body : "",
      ),
      auth: headers.get("authorization"),
    });
    return new Response(
      JSON.stringify(answers[method] ?? { ok: false, error: "unknown_method" }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  };
  return { calls, fetchImpl };
}

const manifest = () =>
  readFile(new URL("../manifests/development.yaml", import.meta.url), "utf8");

describe("the configuration token", () => {
  it("rotates with the refresh token alone and answers both new tokens", async () => {
    const { calls, fetchImpl } = fakeSlack({
      "tooling.tokens.rotate": {
        ok: true,
        token: "xoxe.xoxp-new",
        refresh_token: "xoxe-new",
      },
    });
    await expect(rotate(fetchImpl, "xoxe-old")).resolves.toEqual({
      token: "xoxe.xoxp-new",
      refreshToken: "xoxe-new",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params.get("refresh_token")).toBe("xoxe-old");
    expect(calls[0]?.auth).toBeNull();
  });

  it("fails on Slack's refusal, naming the method", async () => {
    const { fetchImpl } = fakeSlack({
      "tooling.tokens.rotate": { ok: false, error: "invalid_refresh_token" },
    });
    await expect(rotate(fetchImpl, "spent")).rejects.toThrow(
      "tooling.tokens.rotate: invalid_refresh_token",
    );
  });
});

describe("apply", () => {
  it("validates, then creates and answers the credentials once", async () => {
    const { calls, fetchImpl } = fakeSlack({
      "apps.manifest.validate": { ok: true },
      "apps.manifest.create": {
        ok: true,
        app_id: "A123",
        oauth_authorize_url:
          "https://slack.com/oauth/v2/authorize?client_id=1.2",
        credentials: {
          client_id: "1.2",
          client_secret: "cs",
          signing_secret: "ss",
          verification_token: "vt",
        },
      },
    });
    const outcome = await apply(
      fetchImpl,
      "xoxe.xoxp-t",
      "development",
      await manifest(),
      undefined,
    );
    expect(calls.map((one) => one.method)).toEqual([
      "apps.manifest.validate",
      "apps.manifest.create",
    ]);
    expect(calls.every((one) => one.auth === "Bearer xoxe.xoxp-t")).toBe(true);
    const sent = JSON.parse(calls[1]?.params.get("manifest") ?? "{}") as {
      display_information?: { name?: string };
    };
    expect(sent.display_information?.name).toBe("Datalayer Dev");
    expect(outcome).toMatchObject({
      appId: "A123",
      action: "created",
      credentials: { client_secret: "cs", signing_secret: "ss" },
    });
  });

  it("updates the app the rc names and asks no credentials", async () => {
    const { calls, fetchImpl } = fakeSlack({
      "apps.manifest.validate": { ok: true },
      "apps.manifest.update": { ok: true },
    });
    const outcome = await apply(
      fetchImpl,
      "t",
      "development",
      await manifest(),
      "A123",
    );
    expect(calls.map((one) => one.method)).toEqual([
      "apps.manifest.validate",
      "apps.manifest.update",
    ]);
    expect(calls[1]?.params.get("app_id")).toBe("A123");
    expect(outcome).toEqual({
      env: "development",
      appId: "A123",
      action: "updated",
    });
  });

  it("stops at an invalid manifest before creating anything", async () => {
    const { calls, fetchImpl } = fakeSlack({
      "apps.manifest.validate": {
        ok: false,
        error: "invalid_manifest",
        errors: [{ message: "bad", pointer: "/x" }],
      },
    });
    await expect(
      apply(fetchImpl, "t", "development", await manifest(), undefined),
    ).rejects.toBeInstanceOf(SlackApiError);
    expect(calls.map((one) => one.method)).toEqual(["apps.manifest.validate"]);
  });

  it("refuses a create answered without credentials", async () => {
    const { fetchImpl } = fakeSlack({
      "apps.manifest.validate": { ok: true },
      "apps.manifest.create": { ok: true, app_id: "A1" },
    });
    await expect(
      apply(fetchImpl, "t", "development", await manifest(), undefined),
    ).rejects.toThrow("no_credentials_in_answer");
  });
});

describe("the rc", () => {
  const rc = "# rc\nexport A=1\nexport DATALAYER_SLACK_CONFIG_TOKEN='old'\n";

  it("replaces an export in place and appends a new one, single-quoted", () => {
    const out = withExports(rc, {
      DATALAYER_SLACK_CONFIG_TOKEN: "new",
      DATALAYER_SLACK_DEVELOPMENT_APP_ID: "A1",
    });
    expect(out).toBe(
      "# rc\nexport A=1\nexport DATALAYER_SLACK_CONFIG_TOKEN='new'\nexport DATALAYER_SLACK_DEVELOPMENT_APP_ID='A1'\n",
    );
    expect(exportOf(out, "DATALAYER_SLACK_CONFIG_TOKEN")).toBe("new");
    expect(exportOf(out, "A")).toBe("1");
    expect(exportOf(out, "MISSING")).toBeUndefined();
  });

  it("refuses a value with a quote and a name that is not an rc name", () => {
    expect(() => withExports(rc, { X: "a'b" })).toThrow("a quote");
    expect(() => withExports(rc, { "x-y": "1" })).toThrow("not an rc name");
  });

  it("names a created app's entries by environment", () => {
    expect(
      Object.keys(
        createdEntries("staging", "A9", {
          client_id: "c",
          client_secret: "s",
          signing_secret: "g",
        }),
      ),
    ).toEqual([
      "DATALAYER_SLACK_STAGING_APP_ID",
      "DATALAYER_SLACK_STAGING_CLIENT_ID",
      "DATALAYER_SLACK_STAGING_CLIENT_SECRET",
      "DATALAYER_SLACK_STAGING_SIGNING_SECRET",
    ]);
  });
});

describe("deploying an app to the chart", () => {
  const credentials = {
    client_id: "1.2",
    client_secret: "cs",
    signing_secret: "ss",
  };

  it("takes a created app's secrets for the Secret and its ids for the r1 rc", () => {
    expect(deployEntries("staging", "", "A9", credentials)).toEqual({
      secret: { SLACK_SIGNING_SECRET: "ss", SLACK_CLIENT_SECRET: "cs" },
      ids: { SLACK_APP_ID: "A9", SLACK_CLIENT_ID: "1.2" },
    });
  });

  it("takes an updated app's from what the rc saved at its creation", () => {
    const rc = withExports("", createdEntries("staging", "A9", credentials));
    expect(deployEntries("staging", rc, "A9")).toEqual(
      deployEntries("staging", "", "A9", credentials),
    );
  });

  it("fails naming what the rc lacks, never another environment's", () => {
    const rc = withExports(
      "",
      createdEntries("development", "A1", credentials),
    );
    expect(() => deployEntries("staging", rc, "A9")).toThrow(
      "DATALAYER_SLACK_STAGING_CLIENT_ID, DATALAYER_SLACK_STAGING_CLIENT_SECRET, DATALAYER_SLACK_STAGING_SIGNING_SECRET not in the rc",
    );
  });
});
