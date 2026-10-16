import type { WebClient } from "@slack/web-api";

import {
  installationKey,
  type SlackInstallation,
  type SlackInstallationKey,
} from "./domain.js";
import type { SlackStore } from "./store.js";

/**
 * Refreshed this long before it expires: Bolt's own margin, so a token read by
 * the worker and one read by Bolt's `authorize` agree (§12.2, token refresh).
 */
export const REFRESH_BEFORE_MS = 2 * 60 * 60 * 1000;

export type RefreshedBotToken = Readonly<{
  accessToken: string;
  refreshToken: string;
  /** Seconds from now. */
  expiresIn: number;
}>;

/** Exchanges a refresh token at Slack (`oauth.v2.access`, `grant_type=refresh_token`). */
export type RefreshBotToken = (
  refreshToken: string,
) => Promise<RefreshedBotToken>;

export type BotTokensOptions = Readonly<{
  /** Unset: a rotating token cannot be refreshed and is refused once due. */
  refresh?: RefreshBotToken;
  /** Told after a refresh is kept: Bolt's own installation row follows. */
  rotated?: (
    key: SlackInstallationKey,
    installation: SlackInstallation,
  ) => Promise<void>;
  now?: () => number;
}>;

/**
 * The workspace's bot token for every worker call (answers, updates, streams,
 * deliveries, approval cards, App Home). With token rotation the stored token
 * lives twelve hours; a worker post after a quiet spell, when no inbound
 * event made Bolt's `authorize` refresh it, refreshes it here first (S-102).
 */
export class BotTokens {
  readonly #inFlight = new Map<string, Promise<string>>();
  readonly #now: () => number;

  constructor(
    readonly store: SlackStore,
    readonly options: BotTokensOptions = {},
  ) {
    this.#now = options.now ?? Date.now;
  }

  async token(key: SlackInstallationKey): Promise<string> {
    const installation = await this.#active(key);
    if (!this.#due(installation)) return installation.botToken;
    // One refresh per workspace in this process at a time: concurrent posts
    // wait for the same exchange.
    const id = installationKey(key);
    const running = this.#inFlight.get(id);
    if (running) return running;
    const refreshing = this.#refresh(key).finally(() =>
      this.#inFlight.delete(id),
    );
    this.#inFlight.set(id, refreshing);
    return refreshing;
  }

  async #active(key: SlackInstallationKey): Promise<SlackInstallation> {
    const installation = await this.store.getInstallation(key);
    if (!installation || installation.status !== "active")
      throw new Error("No active Slack installation was found.");
    return installation;
  }

  #due(installation: SlackInstallation): boolean {
    return (
      installation.botTokenExpiresAt !== undefined &&
      installation.botTokenExpiresAt * 1000 - this.#now() <= REFRESH_BEFORE_MS
    );
  }

  async #refresh(key: SlackInstallationKey): Promise<string> {
    // Read again: another replica (or Bolt's authorize) may have refreshed it.
    const installation = await this.#active(key);
    if (!this.#due(installation)) return installation.botToken;
    if (!installation.botRefreshToken)
      throw new Error(
        "This workspace's bot token expires and no refresh token was kept: install @Datalayer again.",
      );
    if (!this.options.refresh)
      throw new Error(
        "A rotating bot token needs SLACK_CLIENT_ID and SLACK_CLIENT_SECRET to be refreshed.",
      );
    const refreshed = await this.options.refresh(installation.botRefreshToken);
    const now = this.#now();
    const rotated = {
      botRefreshToken: refreshed.refreshToken,
      botToken: refreshed.accessToken,
      botTokenExpiresAt: Math.floor(now / 1000) + refreshed.expiresIn,
      updatedAt: new Date(now).toISOString(),
    };
    if (!(await this.store.rotateBotToken(key, rotated)))
      throw new Error("No active Slack installation was found.");
    await this.options.rotated?.(key, { ...installation, ...rotated });
    return rotated.botToken;
  }
}

/** The refresh at Slack, with the app's client id and secret. */
export function slackTokenRefresh(
  client: Pick<WebClient, "oauth">,
  clientId: string,
  clientSecret: string,
): RefreshBotToken {
  return async (refreshToken) => {
    const response = await client.oauth.v2.access({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    if (
      !response.access_token ||
      !response.refresh_token ||
      typeof response.expires_in !== "number"
    )
      throw new Error("Slack did not return a refreshed bot token.");
    return {
      accessToken: response.access_token,
      expiresIn: response.expires_in,
      refreshToken: response.refresh_token,
    };
  };
}
