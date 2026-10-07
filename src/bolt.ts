import { App, LogLevel } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";

import type { Config } from "./config.js";
import type { IncomingPrompt, SlackInstallationKey } from "./domain.js";
import { homeView } from "./home.js";
import type { WorkQueue } from "./queue.js";
import type { SlackMessage, SlackPort } from "./slack-port.js";
import type { SlackAgentService } from "./service.js";
import { slackThreadKey } from "./service.js";
import type { SlackStore } from "./store.js";

export class BoltSlackPort implements SlackPort {
  constructor(readonly client: WebClient) {}

  async postPrivate(userId: string, message: SlackMessage): Promise<void> {
    const opened = await this.client.conversations.open({ users: userId });
    const channel = opened.channel?.id;
    if (!channel)
      throw new Error("Slack did not return a direct-message channel.");
    await this.client.chat.postMessage({ channel, ...message });
  }

  async postThread(
    key: IncomingPrompt,
    message: SlackMessage,
  ): Promise<string> {
    const response = await this.client.chat.postMessage({
      channel: key.channelId,
      thread_ts: key.threadTs,
      ...message,
    });
    if (!response.ts)
      throw new Error("Slack did not return a message timestamp.");
    return response.ts;
  }

  async updateMessage(
    channelId: string,
    messageTs: string,
    message: SlackMessage,
  ): Promise<void> {
    await this.client.chat.update({
      channel: channelId,
      ts: messageTs,
      ...message,
    });
  }
}

export function createBoltApp(config: Config): App {
  return new App({
    appToken: config.SLACK_APP_TOKEN,
    logLevel:
      config.NODE_ENV === "development" ? LogLevel.DEBUG : LogLevel.INFO,
    signingSecret:
      config.SLACK_SIGNING_SECRET ?? "socket-mode-does-not-use-this-secret",
    socketMode: config.DATALAYER_SLACK_TRANSPORT === "socket",
    token: config.SLACK_BOT_TOKEN,
  });
}

export function registerSlackListeners(
  app: App,
  config: Config,
  service: SlackAgentService,
  queue: WorkQueue<SlackJob>,
): void {
  queue.start(async (job) =>
    service.handlePrompt(job.prompt, job.appId, job.botUserId),
  );
  app.event("app_mention", async ({ body, event, logger }) => {
    const teamId = body.team_id;
    if (!teamId || !body.event_id || !event.user) return;
    const thread = slackThreadKey({
      channel: event.channel,
      enterpriseId: body.enterprise_id ?? undefined,
      teamId,
      threadTs: event.thread_ts,
      ts: event.ts,
    });
    const prompt: IncomingPrompt = {
      ...thread,
      eventId: body.event_id,
      text: event.text,
      userId: event.user,
    };
    try {
      await queue.enqueue({
        appId: body.api_app_id,
        botUserId: config.SLACK_BOT_USER_ID,
        prompt,
      });
    } catch (error) {
      logger.error("Failed to process app mention", error);
    }
  });

  app.event("message", async ({ body, event, logger }) => {
    if (
      event.channel_type !== "im" ||
      !("user" in event) ||
      !event.user ||
      "bot_id" in event
    )
      return;
    if (
      !body.team_id ||
      !body.event_id ||
      !body.api_app_id ||
      !("text" in event) ||
      !event.text
    )
      return;
    const thread = slackThreadKey({
      channel: event.channel,
      enterpriseId: body.enterprise_id ?? undefined,
      teamId: body.team_id,
      threadTs: "thread_ts" in event ? event.thread_ts : undefined,
      ts: event.ts,
    });
    try {
      await queue.enqueue({
        appId: body.api_app_id,
        prompt: {
          ...thread,
          eventId: body.event_id,
          text: event.text,
          userId: event.user,
        },
      });
    } catch (error) {
      logger.error("Failed to process direct message", error);
    }
  });

  app.event("app_home_opened", async ({ body, event, client, logger }) => {
    if (!body.team_id || !body.api_app_id || event.tab !== "home") return;
    try {
      const view = await homeView(
        service.store,
        {
          appId: body.api_app_id,
          enterpriseId: body.enterprise_id ?? undefined,
          teamId: body.team_id,
        },
        event.user,
        service.webUrl,
      );
      await client.views.publish({ user_id: event.user, view });
    } catch (error) {
      logger.error("Failed to publish App Home", error);
    }
  });
}

export type SlackJob = Readonly<{
  appId: string;
  botUserId?: string;
  prompt: IncomingPrompt;
}>;

export async function seedDevelopmentInstallation(
  config: Config,
  store: SlackStore,
): Promise<void> {
  if (
    config.NODE_ENV !== "development" ||
    !config.SLACK_APP_ID ||
    !config.SLACK_TEAM_ID ||
    !config.SLACK_BOT_TOKEN ||
    !config.SLACK_BOT_USER_ID
  ) {
    return;
  }
  const key: SlackInstallationKey = {
    appId: config.SLACK_APP_ID,
    teamId: config.SLACK_TEAM_ID,
  };
  await store.putInstallation({
    ...key,
    botToken: config.SLACK_BOT_TOKEN,
    botUserId: config.SLACK_BOT_USER_ID,
    installedBy: "development",
    scopes: ["app_mentions:read", "chat:write", "im:history"],
    status: "active",
    updatedAt: new Date().toISOString(),
  });
  if (config.DATALAYER_DEFAULT_APP_ID) {
    await store.setDefaultApplication(key, config.DATALAYER_DEFAULT_APP_ID);
  }
  if (config.DATALAYER_DEV_PRINCIPAL_ID && config.DATALAYER_DEV_SLACK_USER_ID) {
    await store.putUserLink({
      ...key,
      datalayerPrincipalId: config.DATALAYER_DEV_PRINCIPAL_ID,
      linkedAt: new Date().toISOString(),
      slackUserId: config.DATALAYER_DEV_SLACK_USER_ID,
      status: "active",
    });
  }
}
