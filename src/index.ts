import {
  DevelopmentCredentials,
  HostKeyCredentials,
  HttpAgentClient,
  type HostCredentials,
} from "./agent-client.js";
import {
  BoltSlackPort,
  createBoltApp,
  registerSlackListeners,
  seedDevelopmentInstallation,
} from "./bolt.js";
import { readConfig } from "./config.js";
import { createRuntimeResources } from "./resources.js";
import { SlackAgentService } from "./service.js";

async function main(): Promise<void> {
  const config = readConfig();
  const resources = createRuntimeResources(config);
  const { queue, store } = resources;
  await seedDevelopmentInstallation(config, store);
  const app = createBoltApp(config, resources.installationStore);
  const slack = new BoltSlackPort(app.client, store);
  const hostKey = config.DATALAYER_HOST_KEY;
  const hostKeyFor = hostKey ? async () => hostKey : undefined;
  let credentials: HostCredentials;
  if (hostKeyFor) {
    credentials = new HostKeyCredentials(config.DATALAYER_API_URL, hostKeyFor);
  } else if (
    config.NODE_ENV === "development" &&
    config.DATALAYER_DEV_HOST_TOKEN
  ) {
    credentials = new DevelopmentCredentials(
      config.DATALAYER_API_URL,
      config.DATALAYER_DEV_HOST_TOKEN,
    );
  } else {
    credentials = {
      forTurn: async () => {
        throw new Error(
          "No Datalayer host key is configured: bind this installation first.",
        );
      },
    };
  }
  const agents = new HttpAgentClient(
    config.DATALAYER_API_URL,
    credentials,
    fetch,
    hostKeyFor,
  );
  const service = new SlackAgentService(
    store,
    agents,
    slack,
    config.DATALAYER_WEB_URL,
  );
  registerSlackListeners(app, config, service, queue);

  await app.start(config.PORT);
  app.logger.info(
    `@Datalayer Slack is listening on ${config.PORT} (${config.DATALAYER_SLACK_TRANSPORT}).`,
  );

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
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
