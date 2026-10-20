import {
  App,
  LogLevel,
  MemoryInstallationStore,
  type BlockAction,
  type CustomRoute,
  type InstallationStore,
  type Logger,
} from "@slack/bolt";
import type { KnownBlock } from "@slack/types";
import type { WebClient } from "@slack/web-api";
import type {
  DatalayerHostClient,
  Tracer,
  WorkQueue,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import { BotTokens } from "./bot-tokens.js";
import type { Config } from "./config.js";
import {
  INBOUND_TTL_MS,
  type SlackInstallationKey,
  type StarterSource,
  type ThreadKey,
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
  OPEN_LINK_ACTION,
  type DeliveryHandler,
} from "./deliveries.js";
import { guardRequestTimestamps } from "./health.js";
import {
  CONNECT_ACTION,
  DOCS_ACTION,
  EVENTS_ACTION,
  SUPPORT_ACTION,
  UNLINK_ACTION,
} from "./home.js";
import { inboundHashOf, ingressOf, type EventEnvelope } from "./ingress.js";
import {
  answeredAskBlocks,
  ASK_CHOICE_ACTION,
  OPEN_ACTION,
  START_OVER,
  STOP_ACTION,
  THREAD_MENU_ACTION,
  USE_ANOTHER,
  type OpenValue,
} from "./presentation.js";
import {
  SELECT_APPLICATION_ACTION,
  TurnRouting,
  type SelectorValue,
} from "./routing.js";
import type { HostInstallations } from "./host-installations.js";
import {
  escapeHtml,
  page,
  startBoundInstall,
  type SignedStateStore,
} from "./oauth-state.js";
import {
  isDirectChannel,
  isThreadKey,
  slackMemberOf,
  type SlackMember,
  type SlackMessage,
  type SlackPort,
  type SlackStreaming,
  type SuggestedPrompt,
} from "./slack-port.js";
import type { SlackAgentService, StopValue } from "./service.js";
import { SEND_EDITED_ACTION, SlackWorker, type SlackJob } from "./worker.js";
import type { SlackStore } from "./store.js";

export class BoltSlackPort implements SlackPort {
  readonly streaming?: SlackStreaming;
  readonly tokens: BotTokens;

  /**
   * `streaming`: Slack's text streaming (`chat.startStream`, `appendStream`,
   * `stopStream`, S-206) where the workspace's plan and the app offer it;
   * otherwise answers are a placeholder updated at a bounded cadence.
   */
  constructor(
    readonly client: WebClient,
    readonly store: SlackStore,
    options: { streaming?: boolean; tokens?: BotTokens } = {},
  ) {
    // The workspace's bot token, refreshed first when it rotates (S-102).
    this.tokens = options.tokens ?? new BotTokens(store);
    if (options.streaming)
      this.streaming = {
        append: async (key, ts, markdown) => {
          await this.client.chat.appendStream({
            channel: key.channelId,
            markdown_text: markdown,
            token: await this.#token(key),
            ts,
          });
        },
        start: async (key, recipientUserId) => {
          const response = await this.client.chat.startStream({
            channel: key.channelId,
            recipient_team_id: key.teamId,
            recipient_user_id: recipientUserId,
            thread_ts: key.threadTs,
            token: await this.#token(key),
          });
          if (!response.ts)
            throw new Error("Slack did not return the stream's message.");
          return response.ts;
        },
        stop: async (key, ts, message) => {
          await this.client.chat.stopStream({
            blocks: message.blocks as KnownBlock[] | undefined,
            channel: key.channelId,
            token: await this.#token(key),
            ts,
          });
        },
      };
  }

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
    key: SlackInstallationKey | ThreadKey,
    userId: string,
    message: SlackMessage,
  ): Promise<void> {
    // In a channel's thread: an ephemeral message only this person sees
    // (`chat:write`); anywhere else, their direct message with @Datalayer.
    if (isThreadKey(key) && !isDirectChannel(key.channelId)) {
      const token = await this.#token(key);
      await this.client.chat.postEphemeral({
        channel: key.channelId,
        thread_ts: key.threadTs,
        token,
        user: userId,
        ...(message as { text: string }),
      });
      return;
    }
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

  async memberOf(
    key: SlackInstallationKey,
    userId: string,
  ): Promise<SlackMember> {
    const response = await this.client.users.info({
      token: await this.#token(key),
      user: userId,
    });
    if (!response.user) throw new Error("Slack did not return the member.");
    return slackMemberOf(response.user, key);
  }

  async suggestPrompts(
    key: ThreadKey,
    title: string,
    prompts: readonly SuggestedPrompt[],
  ): Promise<void> {
    await this.client.assistant.threads.setSuggestedPrompts({
      channel_id: key.channelId,
      prompts: prompts.map((one) => ({ ...one })),
      thread_ts: key.threadTs,
      title,
      token: await this.#token(key),
    });
  }

  async #token(key: SlackInstallationKey): Promise<string> {
    return this.tokens.token(key);
  }
}

/**
 * The bot scopes: the baseline, `assistant:write` for the direct
 * message's suggested prompts (S-104) and `users:read` to tell guests and
 * external people apart (S-209), both decided by the user 16 October 2026.
 */
export const BOT_SCOPES = [
  "app_mentions:read",
  "assistant:write",
  "chat:write",
  "im:history",
  "users:read",
];

export type BoltAppOptions = Readonly<{
  /** The routes served beside Slack's: Datalayer's signed deliveries. */
  customRoutes?: CustomRoute[];
  installationStore?: InstallationStore;
  /** Signed, one-use OAuth state that carries the Ship card's bind code. */
  stateStore?: SignedStateStore;
}>;

export function oauthConfigured(config: Config): boolean {
  return Boolean(
    config.DATALAYER_SLACK_CLIENT_ID &&
      config.DATALAYER_SLACK_CLIENT_SECRET &&
      config.DATALAYER_SLACK_STATE_SECRET &&
      config.DATALAYER_SLACK_REDIRECT_URI,
  );
}

/** Where Slack posts signed events and actions. */
export const SLACK_EVENTS_PATH = "/slack/events";

export function createBoltApp(
  config: Config,
  options: BoltAppOptions = {},
): App {
  const app = boltApp(config, options);
  if (config.DATALAYER_SLACK_TRANSPORT === "http")
    guardRequestTimestamps(app, [SLACK_EVENTS_PATH]);
  return app;
}

function boltApp(config: Config, options: BoltAppOptions): App {
  const oauth = oauthConfigured(config);
  const stateStore = options.stateStore;
  return new App({
    appToken: config.DATALAYER_SLACK_APP_TOKEN,
    // A 429 is rejected to the caller, whose limiter waits Slack's
    // Retry-After (rate-limit.ts), rather than absorbed by the client
    // pausing its whole queue (S-206).
    clientOptions: { rejectRateLimitedCalls: true },
    clientId: oauth ? config.DATALAYER_SLACK_CLIENT_ID : undefined,
    clientSecret: oauth ? config.DATALAYER_SLACK_CLIENT_SECRET : undefined,
    customRoutes: options.customRoutes,
    installationStore: oauth
      ? (options.installationStore ?? new MemoryInstallationStore())
      : undefined,
    installerOptions: oauth
      ? {
          directInstall: true,
          installPath: "/slack/install",
          redirectUriPath: new URL(
            config.DATALAYER_SLACK_REDIRECT_URI ??
              "https://invalid.local/slack/oauth/callback",
          ).pathname,
          stateStore,
          installPathOptions: stateStore
            ? {
                // The Ship card's code rides in this request's own state,
                // never in an option shared with another request.
                beforeRedirection: async (request, response) =>
                  startBoundInstall(request, response, {
                    clientId: config.DATALAYER_SLACK_CLIENT_ID ?? "",
                    redirectUri: config.DATALAYER_SLACK_REDIRECT_URI,
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
    // Over HTTP, an event is acknowledged once its listener persisted it
    // (4–5); listeners never call Slack or Datalayer.
    processBeforeResponse: config.DATALAYER_SLACK_TRANSPORT === "http",
    redirectUri: oauth ? config.DATALAYER_SLACK_REDIRECT_URI : undefined,
    signingSecret:
      config.DATALAYER_SLACK_SIGNING_SECRET ??
      "socket-mode-does-not-use-this-secret",
    scopes: oauth ? BOT_SCOPES : undefined,
    socketMode: config.DATALAYER_SLACK_TRANSPORT === "socket",
    stateSecret:
      oauth && !stateStore ? config.DATALAYER_SLACK_STATE_SECRET : undefined,
    token: oauth ? undefined : config.DATALAYER_SLACK_BOT_TOKEN,
  });
}

export type SlackListenerParts = Readonly<{
  deliveries?: DeliveryHandler;
  hosts?: HostInstallations;
  /** Whether this process works the queue: not an ingress-only replica. */
  consume?: boolean;
  /** The workspace's bot token, refreshed when it rotates (S-102). */
  tokens?: BotTokens;
  tracer?: Tracer;
  /** Where App Home reads the default application's starters (S-104). */
  starters?: StarterSource;
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
): SlackWorker {
  const tokens = parts.tokens ?? new BotTokens(service.store);
  const worker = new SlackWorker(service, queue, {
    deliveries: parts.deliveries,
    hosts: parts.hosts,
    tracer: parts.tracer,
    starters: parts.starters,
    publishHome: async (key, userId, view) => {
      const installation = await service.store.getInstallation(key);
      if (!installation) return;
      const token = await tokens.token(key);
      await service.limiter.retry("views.publish", userId, () =>
        app.client.views.publish({
          token,
          user_id: userId,
          view: view as Parameters<typeof app.client.views.publish>[0]["view"],
        }),
      );
    },
  });
  if (parts.consume ?? true) queue.start((job) => worker.handle(job));

  // Events: normalized without a network call, persisted once by their
  // event id, then acknowledged (processBeforeResponse for HTTP).
  const enqueueEvent = async (body: EventEnvelope, logger: Logger) => {
    const ingress = ingressOf(body, config.DATALAYER_SLACK_BOT_USER_ID);
    const key = body.event_id;
    if (!key) return;
    const job: SlackJob | undefined =
      ingress.kind === "prompt"
        ? { botUserId: ingress.botUserId, prompt: ingress.prompt }
        : ingress.kind === "edited"
          ? {
              kind: "edited",
              originalTs: ingress.originalTs,
              prompt: ingress.prompt,
            }
          : ingress.kind === "deleted"
            ? {
                deletedTs: ingress.deletedTs,
                kind: "deleted",
                thread: ingress.prompt,
                userId: ingress.prompt.userId,
              }
            : undefined;
    if (!job) return;
    try {
      await queue.enqueue(job, key);
      // The event's idempotency record (S-004): its claim holds the hash of
      // the request as normalized here. A retry is the same request; the
      // same event id with another one enqueued nothing, and is said.
      const outcome = await service.store.recordInbound(
        key,
        inboundHashOf(job),
        new Date(Date.now() + INBOUND_TTL_MS),
      );
      if (outcome === "conflict")
        logger.warn(
          `Slack event ${key} came again with another request: refused, nothing enqueued.`,
        );
    } catch (error) {
      logger.error("Failed to persist a Slack event", error);
      throw error; // not acknowledged: Slack retries
    }
  };
  app.event("app_mention", async ({ body, logger }) =>
    enqueueEvent(body as unknown as EventEnvelope, logger),
  );
  app.event("message", async ({ body, logger }) =>
    enqueueEvent(body as unknown as EventEnvelope, logger),
  );

  app.event("app_home_opened", async ({ body, event, logger }) => {
    const key = installationKeyOf(body);
    if (!key || event.tab !== "home" || !body.event_id) return;
    try {
      await queue.enqueue(
        { key, kind: "home", userId: event.user },
        body.event_id,
      );
    } catch (error) {
      logger.error("Failed to persist App Home", error);
      throw error;
    }
  });

  // A direct-message thread opened in @Datalayer's Agent surface: its
  // suggested prompts (S-104, `assistant:write`).
  app.event("assistant_thread_started", async ({ body, event, logger }) => {
    const key = installationKeyOf(body);
    const thread = event.assistant_thread;
    if (!key || !body.event_id || !thread?.channel_id || !thread.thread_ts)
      return;
    try {
      await queue.enqueue(
        {
          kind: "assistant",
          thread: {
            ...key,
            channelId: thread.channel_id,
            threadTs: thread.thread_ts,
          },
          userId: thread.user_id,
        },
        body.event_id,
      );
    } catch (error) {
      logger.error("Failed to persist an assistant thread", error);
      throw error;
    }
  });

  // Link buttons open their URL; Slack still sends the click, acknowledged here.
  for (const action of [
    CONNECT_ACTION,
    DOCS_ACTION,
    SUPPORT_ACTION,
    REVIEW_ACTION,
    OPEN_LINK_ACTION,
  ])
    app.action(action, async ({ ack }) => {
      await ack();
    });

  /** The signed action's conversation: its channel and the thread of the message pressed. */
  const threadOf = (body: BlockAction): ThreadKey | undefined => {
    const key = installationKeyOf({
      api_app_id: body.api_app_id,
      enterprise_id: body.enterprise?.id,
      team_id: body.team?.id ?? body.user.team_id,
    });
    const message = body.message as
      | { ts?: string; thread_ts?: string }
      | undefined;
    const channelId = body.channel?.id;
    const threadTs = message?.thread_ts ?? message?.ts;
    return key && channelId && threadTs
      ? { ...key, channelId, threadTs }
      : undefined;
  };

  /**
   * The thread a busy notice's Stop names (S-206): only when pressed in that
   * thread's own channel. The service still stops only the running turn of
   * that event and session, for a linked member.
   */
  const stoppedThread = (
    body: BlockAction,
    value: StopValue,
  ): ThreadKey | undefined => {
    const key = installationKeyOf({
      api_app_id: body.api_app_id,
      enterprise_id: body.enterprise?.id,
      team_id: body.team?.id ?? body.user.team_id,
    });
    if (!key || !value.c || !value.t || body.channel?.id !== value.c)
      return undefined;
    return { ...key, channelId: value.c, threadTs: value.t };
  };

  app.action(STOP_ACTION, async ({ ack, body, logger }) => {
    await ack();
    try {
      const action = body as BlockAction;
      const pressed = action.actions[0];
      if (pressed?.type !== "button") return;
      const value = JSON.parse(pressed.value ?? "{}") as StopValue;
      // The busy notice's Stop names its thread (S-206): it was sent
      // privately, in that channel or the person's direct message.
      const thread = value.t ? stoppedThread(action, value) : threadOf(action);
      if (!thread) return;
      await worker.stop(thread, value, action.user.id);
    } catch (error) {
      logger.error("Failed to stop the turn", error);
    }
  });

  // Slack's own Stop on a streamed answer (S-206): Slack ends the stream and
  // says only the thread and who pressed it; the thread's running turn is
  // stopped under the button's rules. Without this event subscribed, Slack
  // says "Stop is not available for this agent".
  app.event("agent_session_stopped", async ({ body, event, logger }) => {
    const key = installationKeyOf(body);
    if (!key || !event.channel || !event.thread_ts || !event.user) return;
    try {
      await worker.stopThread(
        { ...key, channelId: event.channel, threadTs: event.thread_ts },
        event.user,
      );
    } catch (error) {
      logger.error("Failed to stop the turn", error);
    }
  });

  // *Open in Datalayer* (S-306): each press mints its own one-use link,
  // for the conversation's own person, said privately.
  app.action(OPEN_ACTION, async ({ ack, body, logger }) => {
    await ack();
    try {
      const action = body as BlockAction;
      const pressed = action.actions[0];
      const thread = threadOf(action);
      if (!parts.deliveries || !thread || pressed?.type !== "button") return;
      const value = JSON.parse(pressed.value ?? "{}") as Partial<OpenValue>;
      if (typeof value.s !== "string" || typeof value.u !== "string") return;
      await parts.deliveries.open(
        thread,
        { s: value.s, u: value.u },
        action.user.id,
      );
    } catch (error) {
      logger.error("Failed to open the conversation in Datalayer", error);
    }
  });

  app.action(SELECT_APPLICATION_ACTION, async ({ ack, body, logger }) => {
    await ack();
    try {
      const action = body as BlockAction;
      const pressed = action.actions[0];
      if (pressed?.type !== "static_select") return;
      const thread = threadOf(action);
      const key = installationKeyOf({
        api_app_id: action.api_app_id,
        enterprise_id: action.enterprise?.id,
        team_id: action.team?.id ?? action.user.team_id,
      });
      if (!key) return;
      const value = JSON.parse(pressed.selected_option.value) as SelectorValue;
      // A switch names its thread in the value: the selector was sent
      // privately, and its own message is no thread of the session's.
      const switched = value.sw
        ? TurnRouting.switchedThread(key, value, action.channel?.id)
        : thread;
      const outcome = await worker.selected(
        key,
        value,
        action.user.id,
        switched,
      );
      if (outcome === "refused")
        await service.privately(thread ?? key, action.user.id, {
          text: "That choice is not available to you any more. Mention @Datalayer again.",
        });
    } catch (error) {
      logger.error("Failed to take the application choice", error);
    }
  });

  app.action(THREAD_MENU_ACTION, async ({ ack, body, logger }) => {
    await ack();
    try {
      const action = body as BlockAction;
      const pressed = action.actions[0];
      const thread = threadOf(action);
      if (!thread || pressed?.type !== "overflow") return;
      if (pressed.selected_option.value === START_OVER) {
        const ok = await worker.startOver(thread, action.user.id);
        await service.privately(thread, action.user.id, {
          text: ok
            ? "Started over: the next @Datalayer message in this thread opens a new session. The earlier one stays in Datalayer."
            : "Only the person who started this thread's session can start over, and not while it answers.",
        });
        if (ok)
          await service.slack.postThread(thread, {
            text: "This thread was started over: the next @Datalayer message opens a new session.",
          });
      } else if (pressed.selected_option.value === USE_ANOTHER) {
        await service.privately(
          thread,
          action.user.id,
          service.routing.selector(
            await service.store.getAllowances(thread),
            { channelId: thread.channelId, eventId: "" },
            thread,
          ),
        );
      }
    } catch (error) {
      logger.error("Failed to act on the thread menu", error);
    }
  });

  app.action(
    new RegExp(`^${ASK_CHOICE_ACTION}_\\d+$`),
    async ({ ack, body, logger }) => {
      await ack();
      try {
        const action = body as BlockAction;
        const pressed = action.actions[0];
        const thread = threadOf(action);
        if (!thread || pressed?.type !== "button") return;
        const { a, k } = JSON.parse(pressed.value ?? "{}") as {
          a?: string;
          k?: string;
        };
        if (!a || !k) return;
        const first = await worker.answered(
          thread,
          { askedBy: k, option: a },
          action.user.id,
        );
        const message = action.message as
          | { blocks?: KnownBlock[]; text?: string; ts?: string }
          | undefined;
        if (first && message?.ts && message.blocks)
          await service.slack.updateMessage(thread, message.ts, {
            blocks: answeredAskBlocks(message.blocks, a, action.user.id),
            text: message.text ?? a,
          });
        else if (!first)
          await service.privately(thread, action.user.id, {
            text: "This question was already answered.",
          });
      } catch (error) {
        logger.error("Failed to send the answer", error);
      }
    },
  );

  app.action(SEND_EDITED_ACTION, async ({ ack, body, logger }) => {
    await ack();
    try {
      const action = body as BlockAction;
      const pressed = action.actions[0];
      const key = installationKeyOf({
        api_app_id: action.api_app_id,
        enterprise_id: action.enterprise?.id,
        team_id: action.team?.id ?? action.user.team_id,
      });
      if (!key || pressed?.type !== "button") return;
      const sent = await worker.sendEdited(
        key,
        JSON.parse(pressed.value ?? "{}") as { ev: string },
        action.user.id,
        pressed.action_ts,
      );
      if (!sent)
        await service.privately(key, action.user.id, {
          text: "That edit was already sent, or it is not yours to send.",
        });
    } catch (error) {
      logger.error("Failed to send the edited text", error);
    }
  });

  // Quiet or noisy answers, the person's own choice on their Home (S-308).
  app.action(EVENTS_ACTION, async ({ ack, body, logger }) => {
    await ack();
    try {
      const action = body as BlockAction;
      const pressed = action.actions[0];
      const key = installationKeyOf({
        api_app_id: action.api_app_id,
        enterprise_id: action.enterprise?.id,
        team_id: action.team?.id ?? action.user.team_id,
      });
      const chosen =
        pressed?.type === "radio_buttons"
          ? pressed.selected_option?.value
          : undefined;
      if (!key || (chosen !== "quiet" && chosen !== "noisy")) return;
      await worker.choseEvents(key, action.user.id, chosen);
    } catch (error) {
      logger.error("Failed to keep the answers' choice", error);
    }
  });

  app.action(UNLINK_ACTION, async ({ ack, body, logger }) => {
    await ack();
    try {
      const action = body as BlockAction;
      const key = installationKeyOf({
        api_app_id: action.api_app_id,
        enterprise_id: action.enterprise?.id,
        team_id: action.team?.id ?? action.user.team_id,
      });
      if (key) await worker.unlink(key, action.user.id);
    } catch (error) {
      logger.error("Failed to unlink the account", error);
    }
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
        const triggerId = body.trigger_id;
        // A 429 waits Slack's Retry-After like every other call (S-206).
        await service.limiter.retry("views.open", body.user.id, () =>
          client.views.open({
            trigger_id: triggerId,
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
          }),
        );
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
        await service.privately(
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
  return worker;
}

export async function uninstallSlackWorkspace(
  store: SlackStore,
  key: SlackInstallationKey,
): Promise<void> {
  await store.deleteInstallation(key);
}

export type { SlackJob } from "./worker.js";

/**
 * The development workspace, from the environment. Given a host key
 * (development only), it is bound as an install would bind it: the key and
 * the installation's uid, read from Datalayer, kept with the workspace, so
 * its calls carry the key and the outbox poller reads its deliveries.
 * A key Datalayer refuses stops the start.
 */
export async function seedDevelopmentInstallation(
  config: Config,
  store: SlackStore,
  client: Pick<DatalayerHostClient, "self">,
): Promise<void> {
  if (
    config.NODE_ENV !== "development" ||
    !config.DATALAYER_SLACK_APP_ID ||
    !config.DATALAYER_SLACK_TEAM_ID ||
    !config.DATALAYER_SLACK_BOT_TOKEN ||
    !config.DATALAYER_SLACK_BOT_USER_ID
  ) {
    return;
  }
  const key: SlackInstallationKey = {
    appId: config.DATALAYER_SLACK_APP_ID,
    teamId: config.DATALAYER_SLACK_TEAM_ID,
  };
  const hostKey = config.DATALAYER_HOST_KEY;
  const bound = hostKey
    ? {
        datalayerHostKey: hostKey,
        datalayerHostUid: (await client.self(hostKey)).uid,
      }
    : {};
  await store.putInstallation({
    ...key,
    ...bound,
    botToken: config.DATALAYER_SLACK_BOT_TOKEN,
    botUserId: config.DATALAYER_SLACK_BOT_USER_ID,
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
