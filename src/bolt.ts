import {
  App,
  LogLevel,
  MemoryInstallationStore,
  type InstallationStore,
} from "@slack/bolt";
import type { WebClient } from "@slack/web-api";

import type { Config } from "./config.js";
import type {
  IncomingPrompt,
  SlackInstallationKey,
  ThreadKey,
} from "./domain.js";
import { homeView } from "./home.js";
import type { WorkQueue } from "./queue.js";
import type { SlackMessage, SlackPort } from "./slack-port.js";
import type { SlackAgentService } from "./service.js";
import { slackThreadKey } from "./service.js";
import type { SlackStore } from "./store.js";

export class BoltSlackPort implements SlackPort {
  constructor(
    readonly client: WebClient,
    readonly store: SlackStore,
  ) {}

  async postPrivate(
    key: SlackInstallationKey,
    userId: string,
    message: SlackMessage,
  ): Promise<void> {
    const token = await this.#token(key);
    const opened = await this.client.conversations.open({
      token,
      users: userId,
    });
    const channel = opened.channel?.id;
    if (!channel)
      throw new Error("Slack did not return a direct-message channel.");
    await this.client.chat.postMessage({ channel, token, ...message });
  }

  async postThread(key: ThreadKey, message: SlackMessage): Promise<string> {
    const token = await this.#token(key);
    const response = await this.client.chat.postMessage({
      channel: key.channelId,
      thread_ts: key.threadTs,
      token,
      ...message,
    });
    if (!response.ts)
      throw new Error("Slack did not return a message timestamp.");
    return response.ts;
  }

  async updateMessage(
    key: ThreadKey,
    messageTs: string,
    message: SlackMessage,
  ): Promise<void> {
    const token = await this.#token(key);
    await this.client.chat.update({
      channel: key.channelId,
      ts: messageTs,
      token,
      ...message,
    });
  }

  async #token(key: SlackInstallationKey): Promise<string> {
    const installation = await this.store.getInstallation(key);
    if (!installation || installation.status !== "active") {
      throw new Error("No active Slack installation was found.");
    }
    return installation.botToken;
  }
}

export function createBoltApp(
  config: Config,
  durableInstallationStore?: InstallationStore,
): App {
  const oauthConfigured = Boolean(
    config.SLACK_CLIENT_ID &&
      config.SLACK_CLIENT_SECRET &&
      config.SLACK_STATE_SECRET &&
      config.SLACK_REDIRECT_URI,
  );
  return new App({
    appToken: config.SLACK_APP_TOKEN,
    clientId: oauthConfigured ? config.SLACK_CLIENT_ID : undefined,
    clientSecret: oauthConfigured ? config.SLACK_CLIENT_SECRET : undefined,
    installationStore: oauthConfigured
      ? (durableInstallationStore ?? new MemoryInstallationStore())
      : undefined,
    installerOptions: oauthConfigured
      ? {
          directInstall: true,
          installPath: "/slack/install",
          redirectUriPath: new URL(
            config.SLACK_REDIRECT_URI ??
              "https://invalid.local/slack/oauth/callback",
          ).pathname,
        }
      : undefined,
    logLevel:
      config.NODE_ENV === "development" ? LogLevel.DEBUG : LogLevel.INFO,
    redirectUri: oauthConfigured ? config.SLACK_REDIRECT_URI : undefined,
    signingSecret:
      config.SLACK_SIGNING_SECRET ?? "socket-mode-does-not-use-this-secret",
    scopes: oauthConfigured
      ? ["app_mentions:read", "chat:write", "im:history"]
      : undefined,
    socketMode: config.DATALAYER_SLACK_TRANSPORT === "socket",
    stateSecret: oauthConfigured ? config.SLACK_STATE_SECRET : undefined,
    token: oauthConfigured ? undefined : config.SLACK_BOT_TOKEN,
  });
}

export function registerSlackListeners(
  app: App,
  config: Config,
  service: SlackAgentService,
  queue: WorkQueue<SlackJob>,
): void {
  queue.start(async (job) => service.handlePrompt(job.prompt, job.botUserId));
  app.event("app_mention", async ({ body, event, logger }) => {
    const teamId = body.team_id;
    if (!teamId || !body.event_id || !event.user) return;
    const thread = slackThreadKey({
      appId: body.api_app_id,
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
      appId: body.api_app_id,
      channel: event.channel,
      enterpriseId: body.enterprise_id ?? undefined,
      teamId: body.team_id,
      threadTs: "thread_ts" in event ? event.thread_ts : undefined,
      ts: event.ts,
    });
    try {
      await queue.enqueue({
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
