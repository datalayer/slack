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

import {
  installationKey,
  type SlackInstallation,
  type SlackInstallationKey,
} from "./domain.js";
import type { HostInstallations } from "./host-installations.js";
import { bindCodeOfInstallation } from "./oauth-state.js";
import { KINDS } from "./solr-store.js";
import type { SolrRecords } from "./solr/records.js";
import type { SlackStore } from "./store.js";

type KeptOAuth = Readonly<{ installation: EncryptedSecret }>;

/** What this store asks of the records: a keyed record read, kept and changed. */
export type KeyedRecords = Pick<SolrRecords, "get" | "put" | "update">;

/**
 * Bolt's own installations (what its `authorize` reads), encrypted whole, in
 * the `slack` collection beside the store's (`oauth_installation`, one per
 * workspace, removed with the workspace's other records).
 */
export class SolrInstallationStore implements InstallationStore {
  constructor(
    readonly appId: string,
    readonly records: KeyedRecords,
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
    await this.records.put<KeptOAuth>(
      KINDS.oauth,
      key,
      { installation: encrypted },
      { installation_s: installationKey(domainKey) },
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
    const encrypted = (await this.records.get<KeptOAuth>(KINDS.oauth, key))
      ?.installation;
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
    const kept = oauthKey(this.appId, key.enterpriseId, key.teamId);
    await this.records.update<KeptOAuth>(KINDS.oauth, kept, (before) =>
      before
        ? {
            fields: {
              installation_s: installationKey({ ...key, appId: this.appId }),
            },
            record: {
              installation: this.cipher.encrypt(JSON.stringify(next), kept),
            },
          }
        : undefined,
    );
  }

  async deleteInstallation(query: InstallationQuery<boolean>): Promise<void> {
    if (!query.teamId || query.isEnterpriseInstall) return;
    // Bolt's installation, the store's and every record of the workspace.
    await this.slackStore.deleteInstallation({
      appId: this.appId,
      enterpriseId: query.enterpriseId,
      teamId: query.teamId,
    });
  }
}

function oauthKey(
  appId: string,
  enterpriseId: string | undefined,
  teamId: string,
): string {
  return `oauth:${appId}:${enterpriseId ?? "-"}:${teamId}`;
}
