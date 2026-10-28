import {
  App,
  LogLevel,
  verifySlackRequest,
  type Authorize,
  type AuthorizeResult,
  type CustomRoute,
} from "@slack/bolt";
import {
  HostRefusedError,
  type Logger,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

import { BOT_SCOPES } from "./bolt.js";
import type { Config } from "./config.js";
import type { SlackInstallation, SlackInstallationKey } from "./domain.js";
import type { HostInstallations } from "./host-installations.js";
import type { SlackStore } from "./store.js";

/**
 * A Slack app the person brings (decided 28 October 2026). Datalayer's own
 * app (`bolt.ts`) is installed from a person's Settings, for their
 * workspace, through Slack's OAuth; an application's Ship tab instead lets
 * its owner bring their own Slack app, created on Slack's console for their
 * workspace alone: they install it to the workspace there (*Install to
 * Workspace* gives its bot token: no OAuth through their app, which would
 * need their client id and secret and a redirect URL registered in their
 * app for no gain), then paste its app id, signing secret and bot token on
 * the card. The card has made the pending installation at Datalayer
 * (`POST /apps/hosts`, provider `custom`) and posts `{bind_code, app_id,
 * signing_secret, bot_token}` to `POST /slack/apps/install` (only the
 * card's origin may post: CORS). The service checks the token with
 * `auth.test` (the workspace, the bot user, the token's scopes) and
 * `bots.info` (the token is the app's whose id was typed), binds the
 * installation at Datalayer (`app:-:team`, as Datalayer's own app binds),
 * registers where deliveries are pushed, keeps the installation beside the
 * others (`slack_installations`: its bot token encrypted, its key, its
 * allowances) and what only a custom app has (`slack_custom_apps`: its
 * signing secret encrypted, its bot id). It answers the Request URL the
 * person then puts in the app's Event Subscriptions and Interactivity:
 * `/slack/apps/<app_id>/events`.
 *
 * At that route each request is verified with that app's own signing
 * secret (Bolt's `verifySlackRequest`: the signature and the five-minute
 * window), Slack's `url_verification` is answered once the app is known,
 * and every other request is handed to a second Bolt app made for custom
 * apps ({@link createCustomAppsBolt}): its `authorize` reads the app id
 * from the body (`api_app_id`) and the bot token from the installation, so
 * the one set of listeners (`registerSlackListeners`) serves Datalayer's
 * app and every custom app alike — events are keyed by `api_app_id` and
 * `team_id`, and the worker posts with each installation's own token
 * (`BotTokens`). Uninstalling the app in Slack (`app_uninstalled`,
 * `tokens_revoked`) reaches the same route and ends the installation as
 * for Datalayer's app; the custom app's row goes with it.
 */

/** Where the Ship card posts a custom app's credentials. */
export const CUSTOM_INSTALL_PATH = "/slack/apps/install";
/** Where Slack posts a custom app's events and interactions (Bolt's route parameter). */
export const CUSTOM_EVENTS_ROUTE = "/slack/apps/:appId/events";
/** The most a request to a custom app's routes may carry. */
export const CUSTOM_BODY_LIMIT = 256 * 1024;

/** The Request URL for one custom app, as the card shows it. */
export const customEventsUrlOf = (publicUrl: string, appId: string): string =>
  `${publicUrl.replace(/\/+$/, "")}/slack/apps/${encodeURIComponent(appId)}/events`;

/** A Slack app id (`A0…`), a bot id (`B0…`), a team id (`T0…`), a user id (`U0…`, `W0…`). */
const SLACK_ID = /^[A-Z][A-Z0-9]{2,32}$/;

export const installRequestSchema = z
  .object({
    bind_code: z.string().regex(/^[A-Za-z0-9_-]{8,200}$/),
    app_id: z.string().regex(/^A[A-Z0-9]{2,32}$/),
    signing_secret: z.string().regex(/^[a-f0-9]{32,128}$/),
    /** The bot token *Install to Workspace* gave (`xoxb-…`). */
    bot_token: z.string().regex(/^xoxb-[A-Za-z0-9-]{20,300}$/),
  })
  .strict();

export type InstallRequest = z.infer<typeof installRequestSchema>;

/** What the card is answered: connected, or why not in one sentence. */
export const CUSTOM_WORDS = {
  invalid: "The install request is not one this service takes.",
  token:
    "Slack did not accept that bot token: copy the Bot User OAuth Token again from your app's OAuth & Permissions page, after Install to Workspace.",
  notTheApp:
    "That bot token belongs to another app: paste the token of the app whose id you entered (Basic Information, App ID).",
  scopes: (missing: readonly string[]) =>
    `Your app lacks the bot scope${missing.length === 1 ? "" : "s"} ${missing.join(", ")}: add ${missing.length === 1 ? "it" : "them"} under OAuth & Permissions, reinstall the app to the workspace, and paste the new token.`,
  bind: "The install's code from Datalayer was used or expired: nothing was kept. Connect the app again from the Ship tab.",
  enterprise:
    "An Enterprise Grid organization-wide install is not supported: install the app to one workspace.",
  unknownApp: "No custom Slack app of that id is connected to Datalayer.",
  signature: "The request is not signed by that app.",
} as const;

/** What the service asks Slack of a pasted token: Slack's own `auth.test` and `bots.info`. */
export interface SlackAuthPort {
  /** Whose token it is: the workspace, the bot user and bot, the token's scopes. */
  authTest(token: string): Promise<{
    teamId: string;
    teamName: string;
    enterpriseId?: string;
    botUserId: string;
    botId: string;
    isEnterpriseInstall: boolean;
    scopes: readonly string[];
  }>;
  /** The app a bot belongs to. */
  botAppId(token: string, botId: string): Promise<string>;
}

/** Slack's web API as the port: `auth.test` (its `response_metadata.scopes`) and `bots.info`. */
export function slackAuthPort(client: {
  auth: { test(options: { token: string }): Promise<unknown> };
  bots: { info(options: { token: string; bot: string }): Promise<unknown> };
}): SlackAuthPort {
  const str = (value: unknown): string =>
    typeof value === "string" ? value : "";
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    async authTest(token) {
      const answer = record(await client.auth.test({ token }));
      const metadata = record(answer.response_metadata);
      const scopes = Array.isArray(metadata.scopes)
        ? metadata.scopes.filter(
            (one): one is string => typeof one === "string",
          )
        : [];
      return {
        botId: str(answer.bot_id),
        botUserId: str(answer.user_id),
        enterpriseId: str(answer.enterprise_id) || undefined,
        isEnterpriseInstall: answer.is_enterprise_install === true,
        scopes,
        teamId: str(answer.team_id),
        teamName: str(answer.team),
      };
    },
    async botAppId(token, botId) {
      const answer = record(await client.bots.info({ bot: botId, token }));
      return str(record(answer.bot).app_id);
    },
  };
}

export type CustomInstallDependencies = Readonly<{
  /** The service's public address: where Slack posts the app's events. */
  publicUrl: string;
  /** Datalayer's web origin: the only one whose card may post. */
  webUrl: string;
  store: SlackStore;
  hosts: Pick<HostInstallations, "bind" | "keep">;
  auth: SlackAuthPort;
  logger: Pick<Logger, "info" | "warn">;
  now?: () => Date;
}>;

export type InstallOutcome =
  | Readonly<{
      ok: true;
      name: string;
      hostUid: string;
      /** What the person puts in Event Subscriptions and Interactivity. */
      requestUrl: string;
      /** The bot events to subscribe to, as the manifest lists them. */
      botEvents: readonly string[];
    }>
  | Readonly<{ ok: false; error: string }>;

/** The bot events a custom app subscribes to: the manifest's, under its Request URL. */
export const CUSTOM_BOT_EVENTS = [
  "agent_session_stopped",
  "app_home_opened",
  "app_mention",
  "app_uninstalled",
  "assistant_thread_started",
  "message.im",
  "tokens_revoked",
] as const;

/** The install, once the request is read: the token checked, bound at Datalayer, kept. */
export async function installCustomApp(
  dependencies: CustomInstallDependencies,
  request: InstallRequest,
): Promise<InstallOutcome> {
  const { auth, hosts, store, logger } = dependencies;
  let who;
  try {
    who = await auth.authTest(request.bot_token);
  } catch (error) {
    logger.warn("custom_install.token_refused", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { error: CUSTOM_WORDS.token, ok: false };
  }
  if (
    !SLACK_ID.test(who.teamId) ||
    !SLACK_ID.test(who.botId) ||
    !SLACK_ID.test(who.botUserId)
  )
    return { error: CUSTOM_WORDS.token, ok: false };
  if (who.isEnterpriseInstall)
    return { error: CUSTOM_WORDS.enterprise, ok: false };
  let appId: string;
  try {
    appId = await auth.botAppId(request.bot_token, who.botId);
  } catch (error) {
    logger.warn("custom_install.bot_refused", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { error: CUSTOM_WORDS.token, ok: false };
  }
  if (appId !== request.app_id)
    return { error: CUSTOM_WORDS.notTheApp, ok: false };
  const missing = BOT_SCOPES.filter((scope) => !who.scopes.includes(scope));
  if (missing.length) return { error: CUSTOM_WORDS.scopes(missing), ok: false };
  const key: SlackInstallationKey = {
    appId,
    enterpriseId: who.enterpriseId,
    teamId: who.teamId,
  };
  let bound;
  try {
    bound = await hosts.bind(key, request.bind_code, who.teamName, {
      customAppId: appId,
      provider: "custom",
    });
  } catch (error) {
    if (!(error instanceof HostRefusedError)) throw error;
    logger.warn("custom_install.bind_refused", { status: error.status });
    return { error: CUSTOM_WORDS.bind, ok: false };
  }
  const now = (dependencies.now ?? (() => new Date()))().toISOString();
  const installation: SlackInstallation = {
    ...key,
    botToken: request.bot_token,
    botUserId: who.botUserId,
    // Pasted by the application's owner: no Slack user installed it through OAuth.
    installedBy: who.botUserId,
    scopes: who.scopes,
    status: "active",
    updatedAt: now,
  };
  await hosts.keep(installation, bound);
  await store.putCustomApp({
    appId,
    botId: who.botId,
    createdAt: now,
    signingSecret: request.signing_secret,
    teamId: who.teamId,
  });
  logger.info("custom_install.bound", { app: appId, host: bound.hostUid });
  return {
    botEvents: CUSTOM_BOT_EVENTS,
    hostUid: bound.hostUid,
    name: who.teamName,
    ok: true,
    requestUrl: customEventsUrlOf(dependencies.publicUrl, appId),
  };
}

/** The request's raw body, refused past the limit. */
export class BodyTooLargeError extends Error {
  constructor() {
    super("The request is too large.");
  }
}

export async function rawBodyOf(
  request: IncomingMessage,
  limit = CUSTOM_BODY_LIMIT,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new BodyTooLargeError();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/**
 * The Bolt app every custom app's requests are handed to: no receiver of
 * its own is started (the route below verifies and hands over), and its
 * `authorize` reads which app the request is for from the body
 * (`api_app_id`) and the installation of that app in that workspace — the
 * bot token the person pasted, the bot user and bot ids — so the listeners
 * registered on it (`registerSlackListeners`, the same as Datalayer's
 * app's) act as that app.
 */
export function createCustomAppsBolt(config: Config, store: SlackStore): App {
  const authorize = async (
    source: { teamId?: string; enterpriseId?: string },
    body?: Record<string, unknown>,
  ): Promise<AuthorizeResult> => {
    const appId = typeof body?.api_app_id === "string" ? body.api_app_id : "";
    if (!appId || !source.teamId)
      throw new Error("The request names no app or no workspace.");
    const key: SlackInstallationKey = {
      appId,
      enterpriseId: source.enterpriseId,
      teamId: source.teamId,
    };
    const [installation, app] = await Promise.all([
      store.getInstallation(key),
      store.getCustomApp(appId),
    ]);
    if (!installation || installation.status !== "active" || !app)
      throw new Error(
        "No custom Slack app of that id is installed in that workspace.",
      );
    return {
      botId: app.botId,
      botToken: installation.botToken,
      botUserId: installation.botUserId,
      enterpriseId: key.enterpriseId,
      teamId: key.teamId,
    };
  };
  return new App({
    authorize: authorize as unknown as Authorize<boolean>,
    clientOptions: { rejectRateLimitedCalls: true },
    logLevel:
      config.NODE_ENV === "development" ? LogLevel.DEBUG : LogLevel.INFO,
    processBeforeResponse: true,
    // Never used: the route verifies each request with its own app's secret.
    signingSecret: "custom-apps-are-verified-per-app",
  });
}

/** The body Slack posted: JSON, or a form whose `payload` is JSON (interactions). */
export function slackBodyOf(
  contentType: string | undefined,
  raw: string,
): Record<string, unknown> | undefined {
  try {
    if ((contentType ?? "").includes("application/x-www-form-urlencoded")) {
      const form = new URLSearchParams(raw);
      const payload = form.get("payload");
      if (payload) return JSON.parse(payload) as Record<string, unknown>;
      return Object.fromEntries(form.entries());
    }
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export type CustomRoutesDependencies = CustomInstallDependencies &
  Readonly<{
    /** The Bolt app custom apps' requests are handed to ({@link createCustomAppsBolt}). */
    bolt: Pick<App, "processEvent">;
  }>;

/**
 * The routes served beside Slack's own (as Bolt custom routes): the card's
 * install (with its CORS preflight) and each custom app's events.
 */
export function customAppRoutes(
  dependencies: CustomRoutesDependencies,
): CustomRoute[] {
  const origin = new URL(dependencies.webUrl).origin;
  const cors = (request: IncomingMessage): Record<string, string> =>
    request.headers.origin === origin
      ? {
          "access-control-allow-headers": "content-type",
          "access-control-allow-methods": "POST",
          "access-control-allow-origin": origin,
          "access-control-max-age": "600",
          vary: "origin",
        }
      : { vary: "origin" };
  const answer = (
    request: IncomingMessage,
    response: ServerResponse,
    status: number,
    body: Record<string, unknown>,
  ) => {
    response.writeHead(status, {
      ...cors(request),
      "cache-control": "no-store",
      "content-type": "application/json",
    });
    response.end(JSON.stringify(body));
  };
  const install = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (request.method === "OPTIONS") {
      response.writeHead(
        request.headers.origin === origin ? 204 : 403,
        cors(request),
      );
      response.end();
      return;
    }
    if (
      request.headers.origin !== undefined &&
      request.headers.origin !== origin
    )
      return answer(request, response, 403, { error: CUSTOM_WORDS.invalid });
    let raw: Buffer;
    try {
      raw = await rawBodyOf(request, 16 * 1024);
    } catch (error) {
      if (!(error instanceof BodyTooLargeError)) throw error;
      request.resume();
      return answer(request, response, 413, { error: CUSTOM_WORDS.invalid });
    }
    let parsed: InstallRequest;
    try {
      parsed = installRequestSchema.parse(JSON.parse(raw.toString("utf8")));
    } catch {
      return answer(request, response, 400, { error: CUSTOM_WORDS.invalid });
    }
    const done = await installCustomApp(dependencies, parsed);
    answer(
      request,
      response,
      done.ok ? 200 : 400,
      done.ok
        ? {
            bot_events: done.botEvents,
            connected: true,
            name: done.name,
            request_url: done.requestUrl,
          }
        : { error: done.error },
    );
  };
  const events = async (
    request: IncomingMessage & {
      params?: Record<string, string | string[] | undefined>;
    },
    response: ServerResponse,
  ): Promise<void> => {
    const send = (status: number, body?: unknown) => {
      response.writeHead(status, {
        "cache-control": "no-store",
        "content-type": "application/json",
      });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    const header = (name: string): string | undefined => {
      const value = request.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    const given = request.params?.appId;
    const appId = typeof given === "string" ? given : "";
    const app = /^A[A-Z0-9]{2,32}$/.test(appId)
      ? await dependencies.store.getCustomApp(appId)
      : undefined;
    if (!app) return send(404, { error: CUSTOM_WORDS.unknownApp });
    let raw: Buffer;
    try {
      raw = await rawBodyOf(request);
    } catch (error) {
      if (!(error instanceof BodyTooLargeError)) throw error;
      request.resume();
      return send(413, { error: CUSTOM_WORDS.invalid });
    }
    try {
      verifySlackRequest({
        body: raw.toString("utf8"),
        headers: {
          "x-slack-request-timestamp": Number(
            header("x-slack-request-timestamp"),
          ),
          "x-slack-signature": header("x-slack-signature") ?? "",
        },
        nowMilliseconds: (dependencies.now ?? (() => new Date()))().getTime(),
        signingSecret: app.signingSecret,
      });
    } catch {
      return send(401, { error: CUSTOM_WORDS.signature });
    }
    const body = slackBodyOf(header("content-type"), raw.toString("utf8"));
    if (!body) return send(400, { error: CUSTOM_WORDS.invalid });
    if (body.type === "url_verification")
      return send(200, { challenge: body.challenge });
    if (body.ssl_check) return send(200);
    // The request is this app's: a body naming another app is not handed on.
    if (typeof body.api_app_id === "string" && body.api_app_id !== appId)
      return send(400, { error: CUSTOM_WORDS.signature });
    let acked: unknown;
    let wasAcked = false;
    await dependencies.bolt.processEvent({
      ack: async (value?: unknown) => {
        wasAcked = true;
        acked = value;
      },
      body,
      retryNum: Number(header("x-slack-retry-num")) || undefined,
      retryReason: header("x-slack-retry-reason"),
    });
    if (!wasAcked) {
      // Nothing claimed the request (no listener, or authorization refused
      // it): 200 all the same, so that Slack does not post it again.
      dependencies.logger.warn("custom_events.unacked", { app: appId });
      return send(200);
    }
    if (acked === undefined || acked === "") return send(200);
    if (typeof acked === "string") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(acked);
      return;
    }
    send(200, acked);
  };
  return [
    {
      handler: (request, response) => void install(request, response),
      method: ["POST", "OPTIONS"],
      path: CUSTOM_INSTALL_PATH,
    },
    {
      handler: (request, response) => void events(request, response),
      method: ["POST"],
      path: CUSTOM_EVENTS_ROUTE,
    },
  ];
}
