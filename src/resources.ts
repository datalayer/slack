import type { InstallationStore } from "@slack/bolt";
import type { Pool } from "pg";

import type { SlackJob } from "./bolt.js";
import type { Config } from "./config.js";
import { SecretCipher } from "./crypto.js";
import { createDatabase } from "./database.js";
import { PostgresInstallationStore } from "./oauth-store.js";
import { PostgresWorkQueue } from "./postgres-queue.js";
import { PostgresSlackStore } from "./postgres-store.js";
import { MemoryWorkQueue, type WorkQueue } from "./queue.js";
import { MemorySlackStore, type SlackStore } from "./store.js";

export type RuntimeResources = Readonly<{
  close(): Promise<void>;
  installationStore?: InstallationStore;
  queue: WorkQueue<SlackJob>;
  store: SlackStore;
}>;

export function createRuntimeResources(config: Config): RuntimeResources {
  if (config.DATALAYER_SLACK_STORE === "memory") {
    const queue = new MemoryWorkQueue<SlackJob>();
    return {
      close: async () => queue.stop(),
      queue,
      store: new MemorySlackStore(),
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
  );
}

function postgresResources(
  database: Pool,
  cipher: SecretCipher,
  appId: string,
): RuntimeResources {
  const queue = new PostgresWorkQueue<SlackJob>(database);
  const store = new PostgresSlackStore(database, cipher);
  return {
    close: async () => {
      await queue.stop();
      await database.end();
    },
    installationStore: new PostgresInstallationStore(
      appId,
      database,
      cipher,
      store,
    ),
    queue,
    store,
  };
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
