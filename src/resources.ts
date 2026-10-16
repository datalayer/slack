import type { Pool } from "pg";

import type { SlackJob } from "./bolt.js";
import type { Config } from "./config.js";
import { SecretCipher } from "./crypto.js";
import { createDatabase } from "./database.js";
import type { HostInstallations } from "./host-installations.js";
import { PostgresInstallationStore } from "./oauth-store.js";
import { PostgresWorkQueue } from "./postgres-queue.js";
import { PostgresSlackStore } from "./postgres-store.js";
import { MemoryWorkQueue, type WorkQueue } from "./queue.js";
import { MemorySlackStore, type SlackStore } from "./store.js";

export type RuntimeResources = Readonly<{
  close(): Promise<void>;
  /** Whether the store answers now: what readiness reports. */
  ready(): Promise<boolean>;
  hosts: HostInstallations;
  installationStore?: PostgresInstallationStore;
  queue: WorkQueue<SlackJob>;
  store: SlackStore;
}>;

/** The installations as Datalayer hosts, over the store the resources open. */
export type HostsOf = (store: SlackStore) => HostInstallations;

export function createRuntimeResources(
  config: Config,
  hostsOf: HostsOf,
): RuntimeResources {
  if (config.DATALAYER_SLACK_STORE === "memory") {
    const queue = new MemoryWorkQueue<SlackJob>();
    const store = new MemorySlackStore();
    return {
      close: async () => queue.stop(),
      hosts: hostsOf(store),
      ready: async () => true,
      queue,
      store,
    };
  }

  const database = createDatabase(
    required(config.DATABASE_URL, "DATABASE_URL"),
  );
  const cipher = new SecretCipher(
    required(config.SLACK_TOKEN_ENCRYPTION_KEY, "SLACK_TOKEN_ENCRYPTION_KEY"),
    config.SLACK_TOKEN_ENCRYPTION_KEY_VERSION,
  );
  return postgresResources(
    database,
    cipher,
    required(config.SLACK_APP_ID, "SLACK_APP_ID"),
    hostsOf,
  );
}

function postgresResources(
  database: Pool,
  cipher: SecretCipher,
  appId: string,
  hostsOf: HostsOf,
): RuntimeResources {
  const queue = new PostgresWorkQueue<SlackJob>(database);
  const store = new PostgresSlackStore(database, cipher);
  const hosts = hostsOf(store);
  return {
    close: async () => {
      await queue.stop();
      await database.end();
    },
    hosts,
    ready: async () => {
      try {
        await database.query("SELECT 1");
        return true;
      } catch {
        return false;
      }
    },
    installationStore: new PostgresInstallationStore(
      appId,
      database,
      cipher,
      store,
      hosts,
    ),
    queue,
    store,
  };
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
