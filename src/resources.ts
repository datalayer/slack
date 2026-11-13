import {
  MemoryWorkQueue,
  SecretCipher,
  type WorkQueue,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import type { SlackJob } from "./bolt.js";
import type { Config } from "./config.js";
import type { HostInstallations } from "./host-installations.js";
import { SolrInstallationStore } from "./oauth-store.js";
import { SolrClient } from "./solr/client.js";
import { SolrWorkQueue } from "./solr/queue.js";
import { SolrRecords } from "./solr/records.js";
import { SolrSlackStore } from "./solr-store.js";
import { MemorySlackStore, type SlackStore } from "./store.js";

export type RuntimeResources = Readonly<{
  close(): Promise<void>;
  /** Whether the store answers now: what readiness reports. */
  ready(): Promise<boolean>;
  hosts: HostInstallations;
  installationStore?: SolrInstallationStore;
  queue: WorkQueue<SlackJob>;
  store: SlackStore;
}>;

/** The installations as Datalayer hosts, over the store the resources open. */
export type HostsOf = (store: SlackStore) => HostInstallations;

/** The service's Solr collection, from its settings. */
export function solrRecordsOf(
  config: Pick<
    Config,
    | "DATALAYER_SOLR_URL"
    | "DATALAYER_SOLR_USERNAME"
    | "DATALAYER_SOLR_PASSWORD"
    | "DATALAYER_SLACK_SOLR_COLLECTION"
  >,
): SolrRecords {
  return new SolrRecords(
    new SolrClient({
      collection: config.DATALAYER_SLACK_SOLR_COLLECTION,
      password: required(
        config.DATALAYER_SOLR_PASSWORD,
        "DATALAYER_SOLR_PASSWORD",
      ),
      url: required(config.DATALAYER_SOLR_URL, "DATALAYER_SOLR_URL"),
      username: required(
        config.DATALAYER_SOLR_USERNAME,
        "DATALAYER_SOLR_USERNAME",
      ),
    }),
  );
}

/**
 * The store and the queue: in memory for development and tests, in the
 * service's Solr collection otherwise (`DATALAYER_SLACK_STORE=solr`, which
 * production requires). Its lock documents are made before it serves.
 */
export async function createRuntimeResources(
  config: Config,
  hostsOf: HostsOf,
): Promise<RuntimeResources> {
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

  const cipher = new SecretCipher(
    required(
      config.DATALAYER_SLACK_TOKEN_ENCRYPTION_KEY,
      "DATALAYER_SLACK_TOKEN_ENCRYPTION_KEY",
    ),
    config.DATALAYER_SLACK_TOKEN_ENCRYPTION_KEY_VERSION,
    "DATALAYER_SLACK_TOKEN_ENCRYPTION_KEY",
  );
  const records = solrRecordsOf(config);
  await records.init();
  const queue = new SolrWorkQueue<SlackJob>(records);
  const store = new SolrSlackStore(records, cipher);
  const hosts = hostsOf(store);
  return {
    close: async () => queue.stop(),
    hosts,
    ready: async () => records.client.ready(),
    installationStore: new SolrInstallationStore(
      required(config.DATALAYER_SLACK_APP_ID, "DATALAYER_SLACK_APP_ID"),
      records,
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
