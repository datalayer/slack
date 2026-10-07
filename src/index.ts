import {
  DevelopmentCredentials,
  HostKeyCredentials,
  HttpAgentClient,
  InstallationCredentials,
  type HostKeyLookup,
} from "./agent-client.js";
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
} from "./deliveries.js";
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

  const enqueueDelivery = (job: Parameters<typeof queue.enqueue>[0]) =>
    queue.enqueue(job);
  const app = createBoltApp(config, {
    customRoutes: [
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
  const slack = new BoltSlackPort(app.client, store);
  const service = new SlackAgentService(
    store,
    agents,
    slack,
    config.DATALAYER_WEB_URL,
    hosts,
  );
  const deliveries = new DeliveryHandler(
    store,
    client,
    keyed,
    slack,
    config.DATALAYER_WEB_URL,
  );
  registerSlackListeners(app, config, service, queue, { deliveries, hosts });
  const poller = new DeliveryPoller(store, client, enqueueDelivery);

  await app.start(config.PORT);
  poller.start(config.DATALAYER_DELIVERY_POLL_SECONDS);
  app.logger.info(
    `@Datalayer Slack is listening on ${config.PORT} (${config.DATALAYER_SLACK_TRANSPORT}).`,
  );

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    poller.stop();
    await app.stop();
    await resources.close();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
