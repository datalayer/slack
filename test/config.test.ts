import { describe, expect, it } from "vitest";

import { readConfig } from "../src/config.js";

describe("configuration", () => {
  it("requires a Socket Mode app token", () => {
    expect(() =>
      readConfig({ NODE_ENV: "test", DATALAYER_SLACK_TRANSPORT: "socket" }),
    ).toThrow(/SLACK_APP_TOKEN/);
  });

  it("requires a signing secret for HTTP", () => {
    expect(() =>
      readConfig({ NODE_ENV: "test", DATALAYER_SLACK_TRANSPORT: "http" }),
    ).toThrow(/SLACK_SIGNING_SECRET/);
  });

  it("refuses development credentials and memory storage in production", () => {
    expect(() =>
      readConfig({
        NODE_ENV: "production",
        DATALAYER_DEV_HOST_TOKEN: "secret",
        DATALAYER_SLACK_STORE: "memory",
        DATALAYER_SLACK_TRANSPORT: "http",
        SLACK_SIGNING_SECRET: "signing-secret",
      }),
    ).toThrow(/durable installation|development host token/);
  });

  it("requires a database and encryption key for PostgreSQL", () => {
    expect(() =>
      readConfig({
        DATALAYER_SLACK_STORE: "postgres",
        DATALAYER_SLACK_TRANSPORT: "http",
        NODE_ENV: "test",
        SLACK_SIGNING_SECRET: "signing-secret",
      }),
    ).toThrow(/DATABASE_URL|SLACK_TOKEN_ENCRYPTION_KEY/);
  });
});
