import {
  App,
  LogLevel,
  MemoryInstallationStore,
  type CustomRoute,
  type InstallationStore,
} from "@slack/bolt";
import type { WebClient } from "@slack/web-api";

import type { Config } from "./config.js";
import type {
  IncomingPrompt,
  SlackInstallationKey,
  ThreadKey,
} from "./domain.js";
import {
  APPROVE_ACTION,
  buttonValueOf,
  CONFIRM_VIEW,
  confirmModal,
  DECLINE_ACTION,
  NOTE_ACTION,
  NOTE_BLOCK,
  REVIEW_ACTION,
  type ConfirmMetadata,
} from "./approval-card.js";
import {
  DECISION_WORDS,
  type DeliveryHandler,
  type DeliveryJob,
} from "./deliveries.js";
import { CONNECT_ACTION, homeView } from "./home.js";
import type { HostInstallations } from "./host-installations.js";
import {
  escapeHtml,
  page,
  startBoundInstall,
  type SignedStateStore,
} from "./oauth-state.js";
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

  async postDirect(
    key: SlackInstallationKey,
    userId: string,
    message: SlackMessage,
  ): Promise<{ channelId: string; ts: string }> {
    const token = await this.#token(key);
    // Posted to the user's id: @Datalayer's Messages tab, with `chat:write`
    // only (no `im:write` to open a conversation).
    const response = await this.client.chat.postMessage({
      channel: userId,
      token,
      ...message,
    });
    if (!response.channel || !response.ts)
      throw new Error("Slack did not return the direct message.");
    return { channelId: response.channel, ts: response.ts };
  }

  async postPrivate(
    key: SlackInstallationKey,
    userId: string,
    message: SlackMessage,
  ): Promise<void> {
    await this.postDirect(key, userId, message);
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

/** The bot scopes of the baseline (§6.2), and nothing else. */
export const BOT_SCOPES = ["app_mentions:read", "chat:write", "im:history"];

export type BoltAppOptions = Readonly<{
  /** The routes served beside Slack's: Datalayer's signed deliveries. */
  customRoutes?: CustomRoute[];
  installationStore?: InstallationStore;
  /** Signed, one-use OAuth state that carries the Ship card's bind code. */
  stateStore?: SignedStateStore;
}>;

export function oauthConfigured(config: Config): boolean {
  return Boolean(
    config.SLACK_CLIENT_ID &&
      config.SLACK_CLIENT_SECRET &&
      config.SLACK_STATE_SECRET &&
      config.SLACK_REDIRECT_URI,
  );
}

export function createBoltApp(
  config: Config,
  options: BoltAppOptions = {},
): App {
  const oauth = oauthConfigured(config);
  const stateStore = options.stateStore;
  return new App({
    appToken: config.SLACK_APP_TOKEN,
    clientId: oauth ? config.SLACK_CLIENT_ID : undefined,
    clientSecret: oauth ? config.SLACK_CLIENT_SECRET : undefined,
    customRoutes: options.customRoutes,
    installationStore: oauth
      ? (options.installationStore ?? new MemoryInstallationStore())
      : undefined,
    installerOptions: oauth
      ? {
          directInstall: true,
          installPath: "/slack/install",
          redirectUriPath: new URL(
            config.SLACK_REDIRECT_URI ??
              "https://invalid.local/slack/oauth/callback",
          ).pathname,
          stateStore,
          installPathOptions: stateStore
            ? {
                // The Ship card's code rides in this request's own state,
                // never in an option shared with another request.
                beforeRedirection: async (request, response) =>
                  startBoundInstall(request, response, {
                    clientId: config.SLACK_CLIENT_ID ?? "",
                    redirectUri: config.SLACK_REDIRECT_URI,
                    requireBind: config.NODE_ENV !== "development",
                    scopes: BOT_SCOPES,
                    stateStore,
                    webUrl: config.DATALAYER_WEB_URL,
                  }),
              }
            : undefined,
          callbackOptions: {
            success: (installation, _options, _request, response) => {
              const team = installation.team?.name ?? "your workspace";
              response.writeHead(200, {
                "content-type": "text/html; charset=utf-8",
              });
              response.end(
                page(
                  "@Datalayer is installed",
                  `@Datalayer answers in ${escapeHtml(team)} as the application you installed it for. Each person connects their own Datalayer account from @Datalayer's Home in Slack. <a href="${escapeHtml(config.DATALAYER_WEB_URL)}/docs/slack">Read the guide</a>.`,
                ),
              );
            },
            failure: (_error, _options, _request, response) => {
              response.writeHead(400, {
                "content-type": "text/html; charset=utf-8",
              });
              response.end(
                page(
                  "@Datalayer was not installed",
                  `The install did not finish: its code from Datalayer was used, it expired (ten minutes), or Slack did not confirm it. Install again from the application's Ship tab in Datalayer. <a href="${escapeHtml(config.DATALAYER_WEB_URL)}/docs/slack">Read the guide</a>.`,
                ),
              );
            },
          },
        }
      : undefined,
    logLevel:
      config.NODE_ENV === "development" ? LogLevel.DEBUG : LogLevel.INFO,
    redirectUri: oauth ? config.SLACK_REDIRECT_URI : undefined,
    signingSecret:
      config.SLACK_SIGNING_SECRET ?? "socket-mode-does-not-use-this-secret",
    scopes: oauth ? BOT_SCOPES : undefined,
    socketMode: config.DATALAYER_SLACK_TRANSPORT === "socket",
    stateSecret: oauth && !stateStore ? config.SLACK_STATE_SECRET : undefined,
    token: oauth ? undefined : config.SLACK_BOT_TOKEN,
  });
}

export type SlackListenerParts = Readonly<{
  deliveries?: DeliveryHandler;
  hosts?: HostInstallations;
}>;

const installationKeyOf = (body: {
  api_app_id?: string;
  enterprise_id?: string | null;
  team_id?: string | null;
}): SlackInstallationKey | undefined =>
  body.api_app_id && body.team_id
    ? {
        appId: body.api_app_id,
        enterpriseId: body.enterprise_id ?? undefined,
        teamId: body.team_id,
      }
    : undefined;

export function registerSlackListeners(
  app: App,
  config: Config,
  service: SlackAgentService,
  queue: WorkQueue<SlackJob>,
  parts: SlackListenerParts = {},
): void {
  queue.start(async (job) => {
    if ("delivery" in job) {
      await parts.deliveries?.receive(job);
      return;
    }
    await service.handlePrompt(job.prompt, job.botUserId);
  });
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
    const key = installationKeyOf(body);
    if (!key || event.tab !== "home") return;
    try {
      const view = await homeView(
        service.store,
        key,
        event.user,
        service.webUrl,
        service.links,
      );
      await client.views.publish({ user_id: event.user, view });
    } catch (error) {
      logger.error("Failed to publish App Home", error);
    }
  });

  // Link buttons open their URL; Slack still sends the click, acknowledged here.
  for (const action of [
    CONNECT_ACTION,
    "open_datalayer_slack_docs",
    REVIEW_ACTION,
  ])
    app.action(action, async ({ ack }) => {
      await ack();
    });

  // Approve or Decline (S-304): acknowledged at once, then a confirmation.
  for (const [action, approve] of [
    [APPROVE_ACTION, true],
    [DECLINE_ACTION, false],
  ] as const)
    app.action(action, async ({ ack, body, client, logger }) => {
      await ack();
      try {
        if (body.type !== "block_actions") return;
        const pressed = body.actions[0];
        if (!pressed || pressed.type !== "button") return;
        const value = buttonValueOf(pressed.value);
        const teamId = body.team?.id ?? body.user.team_id;
        if (!teamId || !body.trigger_id) return;
        const blocks = (body.message as { blocks?: unknown[] } | undefined)
          ?.blocks;
        const header = blocks?.[0] as { text?: { text?: string } } | undefined;
        await client.views.open({
          trigger_id: body.trigger_id,
          view: confirmModal(
            {
              ...value,
              app: body.api_app_id,
              approve,
              ent: body.enterprise?.id ?? undefined,
              team: teamId,
            },
            header?.text?.text ?? "this action",
          ),
        });
      } catch (error) {
        logger.error("Failed to open the approval confirmation", error);
      }
    });

  app.view(CONFIRM_VIEW, async ({ ack, body, view, logger }) => {
    await ack();
    try {
      if (!parts.deliveries) return;
      const metadata = JSON.parse(view.private_metadata) as ConfirmMetadata;
      // The modal's own signed payload names the workspace: a transplanted
      // metadata naming another is refused.
      const teamId = body.team?.id ?? body.user.team_id;
      if (metadata.team !== teamId || metadata.app !== body.api_app_id) return;
      const note =
        view.state.values[NOTE_BLOCK]?.[NOTE_ACTION]?.value ?? undefined;
      const outcome = await parts.deliveries.decide({
        metadata,
        note: note || undefined,
        slackUserId: body.user.id,
      });
      if (outcome !== "decided")
        await service.slack.postPrivate(
          {
            appId: metadata.app,
            enterpriseId: metadata.ent,
            teamId: metadata.team,
          },
          body.user.id,
          { text: DECISION_WORDS[outcome] },
        );
    } catch (error) {
      logger.error("Failed to decide the approval", error);
    }
  });

  const uninstall = async (key: SlackInstallationKey) =>
    parts.hosts
      ? parts.hosts.uninstall(key)
      : uninstallSlackWorkspace(service.store, key);

  app.event("app_uninstalled", async ({ body, logger }) => {
    const key = installationKeyOf(body);
    if (!key) return;
    try {
      await uninstall(key);
    } catch (error) {
      logger.error("Failed to remove an uninstalled Slack workspace", error);
      throw error;
    }
  });

  // The bot token revoked is the workspace gone for this app: the same cleanup.
  app.event("tokens_revoked", async ({ body, event, logger }) => {
    const key = installationKeyOf(body);
    if (!key || (event.tokens.bot ?? []).length === 0) return;
    try {
      await uninstall(key);
    } catch (error) {
      logger.error("Failed to remove a revoked Slack workspace", error);
      throw error;
    }
  });
}

export async function uninstallSlackWorkspace(
  store: SlackStore,
  key: SlackInstallationKey,
): Promise<void> {
  await store.deleteInstallation(key);
}

export type SlackJob =
  | Readonly<{
      botUserId?: string;
      prompt: IncomingPrompt;
    }>
  | DeliveryJob;

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
