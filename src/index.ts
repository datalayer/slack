import {
  DevelopmentCredentials,
  HostKeyCredentials,
  HostStarters,
  HttpAgentClient,
  InstallationCredentials,
  type HostKeyLookup,
} from "./agent-client.js";
import { BotTokens, slackTokenRefresh } from "./bot-tokens.js";
import {
  BoltSlackPort,
  createBoltApp,
  oauthConfigured,
  registerSlackListeners,
  seedDevelopmentInstallation,
} from "./bolt.js";
import { deliveryUrlOf, readConfig } from "./config.js";
import {
  DELIVERY_ROUTE,
  DeliveryHandler,
  DeliveryPoller,
  deliveryRoute,
  type DeliveryJob,
} from "./deliveries.js";
import { healthRoutes, healthServer } from "./health.js";
import { Logger, LogTracer } from "./observability.js";
import { DatalayerHostClient } from "./host-client.js";
import { HostInstallations } from "./host-installations.js";
import { SignedStateStore } from "./oauth-state.js";
import { createRuntimeResources } from "./resources.js";
import { SlackAgentService } from "./service.js";

async function main(): Promise<void> {
  const config = readConfig();
  const client = new DatalayerHostClient(config.DATALAYER_API_URL);
  const resources = createRuntimeResources(config, (store) => {
    return new HostInstallations(store, client, {
      deliveryUrlOf: (hostUid) => deliveryUrlOf(config, hostUid),
      developmentHostKey:
        config.NODE_ENV === "development"
          ? config.DATALAYER_HOST_KEY
          : undefined,
      logger: console,
      webUrl: config.DATALAYER_WEB_URL,
    });
  });
  const { hosts, queue, store } = resources;
  await seedDevelopmentInstallation(config, store);

  // Each workspace's own key; the single configured key only in development.
  const hostKeyFor: HostKeyLookup = async (request) =>
    hosts.hostKeyOf(request.provenance);
  const keyed = new HostKeyCredentials(config.DATALAYER_API_URL, hostKeyFor);
  const credentials = new InstallationCredentials(
    keyed,
    config.NODE_ENV === "development" && config.DATALAYER_DEV_HOST_TOKEN
      ? new DevelopmentCredentials(
          config.DATALAYER_API_URL,
          config.DATALAYER_DEV_HOST_TOKEN,
        )
      : undefined,
  );
  const agents = new HttpAgentClient(
    config.DATALAYER_API_URL,
    credentials,
    fetch,
    hostKeyFor,
  );

  // A delivery is enqueued once by its uid, pushed or polled.
  const enqueueDelivery = async (job: DeliveryJob): Promise<void> => {
    await queue.enqueue(
      job,
      `delivery:${job.hostUid}:${job.delivery.delivery}`,
    );
  };
  const app = createBoltApp(config, {
    customRoutes: [
      ...healthRoutes({
        database: resources.ready,
        queue: () => queue.ready(),
      }),
      {
        handler: (request, response) =>
          void deliveryRoute(store, enqueueDelivery)(request, response),
        method: ["POST"],
        path: DELIVERY_ROUTE,
      },
    ],
    installationStore: resources.installationStore,
    stateStore:
      oauthConfigured(config) && config.SLACK_STATE_SECRET
        ? new SignedStateStore(config.SLACK_STATE_SECRET, (nonce) =>
            store.claimEvent(nonce),
          )
        : undefined,
  });
  // Rotating bot tokens (staging and production manifests) are refreshed
  // before a worker post, even when no inbound event refreshed them (S-102).
  const installationStore = resources.installationStore;
  const tokens = new BotTokens(store, {
    refresh:
      config.SLACK_CLIENT_ID && config.SLACK_CLIENT_SECRET
        ? slackTokenRefresh(
            app.client,
            config.SLACK_CLIENT_ID,
            config.SLACK_CLIENT_SECRET,
          )
        : undefined,
    rotated: installationStore
      ? (key, installation) => installationStore.rotateBot(key, installation)
      : undefined,
  });
  const slack = new BoltSlackPort(app.client, store, {
    streaming: config.DATALAYER_SLACK_STREAMING,
    tokens,
  });
  const service = new SlackAgentService(
    store,
    agents,
    slack,
    config.DATALAYER_WEB_URL,
    hosts,
    {
      events: config.DATALAYER_SLACK_EVENTS,
      quotas: {
        application: config.DATALAYER_SLACK_QUOTA_APPLICATION,
        organization: config.DATALAYER_SLACK_QUOTA_ORGANIZATION,
        user: config.DATALAYER_SLACK_QUOTA_USER,
        workspace: config.DATALAYER_SLACK_QUOTA_WORKSPACE,
      },
      // *Open in Datalayer*: a one-use handoff to the exact session (S-305).
      openUrlOf: async (sessionId, request) => {
        const exchanged = await keyed.exchange(request);
        const opened = await client.handoff(
          exchanged.access_token,
          "session",
          sessionId,
        );
        return `${config.DATALAYER_WEB_URL.replace(/\/+$/, "")}${opened.path}`;
      },
    },
  );
  const deliveries = new DeliveryHandler(
    store,
    client,
    keyed,
    // Cards and their updates wait out a 429 like every other post (S-206).
    service.slack,
    config.DATALAYER_WEB_URL,
  );
  const role = config.DATALAYER_SLACK_ROLE;
  registerSlackListeners(app, config, service, queue, {
    consume: role !== "ingress",
    starters: new HostStarters(config.DATALAYER_API_URL, keyed, (key) =>
      hosts.hostKeyOf(key),
    ),
    tracer: new LogTracer(new Logger()),
    deliveries,
    hosts,
    tokens,
  });
  const poller = new DeliveryPoller(store, client, enqueueDelivery);

  // A worker serves only its health; Slack's requests reach the ingress.
  const health =
    role === "worker"
      ? healthServer({
          database: resources.ready,
          queue: () => queue.ready(),
        }).listen(config.PORT)
      : undefined;
  if (role !== "worker") await app.start(config.PORT);
  if (role !== "ingress") poller.start(config.DATALAYER_DELIVERY_POLL_SECONDS);
  app.logger.info(
    `@Datalayer Slack (${role}) is listening on ${config.PORT} (${config.DATALAYER_SLACK_TRANSPORT}).`,
  );

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    poller.stop();
    health?.close();
    if (role !== "worker") await app.stop();
    await resources.close();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
