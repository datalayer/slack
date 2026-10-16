import { describe, expect, it } from "vitest";

import { deliveryUrlOf, readConfig } from "../src/config.js";

describe("configuration", () => {
  it("requires a Socket Mode app token", () => {
    expect(() =>
      readConfig({ NODE_ENV: "test", DATALAYER_SLACK_TRANSPORT: "socket" }),
    ).toThrow(/DATALAYER_SLACK_APP_TOKEN/);
  });

  it("requires a signing secret for HTTP", () => {
    expect(() =>
      readConfig({ NODE_ENV: "test", DATALAYER_SLACK_TRANSPORT: "http" }),
    ).toThrow(/DATALAYER_SLACK_SIGNING_SECRET/);
  });

  it("refuses development credentials and memory storage in production", () => {
    expect(() =>
      readConfig({
        NODE_ENV: "production",
        DATALAYER_DEV_HOST_TOKEN: "secret",
        DATALAYER_SLACK_STORE: "memory",
        DATALAYER_SLACK_TRANSPORT: "http",
        DATALAYER_SLACK_SIGNING_SECRET: "signing-secret",
      }),
    ).toThrow(/durable installation|development host token/);
  });

  it("requires a database and encryption key for PostgreSQL", () => {
    expect(() =>
      readConfig({
        DATALAYER_SLACK_STORE: "postgres",
        DATALAYER_SLACK_TRANSPORT: "http",
        NODE_ENV: "test",
        DATALAYER_SLACK_SIGNING_SECRET: "signing-secret",
      }),
    ).toThrow(/DATABASE_URL|DATALAYER_SLACK_TOKEN_ENCRYPTION_KEY/);
  });

  it("keeps one host key for every workspace to development", () => {
    expect(() =>
      readConfig({
        DATALAYER_HOST_KEY: "dlhk_shared",
        DATALAYER_SLACK_TRANSPORT: "http",
        NODE_ENV: "test",
        DATALAYER_SLACK_SIGNING_SECRET: "signing-secret",
      }),
    ).toThrow(/development shortcut/);
    expect(
      readConfig({
        DATALAYER_HOST_KEY: "dlhk_shared",
        DATALAYER_SLACK_TRANSPORT: "http",
        NODE_ENV: "development",
        DATALAYER_SLACK_SIGNING_SECRET: "signing-secret",
      }).DATALAYER_HOST_KEY,
    ).toBe("dlhk_shared");
  });

  it("is pushed deliveries at its public HTTPS origin, else reads the outbox", () => {
    expect(
      deliveryUrlOf(
        {
          DATALAYER_SLACK_REDIRECT_URI:
            "https://slack.datalayer.ai/slack/oauth/callback",
        },
        "inst-1",
      ),
    ).toBe("https://slack.datalayer.ai/datalayer/deliveries/inst-1");
    expect(
      deliveryUrlOf(
        {
          DATALAYER_SLACK_PUBLIC_URL: "https://hooks.example",
          DATALAYER_SLACK_REDIRECT_URI:
            "https://slack.datalayer.ai/slack/oauth/callback",
        },
        "inst-1",
      ),
    ).toBe("https://hooks.example/datalayer/deliveries/inst-1");
    expect(
      deliveryUrlOf(
        { DATALAYER_SLACK_REDIRECT_URI: "http://localhost:3000/x" },
        "i",
      ),
    ).toBeUndefined();
    expect(deliveryUrlOf({}, "i")).toBeUndefined();
  });
});
