import { HttpAgentClient } from "./agent-client.js";
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
  const app = createBoltApp(config);
  const slack = new BoltSlackPort(app.client);
  const agents = new HttpAgentClient(config.DATALAYER_API_URL, async () => {
    if (config.NODE_ENV === "development" && config.DATALAYER_DEV_HOST_TOKEN) {
      return config.DATALAYER_DEV_HOST_TOKEN;
    }
    throw new Error("The Slack host-token exchange is not configured yet.");
  });
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
