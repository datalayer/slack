import type { Pool } from "pg";

import type { EncryptedSecret, SecretCipher } from "./crypto.js";
import {
  installationKey,
  type ApprovalCard,
  type SlackInstallation,
  type SlackInstallationKey,
  type SlackUserLink,
  type ThreadBinding,
  type ThreadKey,
} from "./domain.js";
import type { SlackStore } from "./store.js";

const enterprise = (value?: string): string => value ?? "";
const dateString = (value: Date | string): string =>
  new Date(value).toISOString();

type InstallationRow = Readonly<{
  app_id: string;
  bot_token: EncryptedSecret;
  bot_user_id: string;
  datalayer_host_key: EncryptedSecret | null;
  datalayer_host_uid: string | null;
  datalayer_organization_id: string | null;
  delivery_secret: EncryptedSecret | null;
  enterprise_id: string;
  installed_by: string;
  scopes: string[];
  status: "active" | "disconnected";
  team_id: string;
  updated_at: Date | string;
}>;

type LinkRow = Readonly<{
  app_id: string;
  datalayer_principal_id: string;
  enterprise_id: string;
  linked_at: Date | string;
  slack_user_id: string;
  status: "active" | "revoked";
  team_id: string;
}>;

type ThreadRow = Readonly<{
  app_id: string;
  application_id: string;
  channel_id: string;
  enterprise_id: string;
  opened_by_principal_id: string;
  session_id: string;
  team_id: string;
  pending_message_ts: string | null;
  thread_ts: string;
  updated_at: Date | string;
}>;

type CardRow = Readonly<{
  app_id: string;
  approval_id: string;
  channel_id: string;
  decided_by_slack_user_id: string | null;
  deployment_uid: string;
  enterprise_id: string;
  kind: "card" | "waiting";
  message_ts: string;
  slack_user_id: string;
  team_id: string;
  thread_ts: string | null;
  tool_name: string;
}>;

/** What a host key and a delivery secret are encrypted with: bound to their installation. */
const hostKeyData = (key: SlackInstallationKey): string =>
  `host-key:${installationKey(key)}`;
const deliverySecretData = (key: SlackInstallationKey): string =>
  `delivery-secret:${installationKey(key)}`;

export class PostgresSlackStore implements SlackStore {
  constructor(
    readonly database: Pool,
    readonly cipher: SecretCipher,
  ) {}

  async claimEvent(eventId: string): Promise<boolean> {
    const result = await this.database.query(
      "INSERT INTO slack_event_claims (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id",
      [eventId],
    );
    return result.rowCount === 1;
  }

  async releaseEvent(eventId: string): Promise<void> {
    await this.database.query(
      "DELETE FROM slack_event_claims WHERE event_id = $1",
      [eventId],
    );
  }

  async getApprovalCards(
    key: SlackInstallationKey,
    approvalId: string,
  ): Promise<ApprovalCard[]> {
    const result = await this.database.query<CardRow>(
      `SELECT * FROM slack_approval_cards
       WHERE app_id = $1 AND enterprise_id = $2 AND team_id = $3 AND approval_id = $4
       ORDER BY created_at`,
      [key.appId, enterprise(key.enterpriseId), key.teamId, approvalId],
    );
    return result.rows.map((row) => ({
      appId: row.app_id,
      approvalId: row.approval_id,
      channelId: row.channel_id,
      decidedBySlackUserId: row.decided_by_slack_user_id ?? undefined,
      deploymentUid: row.deployment_uid,
      enterpriseId: row.enterprise_id || undefined,
      kind: row.kind,
      messageTs: row.message_ts,
      slackUserId: row.slack_user_id,
      teamId: row.team_id,
      threadTs: row.thread_ts ?? undefined,
      toolName: row.tool_name,
    }));
  }

  async putApprovalCard(card: ApprovalCard): Promise<void> {
    await this.database.query(
      `INSERT INTO slack_approval_cards
         (app_id, enterprise_id, team_id, approval_id, channel_id, message_ts, thread_ts,
          kind, slack_user_id, deployment_uid, tool_name, decided_by_slack_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (app_id, enterprise_id, team_id, approval_id, channel_id, message_ts)
       DO UPDATE SET decided_by_slack_user_id = EXCLUDED.decided_by_slack_user_id`,
      [
        card.appId,
        enterprise(card.enterpriseId),
        card.teamId,
        card.approvalId,
        card.channelId,
        card.messageTs,
        card.threadTs ?? null,
        card.kind,
        card.slackUserId,
        card.deploymentUid,
        card.toolName,
        card.decidedBySlackUserId ?? null,
      ],
    );
  }

  async getInstallationByHostUid(
    hostUid: string,
  ): Promise<SlackInstallation | undefined> {
    const result = await this.database.query<InstallationRow>(
      "SELECT * FROM slack_installations WHERE datalayer_host_uid = $1 AND status = 'active'",
      [hostUid],
    );
    const row = result.rows[0];
    return row ? this.#installation(row) : undefined;
  }

  async listBoundInstallations(): Promise<SlackInstallation[]> {
    const result = await this.database.query<InstallationRow>(
      "SELECT * FROM slack_installations WHERE status = 'active' AND datalayer_host_key IS NOT NULL",
    );
    return result.rows.map((row) => this.#installation(row));
  }

  async deleteInstallation(key: SlackInstallationKey): Promise<void> {
    const client = await this.database.connect();
    const values = [key.appId, enterprise(key.enterpriseId), key.teamId];
    try {
      await client.query("BEGIN");
      await client.query(
        "DELETE FROM slack_oauth_installations WHERE app_id = $1 AND enterprise_id = $2 AND team_id = $3",
        values,
      );
      await client.query(
        "DELETE FROM slack_installations WHERE app_id = $1 AND enterprise_id = $2 AND team_id = $3",
        values,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getDefaultApplication(
    key: SlackInstallationKey,
  ): Promise<string | undefined> {
    const result = await this.database.query<{ application_id: string }>(
      "SELECT application_id FROM slack_app_defaults WHERE app_id = $1 AND enterprise_id = $2 AND team_id = $3",
      [key.appId, enterprise(key.enterpriseId), key.teamId],
    );
    return result.rows[0]?.application_id;
  }

  async getInstallation(
    key: SlackInstallationKey,
  ): Promise<SlackInstallation | undefined> {
    const result = await this.database.query<InstallationRow>(
      "SELECT * FROM slack_installations WHERE app_id = $1 AND enterprise_id = $2 AND team_id = $3",
      [key.appId, enterprise(key.enterpriseId), key.teamId],
    );
    const row = result.rows[0];
    return row ? this.#installation(row) : undefined;
  }

  #installation(row: InstallationRow): SlackInstallation {
    const key: SlackInstallationKey = {
      appId: row.app_id,
      enterpriseId: row.enterprise_id || undefined,
      teamId: row.team_id,
    };
    return {
      ...key,
      botToken: this.cipher.decrypt(row.bot_token, installationKey(key)),
      botUserId: row.bot_user_id,
      datalayerHostKey: row.datalayer_host_key
        ? this.cipher.decrypt(row.datalayer_host_key, hostKeyData(key))
        : undefined,
      datalayerHostUid: row.datalayer_host_uid ?? undefined,
      datalayerOrganizationId: row.datalayer_organization_id ?? undefined,
      deliverySecret: row.delivery_secret
        ? this.cipher.decrypt(row.delivery_secret, deliverySecretData(key))
        : undefined,
      installedBy: row.installed_by,
      scopes: row.scopes,
      status: row.status,
      updatedAt: dateString(row.updated_at),
    };
  }

  async getThread(key: ThreadKey): Promise<ThreadBinding | undefined> {
    const result = await this.database.query<ThreadRow>(
      `SELECT * FROM slack_thread_bindings
       WHERE app_id = $1 AND enterprise_id = $2 AND team_id = $3
         AND channel_id = $4 AND thread_ts = $5`,
      [
        key.appId,
        enterprise(key.enterpriseId),
        key.teamId,
        key.channelId,
        key.threadTs,
      ],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      appId: row.app_id,
      applicationId: row.application_id,
      channelId: row.channel_id,
      enterpriseId: row.enterprise_id || undefined,
      openedByPrincipalId: row.opened_by_principal_id,
      pendingMessageTs: row.pending_message_ts ?? undefined,
      sessionId: row.session_id,
      teamId: row.team_id,
      threadTs: row.thread_ts,
      updatedAt: dateString(row.updated_at),
    };
  }

  async getUserLink(
    key: SlackInstallationKey,
    slackUserId: string,
  ): Promise<SlackUserLink | undefined> {
    const result = await this.database.query<LinkRow>(
      `SELECT * FROM slack_user_links
       WHERE app_id = $1 AND enterprise_id = $2 AND team_id = $3 AND slack_user_id = $4`,
      [key.appId, enterprise(key.enterpriseId), key.teamId, slackUserId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      appId: row.app_id,
      datalayerPrincipalId: row.datalayer_principal_id,
      enterpriseId: row.enterprise_id || undefined,
      linkedAt: dateString(row.linked_at),
      slackUserId: row.slack_user_id,
      status: row.status,
      teamId: row.team_id,
    };
  }

  async putInstallation(value: SlackInstallation): Promise<void> {
    const encrypted = this.cipher.encrypt(
      value.botToken,
      installationKey(value),
    );
    const hostKey = value.datalayerHostKey
      ? this.cipher.encrypt(value.datalayerHostKey, hostKeyData(value))
      : null;
    const deliverySecret = value.deliverySecret
      ? this.cipher.encrypt(value.deliverySecret, deliverySecretData(value))
      : null;
    // The host fields are kept when left out: a reinstall without a bind code
    // never forgets the workspace's key.
    await this.database.query(
      `INSERT INTO slack_installations
         (app_id, enterprise_id, team_id, bot_token, bot_user_id, datalayer_organization_id,
          installed_by, scopes, status, updated_at,
          datalayer_host_uid, datalayer_host_key, delivery_secret)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (app_id, enterprise_id, team_id) DO UPDATE SET
         bot_token = EXCLUDED.bot_token,
         bot_user_id = EXCLUDED.bot_user_id,
         datalayer_organization_id = EXCLUDED.datalayer_organization_id,
         installed_by = EXCLUDED.installed_by,
         scopes = EXCLUDED.scopes,
         status = EXCLUDED.status,
         updated_at = EXCLUDED.updated_at,
         datalayer_host_uid = COALESCE(EXCLUDED.datalayer_host_uid, slack_installations.datalayer_host_uid),
         datalayer_host_key = COALESCE(EXCLUDED.datalayer_host_key, slack_installations.datalayer_host_key),
         delivery_secret = COALESCE(EXCLUDED.delivery_secret, slack_installations.delivery_secret)`,
      [
        value.appId,
        enterprise(value.enterpriseId),
        value.teamId,
        encrypted,
        value.botUserId,
        value.datalayerOrganizationId,
        value.installedBy,
        value.scopes,
        value.status,
        value.updatedAt,
        value.datalayerHostUid ?? null,
        hostKey,
        deliverySecret,
      ],
    );
  }

  async putThread(value: ThreadBinding): Promise<void> {
    await this.database.query(
      `INSERT INTO slack_thread_bindings
         (app_id, enterprise_id, team_id, channel_id, thread_ts, application_id,
          opened_by_principal_id, session_id, updated_at, pending_message_ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (app_id, enterprise_id, team_id, channel_id, thread_ts) DO UPDATE SET
         application_id = EXCLUDED.application_id,
         opened_by_principal_id = EXCLUDED.opened_by_principal_id,
         session_id = EXCLUDED.session_id,
         updated_at = EXCLUDED.updated_at,
         pending_message_ts = EXCLUDED.pending_message_ts`,
      [
        value.appId,
        enterprise(value.enterpriseId),
        value.teamId,
        value.channelId,
        value.threadTs,
        value.applicationId,
        value.openedByPrincipalId,
        value.sessionId,
        value.updatedAt,
        value.pendingMessageTs ?? null,
      ],
    );
  }

  async putUserLink(value: SlackUserLink): Promise<void> {
    await this.database.query(
      `INSERT INTO slack_user_links
         (app_id, enterprise_id, team_id, slack_user_id, datalayer_principal_id, status, linked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (app_id, enterprise_id, team_id, slack_user_id) DO UPDATE SET
         datalayer_principal_id = EXCLUDED.datalayer_principal_id,
         status = EXCLUDED.status,
         linked_at = EXCLUDED.linked_at`,
      [
        value.appId,
        enterprise(value.enterpriseId),
        value.teamId,
        value.slackUserId,
        value.datalayerPrincipalId,
        value.status,
        value.linkedAt,
      ],
    );
  }

  async setDefaultApplication(
    key: SlackInstallationKey,
    applicationId: string,
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO slack_app_defaults (app_id, enterprise_id, team_id, application_id)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (app_id, enterprise_id, team_id) DO UPDATE SET
         application_id = EXCLUDED.application_id, updated_at = now()`,
      [key.appId, enterprise(key.enterpriseId), key.teamId, applicationId],
    );
  }
}
