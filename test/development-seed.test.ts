import { describe, expect, it } from "vitest";

import { HostRefusedError } from "@datalayer/agent-runtimes/lib/portable/hosts";
import { seedDevelopmentInstallation } from "../src/bolt.js";
import type { Config } from "../src/config.js";
import { deliverySinkOf } from "../src/deliveries.js";
import { MemorySlackStore } from "../src/store.js";

/**
 * The development app given a host key (S-301): bound as an install binds a
 * workspace, so the outbox poller reads its deliveries. Before, the key was
 * only a fallback for calls and the poller, which lists bound workspaces,
 * never polled it: no approval card could reach the development workspace.
 */

const KEY = "dlhk_the-development-key";

const config = (extra: Partial<Config> = {}): Config =>
  ({
    NODE_ENV: "development",
    DATALAYER_SLACK_APP_ID: "A1",
    DATALAYER_SLACK_TEAM_ID: "T1",
    DATALAYER_SLACK_BOT_TOKEN: "xoxb-development",
    DATALAYER_SLACK_BOT_USER_ID: "UBOT",
    ...extra,
  }) as Config;

const self = (uid: string) => ({
  calls: [] as string[],
  async self(hostKey: string) {
    this.calls.push(hostKey);
    return {
      accountUid: "owner",
      channels: [],
      deployments: [],
      directOnly: [],
      paused: false,
      uid,
    };
  },
});

describe("The development installation", () => {
  it("keeps the configured key and the installation's uid, so its deliveries are polled", async () => {
    const store = new MemorySlackStore();
    const client = self("host-1");
    await seedDevelopmentInstallation(
      config({ DATALAYER_HOST_KEY: KEY }),
      store,
      client,
    );
    expect(client.calls).toEqual([KEY]);
    const installation = await store.getInstallation({
      appId: "A1",
      teamId: "T1",
    });
    expect(installation?.datalayerHostKey).toBe(KEY);
    expect(installation?.datalayerHostUid).toBe("host-1");
    const sink = deliverySinkOf(store);
    expect(await sink.boundHosts()).toEqual([
      { hostKey: KEY, hostUid: "host-1" },
    ]);
    expect(await sink.hostKeyOf("host-1")).toBe(KEY);
  });

  it("without a key, is not bound and asks Datalayer nothing", async () => {
    const store = new MemorySlackStore();
    const client = self("host-1");
    await seedDevelopmentInstallation(config(), store, client);
    expect(client.calls).toEqual([]);
    const installation = await store.getInstallation({
      appId: "A1",
      teamId: "T1",
    });
    expect(installation?.status).toBe("active");
    expect(installation?.datalayerHostKey).toBeUndefined();
    expect(await deliverySinkOf(store).boundHosts()).toEqual([]);
  });

  it("stops the start when Datalayer refuses the key", async () => {
    const store = new MemorySlackStore();
    const refusing = {
      async self(): Promise<never> {
        throw new HostRefusedError(
          401,
          "Unknown host key.",
          "Datalayer did not answer the installation",
        );
      },
    };
    await expect(
      seedDevelopmentInstallation(
        config({ DATALAYER_HOST_KEY: KEY }),
        store,
        refusing,
      ),
    ).rejects.toBeInstanceOf(HostRefusedError);
    expect(
      await store.getInstallation({ appId: "A1", teamId: "T1" }),
    ).toBeUndefined();
  });

  it("is never seeded outside development", async () => {
    const store = new MemorySlackStore();
    const client = self("host-1");
    await seedDevelopmentInstallation(
      config({ NODE_ENV: "production" } as Partial<Config>),
      store,
      client,
    );
    expect(client.calls).toEqual([]);
    expect(
      await store.getInstallation({ appId: "A1", teamId: "T1" }),
    ).toBeUndefined();
  });
});
