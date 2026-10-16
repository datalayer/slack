import {
  PostgresQuotaStore,
  type EncryptedSecret,
  type QuotaEntry,
  type QuotaTake,
  type SecretCipher,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import type { Pool } from "pg";

import {
  type AppAllowance,
  type IncomingPrompt,
  type ChannelBinding,
  type SlackDelivery,
  type ThreadTurn,
  type TurnClaim,
  installationKey,
  type ApprovalCard,
  type SlackInstallation,
  type SlackInstallationKey,
  type SlackUserLink,
  type ThreadBinding,
  type ThreadKey,
} from "./domain.js";
import { turnIsStale, type RotatedBotToken, type SlackStore } from "./store.js";

const enterprise = (value?: string): string => value ?? "";
const dateString = (value: Date | string): string =>
  new Date(value).toISOString();

type InstallationRow = Readonly<{
  app_id: string;
  bot_token: EncryptedSecret;
  bot_refresh_token: EncryptedSecret | null;
  bot_token_expires_at: string | number | null;
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
  last_event_id: string | null;
  last_run_id: string | null;
  visibility: "channel" | "direct" | null;
  thread_ts: string;
  updated_at: Date | string;
}>;

type TurnRow = Readonly<{
  app_id: string;
  channel_id: string;
  enterprise_id: string;
  event_id: string;
  heartbeat_at: Date | string | null;
  message_ts: string | null;
  run_id: string | null;
  session_id: string | null;
  started_at: Date | string;
  state: "running" | "done";
  stopped_by: string | null;
  team_id: string;
  thread_ts: string;
}>;

const threadValues = (key: ThreadKey): string[] => [
  key.appId,
  enterprise(key.enterpriseId),
  key.teamId,
  key.channelId,
  key.threadTs,
];

const THREAD_WHERE =
  "app_id = $1 AND enterprise_id = $2 AND team_id = $3 AND channel_id = $4 AND thread_ts = $5";

function turnOfRow(row: TurnRow): ThreadTurn {
  return {
    appId: row.app_id,
    channelId: row.channel_id,
    enterpriseId: row.enterprise_id || undefined,
    eventId: row.event_id,
    heartbeatAt: row.heartbeat_at ? dateString(row.heartbeat_at) : undefined,
    messageTs: row.message_ts ?? undefined,
    runId: row.run_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    startedAt: dateString(row.started_at),
    stoppedBy: row.stopped_by ?? undefined,
    state: row.state,
    teamId: row.team_id,
    threadTs: row.thread_ts,
  };
}

function bindingOfRow(row: ThreadRow): ThreadBinding {
  return {
    appId: row.app_id,
    applicationId: row.application_id,
    channelId: row.channel_id,
    enterpriseId: row.enterprise_id || undefined,
    lastEventId: row.last_event_id ?? undefined,
    lastRunId: row.last_run_id ?? undefined,
    openedByPrincipalId: row.opened_by_principal_id,
    pendingMessageTs: row.pending_message_ts ?? undefined,
    sessionId: row.session_id,
    teamId: row.team_id,
    threadTs: row.thread_ts,
    updatedAt: dateString(row.updated_at),
    visibility: row.visibility ?? undefined,
  };
}

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
const refreshTokenData = (key: SlackInstallationKey): string =>
  `bot-refresh-token:${installationKey(key)}`;
const hostKeyData = (key: SlackInstallationKey): string =>
  `host-key:${installationKey(key)}`;
const deliverySecretData = (key: SlackInstallationKey): string =>
  `delivery-secret:${installationKey(key)}`;

export class PostgresSlackStore implements SlackStore {
  readonly #quotas: PostgresQuotaStore;

  constructor(
    readonly database: Pool,
    readonly cipher: SecretCipher,
  ) {
    this.#quotas = new PostgresQuotaStore(database, { tablePrefix: "slack" });
  }

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
      botRefreshToken: row.bot_refresh_token
        ? this.cipher.decrypt(row.bot_refresh_token, refreshTokenData(key))
        : undefined,
      botTokenExpiresAt:
        row.bot_token_expires_at === null
          ? undefined
          : Number(row.bot_token_expires_at),
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
      `SELECT * FROM slack_thread_bindings WHERE ${THREAD_WHERE}`,
      threadValues(key),
    );
    const row = result.rows[0];
    return row ? bindingOfRow(row) : undefined;
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
    const refreshToken = value.botRefreshToken
      ? this.cipher.encrypt(value.botRefreshToken, refreshTokenData(value))
      : null;
    // The host fields are kept when left out: a reinstall without a bind code
    // never forgets the workspace's key.
    await this.database.query(
      `INSERT INTO slack_installations
         (app_id, enterprise_id, team_id, bot_token, bot_user_id, datalayer_organization_id,
          installed_by, scopes, status, updated_at,
          datalayer_host_uid, datalayer_host_key, delivery_secret,
          bot_refresh_token, bot_token_expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (app_id, enterprise_id, team_id) DO UPDATE SET
         bot_token = EXCLUDED.bot_token,
         bot_refresh_token = EXCLUDED.bot_refresh_token,
         bot_token_expires_at = EXCLUDED.bot_token_expires_at,
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
        refreshToken,
        value.botTokenExpiresAt ?? null,
      ],
    );
  }

  async rotateBotToken(
    key: SlackInstallationKey,
    rotated: RotatedBotToken,
  ): Promise<boolean> {
    // Only an active row is updated: a workspace uninstalled while its token
    // was refreshed is never revived (S-106).
    const result = await this.database.query(
      `UPDATE slack_installations SET
         bot_token = $4, bot_refresh_token = $5, bot_token_expires_at = $6,
         updated_at = $7
       WHERE app_id = $1 AND enterprise_id = $2 AND team_id = $3
         AND status = 'active'`,
      [
        key.appId,
        enterprise(key.enterpriseId),
        key.teamId,
        this.cipher.encrypt(rotated.botToken, installationKey(key)),
        this.cipher.encrypt(rotated.botRefreshToken, refreshTokenData(key)),
        rotated.botTokenExpiresAt,
        rotated.updatedAt,
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async putThread(value: ThreadBinding): Promise<void> {
    await this.database.query(
      `INSERT INTO slack_thread_bindings
         (app_id, enterprise_id, team_id, channel_id, thread_ts, application_id,
          opened_by_principal_id, session_id, updated_at, pending_message_ts,
          last_event_id, last_run_id, visibility)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (app_id, enterprise_id, team_id, channel_id, thread_ts) DO UPDATE SET
         application_id = EXCLUDED.application_id,
         opened_by_principal_id = EXCLUDED.opened_by_principal_id,
         session_id = EXCLUDED.session_id,
         updated_at = EXCLUDED.updated_at,
         pending_message_ts = EXCLUDED.pending_message_ts,
         last_event_id = EXCLUDED.last_event_id,
         last_run_id = EXCLUDED.last_run_id,
         visibility = EXCLUDED.visibility`,
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
        value.lastEventId ?? null,
        value.lastRunId ?? null,
        value.visibility ?? null,
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

  async getAllowances(key: SlackInstallationKey): Promise<AppAllowance[]> {
    const result = await this.database.query<{
      application_id: string;
      channel_policy: "channels" | "direct-only";
      configured_by: string;
      enabled: boolean;
      is_default: boolean;
      name: string;
      updated_at: Date | string;
    }>(
      `SELECT * FROM slack_app_allowances
       WHERE app_id = $1 AND enterprise_id = $2 AND team_id = $3
       ORDER BY is_default DESC, name, application_id`,
      [key.appId, enterprise(key.enterpriseId), key.teamId],
    );
    return result.rows.map((row) => ({
      appId: key.appId,
      applicationId: row.application_id,
      channelPolicy: row.channel_policy,
      configuredBy: row.configured_by,
      enabled: row.enabled,
      enterpriseId: key.enterpriseId,
      isDefault: row.is_default,
      name: row.name,
      teamId: key.teamId,
      updatedAt: dateString(row.updated_at),
    }));
  }

  async putAllowances(
    key: SlackInstallationKey,
    allowances: readonly AppAllowance[],
  ): Promise<void> {
    const client = await this.database.connect();
    const values = [key.appId, enterprise(key.enterpriseId), key.teamId];
    try {
      await client.query("BEGIN");
      await client.query(
        "DELETE FROM slack_app_allowances WHERE app_id = $1 AND enterprise_id = $2 AND team_id = $3",
        values,
      );
      for (const one of allowances)
        await client.query(
          `INSERT INTO slack_app_allowances
             (app_id, enterprise_id, team_id, application_id, name, enabled, is_default,
              channel_policy, configured_by, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            ...values,
            one.applicationId,
            one.name,
            one.enabled,
            one.isDefault,
            one.channelPolicy,
            one.configuredBy,
            one.updatedAt,
          ],
        );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getChannelBinding(
    key: SlackInstallationKey,
    channelId: string,
  ): Promise<ChannelBinding | undefined> {
    const result = await this.database.query<{
      application_id: string | null;
      state: "allow" | "deny";
      updated_at: Date | string;
      updated_by: string;
    }>(
      `SELECT * FROM slack_channel_bindings
       WHERE app_id = $1 AND enterprise_id = $2 AND team_id = $3 AND channel_id = $4`,
      [key.appId, enterprise(key.enterpriseId), key.teamId, channelId],
    );
    const row = result.rows[0];
    return row
      ? {
          appId: key.appId,
          applicationId: row.application_id ?? undefined,
          channelId,
          enterpriseId: key.enterpriseId,
          state: row.state,
          teamId: key.teamId,
          updatedAt: dateString(row.updated_at),
          updatedBy: row.updated_by,
        }
      : undefined;
  }

  async putChannelBindings(
    key: SlackInstallationKey,
    bindings: readonly ChannelBinding[],
  ): Promise<void> {
    const client = await this.database.connect();
    const values = [key.appId, enterprise(key.enterpriseId), key.teamId];
    try {
      await client.query("BEGIN");
      await client.query(
        "DELETE FROM slack_channel_bindings WHERE app_id = $1 AND enterprise_id = $2 AND team_id = $3",
        values,
      );
      for (const binding of bindings)
        await client.query(
          `INSERT INTO slack_channel_bindings
             (app_id, enterprise_id, team_id, channel_id, application_id, state, updated_by, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            ...values,
            binding.channelId,
            binding.applicationId ?? null,
            binding.state,
            binding.updatedBy,
            binding.updatedAt,
          ],
        );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getDelivery(
    key: SlackInstallationKey,
    deliveryId: string,
  ): Promise<SlackDelivery | undefined> {
    const result = await this.database.query<{
      attempts: number;
      last_error: string | null;
      payload_version: number;
      slack_ts: string | null;
      status: SlackDelivery["status"];
      target: Record<string, unknown>;
      updated_at: Date | string;
    }>(
      `SELECT * FROM slack_deliveries
       WHERE app_id = $1 AND enterprise_id = $2 AND team_id = $3 AND delivery_id = $4`,
      [key.appId, enterprise(key.enterpriseId), key.teamId, deliveryId],
    );
    const row = result.rows[0];
    return row
      ? {
          appId: key.appId,
          attempts: row.attempts,
          deliveryId,
          enterpriseId: key.enterpriseId,
          lastError: row.last_error ?? undefined,
          payloadVersion: row.payload_version,
          slackTs: row.slack_ts ?? undefined,
          status: row.status,
          target: row.target,
          teamId: key.teamId,
          updatedAt: dateString(row.updated_at),
        }
      : undefined;
  }

  async putDelivery(delivery: SlackDelivery): Promise<void> {
    await this.database.query(
      `INSERT INTO slack_deliveries
         (app_id, enterprise_id, team_id, delivery_id, target, payload_version, status,
          attempts, last_error, slack_ts, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (app_id, enterprise_id, team_id, delivery_id) DO UPDATE SET
         target = EXCLUDED.target,
         payload_version = EXCLUDED.payload_version,
         status = EXCLUDED.status,
         attempts = EXCLUDED.attempts,
         last_error = EXCLUDED.last_error,
         slack_ts = EXCLUDED.slack_ts,
         updated_at = EXCLUDED.updated_at`,
      [
        delivery.appId,
        enterprise(delivery.enterpriseId),
        delivery.teamId,
        delivery.deliveryId,
        delivery.target,
        delivery.payloadVersion,
        delivery.status,
        delivery.attempts,
        delivery.lastError?.slice(0, 2_000) ?? null,
        delivery.slackTs ?? null,
        delivery.updatedAt,
      ],
    );
  }

  async archiveThread(binding: ThreadBinding, reason: string): Promise<void> {
    await this.database.query(
      `INSERT INTO slack_thread_binding_history
         (app_id, enterprise_id, team_id, channel_id, thread_ts, binding, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [...threadValues(binding), binding, reason],
    );
  }

  async getArchivedThreads(key: ThreadKey): Promise<ThreadBinding[]> {
    const result = await this.database.query<{ binding: ThreadBinding }>(
      `SELECT binding FROM slack_thread_binding_history WHERE ${THREAD_WHERE} ORDER BY id`,
      threadValues(key),
    );
    return result.rows.map((row) => row.binding);
  }

  async beginTurn(
    key: ThreadKey,
    eventId: string,
    now: Date,
    staleAfterMs: number,
  ): Promise<TurnClaim> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      // The thread's lock, held to the end of this transaction, whether or
      // not its turn row exists yet: `FOR UPDATE` alone locks no row on a
      // thread's first turn, and two workers would both start (S-207).
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`slack_thread_turns:${JSON.stringify(threadValues(key))}`],
      );
      const finished = await client.query(
        `SELECT 1 FROM slack_finished_events WHERE ${THREAD_WHERE} AND event_id = $6`,
        [...threadValues(key), eventId],
      );
      const locked = await client.query<TurnRow>(
        `SELECT * FROM slack_thread_turns WHERE ${THREAD_WHERE} FOR UPDATE`,
        threadValues(key),
      );
      const current = locked.rows[0] ? turnOfRow(locked.rows[0]) : undefined;
      let claim: TurnClaim | undefined;
      if (finished.rowCount)
        claim = {
          outcome: "done",
          turn:
            current?.eventId === eventId
              ? current
              : {
                  ...key,
                  eventId,
                  startedAt: now.toISOString(),
                  state: "done",
                },
        };
      else if (current?.eventId === eventId)
        claim =
          current.state === "running"
            ? { outcome: "resumed", turn: current }
            : { outcome: "done", turn: current };
      else if (
        current?.state === "running" &&
        !turnIsStale(current, now, staleAfterMs)
      )
        claim = { outcome: "busy", turn: current };
      if (!claim) {
        const started = await client.query<TurnRow>(
          `INSERT INTO slack_thread_turns
             (app_id, enterprise_id, team_id, channel_id, thread_ts, event_id, state, started_at)
           VALUES ($1,$2,$3,$4,$5,$6,'running',$7)
           ON CONFLICT (app_id, enterprise_id, team_id, channel_id, thread_ts) DO UPDATE SET
             event_id = EXCLUDED.event_id, state = 'running', started_at = EXCLUDED.started_at,
             heartbeat_at = NULL, run_id = NULL, message_ts = NULL, session_id = NULL,
             stopped_by = NULL
           RETURNING *`,
          [...threadValues(key), eventId, now.toISOString()],
        );
        claim = {
          outcome: "started",
          turn: turnOfRow(started.rows[0] as TurnRow),
        };
      }
      await client.query("COMMIT");
      return claim;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async updateTurn(
    key: ThreadKey,
    eventId: string,
    patch: Partial<
      Pick<ThreadTurn, "heartbeatAt" | "messageTs" | "runId" | "sessionId">
    >,
  ): Promise<void> {
    await this.database.query(
      `UPDATE slack_thread_turns SET
         message_ts = COALESCE($7, message_ts),
         run_id = COALESCE($8, run_id),
         session_id = COALESCE($9, session_id),
         heartbeat_at = COALESCE($10, heartbeat_at)
       WHERE ${THREAD_WHERE} AND event_id = $6`,
      [
        ...threadValues(key),
        eventId,
        patch.messageTs ?? null,
        patch.runId ?? null,
        patch.sessionId ?? null,
        patch.heartbeatAt ?? null,
      ],
    );
  }

  async markStopped(
    key: ThreadKey,
    eventId: string,
    slackUserId: string | undefined,
  ): Promise<void> {
    await this.database.query(
      `UPDATE slack_thread_turns SET stopped_by = $7
       WHERE ${THREAD_WHERE} AND event_id = $6`,
      [...threadValues(key), eventId, slackUserId ?? null],
    );
  }

  async endTurn(key: ThreadKey, eventId: string): Promise<void> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO slack_finished_events
           (app_id, enterprise_id, team_id, channel_id, thread_ts, event_id)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [...threadValues(key), eventId],
      );
      await client.query(
        `UPDATE slack_thread_turns SET state = 'done' WHERE ${THREAD_WHERE} AND event_id = $6`,
        [...threadValues(key), eventId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getTurn(key: ThreadKey): Promise<ThreadTurn | undefined> {
    const result = await this.database.query<TurnRow>(
      `SELECT * FROM slack_thread_turns WHERE ${THREAD_WHERE}`,
      threadValues(key),
    );
    return result.rows[0] ? turnOfRow(result.rows[0]) : undefined;
  }

  async holdPrompt(prompt: IncomingPrompt): Promise<void> {
    await this.database.query(
      `INSERT INTO slack_held_prompts (app_id, enterprise_id, team_id, event_id, slack_user_id, prompt)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [
        prompt.appId,
        enterprise(prompt.enterpriseId),
        prompt.teamId,
        prompt.eventId,
        prompt.userId,
        prompt,
      ],
    );
  }

  async takeHeldPrompt(
    key: SlackInstallationKey,
    eventId: string,
    slackUserId: string,
  ): Promise<IncomingPrompt | undefined> {
    const result = await this.database.query<{ prompt: IncomingPrompt }>(
      `DELETE FROM slack_held_prompts
       WHERE app_id = $1 AND enterprise_id = $2 AND team_id = $3 AND event_id = $4
         AND slack_user_id = $5 AND created_at > now() - interval '1 hour'
       RETURNING prompt`,
      [
        key.appId,
        enterprise(key.enterpriseId),
        key.teamId,
        eventId,
        slackUserId,
      ],
    );
    return result.rows[0]?.prompt;
  }

  async deleteThread(key: ThreadKey): Promise<void> {
    await this.database.query(
      `DELETE FROM slack_thread_bindings WHERE ${THREAD_WHERE}`,
      threadValues(key),
    );
  }

  async setNextApplication(
    key: ThreadKey,
    applicationId: string,
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO slack_thread_next_application
         (app_id, enterprise_id, team_id, channel_id, thread_ts, application_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (app_id, enterprise_id, team_id, channel_id, thread_ts) DO UPDATE SET
         application_id = EXCLUDED.application_id, chosen_at = now()`,
      [...threadValues(key), applicationId],
    );
  }

  async getNextApplication(key: ThreadKey): Promise<string | undefined> {
    const result = await this.database.query<{ application_id: string }>(
      `SELECT application_id FROM slack_thread_next_application WHERE ${THREAD_WHERE}`,
      threadValues(key),
    );
    return result.rows[0]?.application_id;
  }

  async clearNextApplication(key: ThreadKey): Promise<void> {
    await this.database.query(
      `DELETE FROM slack_thread_next_application WHERE ${THREAD_WHERE}`,
      threadValues(key),
    );
  }

  async takeQuota(
    entries: readonly QuotaEntry[],
    period: string,
  ): Promise<QuotaTake> {
    return this.#quotas.takeQuota(entries, period);
  }

  async quotaUsed(key: string, period: string): Promise<number> {
    return this.#quotas.quotaUsed(key, period);
  }
}
