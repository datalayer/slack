import type {
  Installation,
  InstallationQuery,
  InstallationStore,
} from "@slack/bolt";
import type {
  BoundHost,
  EncryptedSecret,
  SecretCipher,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import type { Pool } from "pg";

import type { SlackInstallation, SlackInstallationKey } from "./domain.js";
import type { HostInstallations } from "./host-installations.js";
import { bindCodeOfInstallation } from "./oauth-state.js";
import type { SlackStore } from "./store.js";

type OAuthRow = Readonly<{ installation: EncryptedSecret }>;

export class PostgresInstallationStore implements InstallationStore {
  constructor(
    readonly appId: string,
    readonly database: Pool,
    readonly cipher: SecretCipher,
    readonly slackStore: SlackStore,
    /** Binds the workspace at Datalayer with the Ship card's code, and keeps its key. */
    readonly hosts?: HostInstallations,
  ) {}

  async storeInstallation<AuthVersion extends "v1" | "v2">(
    installation: Installation<AuthVersion, boolean>,
  ): Promise<void> {
    const teamId = installation.team?.id;
    if (!teamId || installation.isEnterpriseInstall) {
      throw new Error(
        "Enterprise Grid organization-wide installation is not supported yet.",
      );
    }
    if (!installation.bot)
      throw new Error("The Datalayer Slack app requires a bot installation.");
    const appId = installation.appId ?? this.appId;
    const domainKey = {
      appId,
      enterpriseId: installation.enterprise?.id,
      teamId,
    };
    // Bound first: an expired or spent code stores nothing, and the person
    // installs again from the Ship tab.
    const code = bindCodeOfInstallation(installation);
    let bound: BoundHost | undefined;
    if (code && this.hosts)
      bound = await this.hosts.bind(domainKey, code, installation.team?.name, {
        provider: "datalayer",
      });
    const key = oauthKey(appId, installation.enterprise?.id, teamId);
    // Kept without its metadata: the bind code is spent once here, and Bolt's
    // token refresh stores the fetched installation again (S-102).
    const encrypted = this.cipher.encrypt(
      JSON.stringify({ ...installation, metadata: undefined }),
      key,
    );
    await this.database.query(
      `INSERT INTO slack_oauth_installations
         (app_id, enterprise_id, team_id, installation, updated_at)
       VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (app_id, enterprise_id, team_id) DO UPDATE SET
         installation = EXCLUDED.installation, updated_at = now()`,
      [appId, installation.enterprise?.id ?? "", teamId, encrypted],
    );

    const kept: SlackInstallation = {
      ...domainKey,
      botToken: installation.bot.token,
      botRefreshToken: installation.bot.refreshToken,
      botTokenExpiresAt: installation.bot.expiresAt,
      botUserId: installation.bot.userId,
      installedBy: installation.user.id,
      scopes: installation.bot.scopes,
      status: "active",
      updatedAt: new Date().toISOString(),
    };
    if (this.hosts) await this.hosts.keep(kept, bound);
    else await this.slackStore.putInstallation(kept);
  }

  async fetchInstallation(
    query: InstallationQuery<boolean>,
  ): Promise<Installation<"v1" | "v2", boolean>> {
    if (!query.teamId || query.isEnterpriseInstall) {
      throw new Error(
        "Enterprise Grid organization-wide installation is not supported yet.",
      );
    }
    const key = oauthKey(this.appId, query.enterpriseId, query.teamId);
    const result = await this.database.query<OAuthRow>(
      `SELECT installation FROM slack_oauth_installations
       WHERE app_id = $1 AND enterprise_id = $2 AND team_id = $3`,
      [this.appId, query.enterpriseId ?? "", query.teamId],
    );
    const encrypted = result.rows[0]?.installation;
    if (!encrypted) throw new Error("No active Slack installation was found.");
    return JSON.parse(this.cipher.decrypt(encrypted, key)) as Installation<
      "v1" | "v2",
      boolean
    >;
  }

  /**
   * A bot token the worker refreshed (`BotTokens`): Bolt's own row follows, so
   * its `authorize` reads the same token and refresh token.
   */
  async rotateBot(
    key: SlackInstallationKey,
    installation: SlackInstallation,
  ): Promise<void> {
    const query = {
      enterpriseId: key.enterpriseId,
      isEnterpriseInstall: false,
      teamId: key.teamId,
    };
    const stored = await this.fetchInstallation(query);
    if (!stored.bot)
      throw new Error("The Datalayer Slack app requires a bot installation.");
    const next = {
      ...stored,
      bot: {
        ...stored.bot,
        expiresAt: installation.botTokenExpiresAt,
        refreshToken: installation.botRefreshToken,
        token: installation.botToken,
      },
    };
    await this.database.query(
      `UPDATE slack_oauth_installations SET installation = $4, updated_at = now()
       WHERE app_id = $1 AND enterprise_id = $2 AND team_id = $3`,
      [
        this.appId,
        key.enterpriseId ?? "",
        key.teamId,
        this.cipher.encrypt(
          JSON.stringify(next),
          oauthKey(this.appId, key.enterpriseId, key.teamId),
        ),
      ],
    );
  }

  async deleteInstallation(query: InstallationQuery<boolean>): Promise<void> {
    if (!query.teamId || query.isEnterpriseInstall) return;
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM slack_oauth_installations
         WHERE app_id = $1 AND enterprise_id = $2 AND team_id = $3`,
        [this.appId, query.enterpriseId ?? "", query.teamId],
      );
      await client.query(
        `DELETE FROM slack_installations
         WHERE app_id = $1 AND enterprise_id = $2 AND team_id = $3`,
        [this.appId, query.enterpriseId ?? "", query.teamId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function oauthKey(
  appId: string,
  enterpriseId: string | undefined,
  teamId: string,
): string {
  return `oauth:${appId}:${enterpriseId ?? "-"}:${teamId}`;
}
