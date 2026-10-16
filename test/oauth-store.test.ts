import { randomBytes } from "node:crypto";

import type { Installation } from "@slack/bolt";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { SecretCipher } from "@datalayer/agent-runtimes/lib/portable/hosts";
import { PostgresInstallationStore } from "../src/oauth-store.js";
import { MemorySlackStore } from "../src/store.js";

describe("PostgreSQL OAuth installation store", () => {
  it("encrypts and round-trips a Bolt installation while mirroring the bot", async () => {
    let encrypted: unknown;
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes("INSERT INTO slack_oauth_installations"))
        encrypted = values?.[3];
      if (sql.includes("SELECT installation"))
        return { rows: [{ installation: encrypted }] };
      return { rowCount: 1, rows: [] };
    });
    const database = { query } as unknown as Pool;
    const domainStore = new MemorySlackStore();
    const store = new PostgresInstallationStore(
      "A1",
      database,
      new SecretCipher(randomBytes(32).toString("base64"), 1),
      domainStore,
    );
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
      team: { id: "T1", name: "Test" },
      tokenType: "bot",
      user: { id: "U1", scopes: undefined, token: undefined },
    };

    await store.storeInstallation(installation);
    expect(JSON.stringify(encrypted)).not.toContain("xoxb-test-value");
    await expect(
      store.fetchInstallation({
        enterpriseId: undefined,
        isEnterpriseInstall: false,
        teamId: "T1",
      }),
    ).resolves.toEqual(installation);
    await expect(
      domainStore.getInstallation({ appId: "A1", teamId: "T1" }),
    ).resolves.toMatchObject({
      botToken: "xoxb-test-value",
      installedBy: "U1",
    });
  });

  it("refuses deferred Enterprise Grid installations", async () => {
    const store = new PostgresInstallationStore(
      "A1",
      { query: vi.fn() } as unknown as Pool,
      new SecretCipher(randomBytes(32).toString("base64"), 1),
      new MemorySlackStore(),
    );
    await expect(
      store.storeInstallation({
        appId: "A1",
        authVersion: "v2",
        enterprise: { id: "E1" },
        isEnterpriseInstall: true,
        team: undefined,
        user: { id: "U1", scopes: undefined, token: undefined },
      }),
    ).rejects.toThrow(/Enterprise Grid/);
  });
});
