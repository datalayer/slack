import type {
  EncryptedSecret,
  QuotaEntry,
  QuotaTake,
  SecretCipher,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import {
  approvalCardKey,
  installationKey,
  threadKey,
  userLinkKey,
  type AppAllowance,
  type ApprovalCard,
  type ChannelBinding,
  type EventPolicy,
  type IncomingPrompt,
  type InboundOutcome,
  type InboundRecord,
  type InboundResult,
  type InboundState,
  type SlackCustomApp,
  type SlackDelivery,
  type SlackInstallation,
  type SlackInstallationKey,
  type SlackUserLink,
  type ThreadBinding,
  type ThreadKey,
  type ThreadTurn,
  type TurnClaim,
} from "./domain.js";
import { term } from "./solr/client.js";
import { CLAIM } from "./solr/queue.js";
import { SolrQuotaStore } from "./solr/quotas.js";
import { lockKey, type SolrRecords } from "./solr/records.js";
import { turnIsStale, type RotatedBotToken, type SlackStore } from "./store.js";

/**
 * The Slack store in the `slack` Solr collection (`solr/records.ts`): one
 * record kind per object, its natural key in `key_s`, the workspace it
 * belongs to in `installation_s` (what Postgres' `ON DELETE CASCADE` to the
 * installation was: removing an installation removes every record of it).
 * Tokens, host keys, delivery secrets and signing secrets are encrypted
 * with the service's key, bound to their installation, as they were in
 * Postgres. An inbound event's idempotency record is the queue's ingress
 * claim (`ingress:<event id>`) with its request hash (S-004).
 */
export const KINDS = {
  allowances: "allowances",
  archivedThread: "thread_history",
  card: "approval_card",
  channels: "channel_bindings",
  customApp: "custom_app",
  defaultApplication: "app_default",
  delivery: "delivery",
  eventPolicy: "event_policy",
  finished: "finished_event",
  held: "held_prompt",
  installation: "installation",
  link: "user_link",
  nextApplication: "next_application",
  oauth: "oauth_installation",
  thread: "thread",
  turn: "turn",
} as const;

const INGRESS_CLAIM = "ingress:";
/** A held prompt is taken back within the hour, or never. */
const HELD_FOR_MS = 60 * 60_000;

/** An installation as kept: its secrets encrypted. */
type KeptInstallation = Omit<
  SlackInstallation,
  "botToken" | "botRefreshToken" | "datalayerHostKey" | "deliverySecret"
> & {
  botToken: EncryptedSecret;
  botRefreshToken?: EncryptedSecret;
  datalayerHostKey?: EncryptedSecret;
  deliverySecret?: EncryptedSecret;
};

type KeptCustomApp = Omit<SlackCustomApp, "signingSecret"> & {
  signingSecret: EncryptedSecret;
};

type KeptClaim = Readonly<{
  eventId: string;
  requestHash?: string;
  expiresAt?: string;
  state?: InboundState;
  result?: InboundResult;
}>;

type KeptHeld = Readonly<{ prompt: IncomingPrompt; heldAt: string }>;

const refreshTokenData = (key: SlackInstallationKey): string =>
  `bot-refresh-token:${installationKey(key)}`;
const customAppData = (appId: string): string => `custom-app:${appId}`;
const hostKeyData = (key: SlackInstallationKey): string =>
  `host-key:${installationKey(key)}`;
const deliverySecretData = (key: SlackInstallationKey): string =>
  `delivery-secret:${installationKey(key)}`;

const of = (key: SlackInstallationKey): { installation_s: string } => ({
  installation_s: installationKey(key),
});
const keyOf = (key: SlackInstallationKey): SlackInstallationKey => ({
  appId: key.appId,
  enterpriseId: key.enterpriseId,
  teamId: key.teamId,
});

export class SolrSlackStore implements SlackStore {
  readonly #quotas: SolrQuotaStore;

  constructor(
    readonly records: SolrRecords,
    readonly cipher: SecretCipher,
  ) {
    this.#quotas = new SolrQuotaStore(records);
  }

  // -- claims and inbound records ------------------------------------------

  async claimEvent(eventId: string): Promise<boolean> {
    return this.records.create<KeptClaim>(CLAIM, eventId, { eventId });
  }

  async releaseEvent(eventId: string): Promise<void> {
    await this.records.remove(CLAIM, eventId);
  }

  async recordInbound(
    eventId: string,
    requestHash: string,
    expiresAt: Date,
  ): Promise<InboundOutcome> {
    // The claim is made with the job; a crash before this left it without a
    // hash, which the retry records. The first hash recorded stays.
    let outcome: InboundOutcome = "first";
    await this.records.update<KeptClaim>(
      CLAIM,
      `${INGRESS_CLAIM}${eventId}`,
      (before) => {
        if (before?.requestHash) {
          outcome = before.requestHash === requestHash ? "replay" : "conflict";
          return undefined;
        }
        const record: KeptClaim = {
          eventId: `${INGRESS_CLAIM}${eventId}`,
          expiresAt: expiresAt.toISOString(),
          requestHash,
          state: before?.state ?? "claimed",
        };
        return { fields: { expires_dt: expiresAt }, record };
      },
    );
    return outcome;
  }

  async settleInbound(
    eventId: string,
    state: Exclude<InboundState, "claimed">,
    result?: InboundResult,
  ): Promise<void> {
    await this.records.update<KeptClaim>(
      CLAIM,
      `${INGRESS_CLAIM}${eventId}`,
      (before) =>
        before?.requestHash
          ? {
              fields: { expires_dt: before.expiresAt },
              record: { ...before, result, state },
            }
          : undefined,
    );
  }

  async getInbound(eventId: string): Promise<InboundRecord | undefined> {
    const kept = await this.records.get<KeptClaim>(
      CLAIM,
      `${INGRESS_CLAIM}${eventId}`,
    );
    if (!kept?.requestHash || !kept.expiresAt) return undefined;
    return {
      eventId,
      expiresAt: kept.expiresAt,
      requestHash: kept.requestHash,
      ...(kept.result ? { result: kept.result } : {}),
      state: kept.state ?? "claimed",
    };
  }

  async purgeInbound(now: Date): Promise<number> {
    const where = [`expires_dt:[* TO ${now.toISOString()}]`];
    const expired = await this.records.count(CLAIM, {}, where);
    if (expired > 0) await this.records.removeWhere(CLAIM, {}, where);
    return expired;
  }

  // -- installations -------------------------------------------------------

  async getInstallation(
    key: SlackInstallationKey,
  ): Promise<SlackInstallation | undefined> {
    const kept = await this.records.get<KeptInstallation>(
      KINDS.installation,
      installationKey(key),
    );
    return kept ? this.#installation(kept) : undefined;
  }

  async getInstallationByHostUid(
    hostUid: string,
  ): Promise<SlackInstallation | undefined> {
    const [kept] = await this.records.find<KeptInstallation>(
      KINDS.installation,
      { host_uid_s: hostUid, status_s: "active" },
      { rows: 1 },
    );
    return kept ? this.#installation(kept) : undefined;
  }

  async listBoundInstallations(): Promise<SlackInstallation[]> {
    const kept = await this.records.find<KeptInstallation>(KINDS.installation, {
      host_bound_b: true,
      status_s: "active",
    });
    return kept.map((one) => this.#installation(one));
  }

  async putInstallation(value: SlackInstallation): Promise<void> {
    await this.records.update<KeptInstallation>(
      KINDS.installation,
      installationKey(value),
      (before) => {
        // The host fields are kept when left out: a reinstall without a bind
        // code never forgets the workspace's key.
        const record: KeptInstallation = {
          ...value,
          botRefreshToken: value.botRefreshToken
            ? this.cipher.encrypt(
                value.botRefreshToken,
                refreshTokenData(value),
              )
            : undefined,
          botToken: this.cipher.encrypt(value.botToken, installationKey(value)),
          datalayerHostKey: value.datalayerHostKey
            ? this.cipher.encrypt(value.datalayerHostKey, hostKeyData(value))
            : before?.datalayerHostKey,
          datalayerHostUid: value.datalayerHostUid ?? before?.datalayerHostUid,
          deliveryKey: value.deliverySecret
            ? value.deliveryKey
            : before?.deliveryKey,
          deliverySecret: value.deliverySecret
            ? this.cipher.encrypt(
                value.deliverySecret,
                deliverySecretData(value),
              )
            : before?.deliverySecret,
          deliveryVersion: value.deliverySecret
            ? value.deliveryVersion
            : before?.deliveryVersion,
        };
        return { fields: installationFields(record), record };
      },
    );
  }

  async rotateBotToken(
    key: SlackInstallationKey,
    rotated: RotatedBotToken,
  ): Promise<boolean> {
    // Only an active installation is changed: a workspace uninstalled while
    // its token was refreshed is never revived (S-106).
    let rotatedIt = false;
    await this.records.update<KeptInstallation>(
      KINDS.installation,
      installationKey(key),
      (before) => {
        if (before?.status !== "active") return undefined;
        rotatedIt = true;
        const record: KeptInstallation = {
          ...before,
          botRefreshToken: this.cipher.encrypt(
            rotated.botRefreshToken,
            refreshTokenData(key),
          ),
          botToken: this.cipher.encrypt(rotated.botToken, installationKey(key)),
          botTokenExpiresAt: rotated.botTokenExpiresAt,
          updatedAt: rotated.updatedAt,
        };
        return { fields: installationFields(record), record };
      },
    );
    return rotatedIt;
  }

  /** The installation and every record of it: what the foreign keys cascaded. */
  async deleteInstallation(key: SlackInstallationKey): Promise<void> {
    await this.records.locked(
      [lockKey(KINDS.installation, installationKey(key))],
      async () =>
        this.records.client.deleteWhere(
          term("installation_s", installationKey(key)),
        ),
    );
  }

  #installation(kept: KeptInstallation): SlackInstallation {
    const key = keyOf(kept);
    return {
      ...kept,
      botRefreshToken: kept.botRefreshToken
        ? this.cipher.decrypt(kept.botRefreshToken, refreshTokenData(key))
        : undefined,
      botToken: this.cipher.decrypt(kept.botToken, installationKey(key)),
      datalayerHostKey: kept.datalayerHostKey
        ? this.cipher.decrypt(kept.datalayerHostKey, hostKeyData(key))
        : undefined,
      deliverySecret: kept.deliverySecret
        ? this.cipher.decrypt(kept.deliverySecret, deliverySecretData(key))
        : undefined,
    };
  }

  // -- custom apps ---------------------------------------------------------

  async getCustomApp(appId: string): Promise<SlackCustomApp | undefined> {
    const kept = await this.records.get<KeptCustomApp>(KINDS.customApp, appId);
    return kept ? this.#customApp(kept) : undefined;
  }

  async putCustomApp(app: SlackCustomApp): Promise<void> {
    await this.records.update<KeptCustomApp>(
      KINDS.customApp,
      app.appId,
      (before) => {
        const record: KeptCustomApp = {
          ...app,
          createdAt: before?.createdAt ?? app.createdAt,
          signingSecret: this.cipher.encrypt(
            app.signingSecret,
            customAppData(app.appId),
          ),
        };
        return { fields: { created_at_dt: record.createdAt }, record };
      },
    );
  }

  async listCustomApps(): Promise<SlackCustomApp[]> {
    const kept = await this.records.find<KeptCustomApp>(
      KINDS.customApp,
      {},
      { sort: "created_at_dt asc, uid asc" },
    );
    return kept.map((one) => this.#customApp(one));
  }

  async deleteCustomApp(appId: string): Promise<void> {
    await this.records.remove(KINDS.customApp, appId);
  }

  #customApp(kept: KeptCustomApp): SlackCustomApp {
    return {
      ...kept,
      signingSecret: this.cipher.decrypt(
        kept.signingSecret,
        customAppData(kept.appId),
      ),
    };
  }

  // -- approval cards --------------------------------------------------------

  async getApprovalCards(
    key: SlackInstallationKey,
    approvalId: string,
  ): Promise<ApprovalCard[]> {
    return this.records.find<ApprovalCard>(KINDS.card, {
      approval_s: approvalCardKey(key, approvalId),
    });
  }

  async putApprovalCard(card: ApprovalCard): Promise<void> {
    // A card shown again keeps what it was; only its decider changes.
    await this.records.update<ApprovalCard>(
      KINDS.card,
      `${approvalCardKey(card, card.approvalId)}:${card.channelId}:${card.messageTs}`,
      (before) => ({
        fields: {
          ...of(card),
          approval_s: approvalCardKey(card, card.approvalId),
        },
        record: before
          ? { ...before, decidedBySlackUserId: card.decidedBySlackUserId }
          : card,
      }),
    );
  }

  // -- applications, allowances, channels, policies ------------------------

  async getDefaultApplication(
    key: SlackInstallationKey,
  ): Promise<string | undefined> {
    return (
      await this.records.get<{ applicationId: string }>(
        KINDS.defaultApplication,
        installationKey(key),
      )
    )?.applicationId;
  }

  async setDefaultApplication(
    key: SlackInstallationKey,
    applicationId: string,
  ): Promise<void> {
    await this.records.put(
      KINDS.defaultApplication,
      installationKey(key),
      { applicationId },
      of(key),
    );
  }

  async getAllowances(key: SlackInstallationKey): Promise<AppAllowance[]> {
    const kept =
      (await this.records.get<AppAllowance[]>(
        KINDS.allowances,
        installationKey(key),
      )) ?? [];
    return [...kept].sort(
      (a, b) =>
        Number(b.isDefault) - Number(a.isDefault) ||
        a.name.localeCompare(b.name) ||
        a.applicationId.localeCompare(b.applicationId),
    );
  }

  async putAllowances(
    key: SlackInstallationKey,
    allowances: readonly AppAllowance[],
  ): Promise<void> {
    // One record holds the set: replacing it is one write.
    await this.records.put(
      KINDS.allowances,
      installationKey(key),
      allowances.map((one) => ({ ...one, ...keyOf(key) })),
      of(key),
    );
  }

  async getChannelBinding(
    key: SlackInstallationKey,
    channelId: string,
  ): Promise<ChannelBinding | undefined> {
    const kept = await this.records.get<ChannelBinding[]>(
      KINDS.channels,
      installationKey(key),
    );
    return kept?.find((one) => one.channelId === channelId);
  }

  async putChannelBindings(
    key: SlackInstallationKey,
    bindings: readonly ChannelBinding[],
  ): Promise<void> {
    await this.records.put(
      KINDS.channels,
      installationKey(key),
      bindings.map((one) => ({ ...one, ...keyOf(key) })),
      of(key),
    );
  }

  async getEventPolicy(
    key: SlackInstallationKey,
    slackUserId: string,
  ): Promise<EventPolicy | undefined> {
    return (
      await this.records.get<{ events: EventPolicy }>(
        KINDS.eventPolicy,
        userLinkKey(key, slackUserId),
      )
    )?.events;
  }

  async putEventPolicy(
    key: SlackInstallationKey,
    slackUserId: string,
    events: EventPolicy,
  ): Promise<void> {
    await this.records.put(
      KINDS.eventPolicy,
      userLinkKey(key, slackUserId),
      { events },
      of(key),
    );
  }

  // -- people, threads, deliveries -------------------------------------------

  async getUserLink(
    key: SlackInstallationKey,
    slackUserId: string,
  ): Promise<SlackUserLink | undefined> {
    return this.records.get<SlackUserLink>(
      KINDS.link,
      userLinkKey(key, slackUserId),
    );
  }

  async putUserLink(link: SlackUserLink): Promise<void> {
    await this.records.put(
      KINDS.link,
      userLinkKey(link, link.slackUserId),
      link,
      { ...of(link), status_s: link.status },
    );
  }

  async getThread(key: ThreadKey): Promise<ThreadBinding | undefined> {
    return this.records.get<ThreadBinding>(KINDS.thread, threadKey(key));
  }

  async putThread(binding: ThreadBinding): Promise<void> {
    await this.records.put(KINDS.thread, threadKey(binding), binding, {
      ...of(binding),
      session_s: binding.sessionId,
    });
  }

  async deleteThread(key: ThreadKey): Promise<void> {
    await this.records.remove(KINDS.thread, threadKey(key));
  }

  async archiveThread(binding: ThreadBinding, reason: string): Promise<void> {
    await this.records.append(KINDS.archivedThread, binding, {
      ...of(binding),
      reason_s: reason,
      thread_s: threadKey(binding),
    });
  }

  async getArchivedThreads(key: ThreadKey): Promise<ThreadBinding[]> {
    return this.records.find<ThreadBinding>(KINDS.archivedThread, {
      thread_s: threadKey(key),
    });
  }

  async setNextApplication(
    key: ThreadKey,
    applicationId: string,
  ): Promise<void> {
    await this.records.put(
      KINDS.nextApplication,
      threadKey(key),
      { applicationId },
      of(key),
    );
  }

  async getNextApplication(key: ThreadKey): Promise<string | undefined> {
    return (
      await this.records.get<{ applicationId: string }>(
        KINDS.nextApplication,
        threadKey(key),
      )
    )?.applicationId;
  }

  async clearNextApplication(key: ThreadKey): Promise<void> {
    await this.records.remove(KINDS.nextApplication, threadKey(key));
  }

  async getDelivery(
    key: SlackInstallationKey,
    deliveryId: string,
  ): Promise<SlackDelivery | undefined> {
    return this.records.get<SlackDelivery>(
      KINDS.delivery,
      `${installationKey(key)}:${deliveryId}`,
    );
  }

  async putDelivery(delivery: SlackDelivery): Promise<void> {
    await this.records.put(
      KINDS.delivery,
      `${installationKey(delivery)}:${delivery.deliveryId}`,
      { ...delivery, lastError: delivery.lastError?.slice(0, 2_000) },
      { ...of(delivery), status_s: delivery.status },
    );
  }

  // -- held prompts --------------------------------------------------------

  async holdPrompt(prompt: IncomingPrompt): Promise<void> {
    await this.records.create<KeptHeld>(
      KINDS.held,
      `${installationKey(prompt)}:${prompt.eventId}`,
      { heldAt: new Date().toISOString(), prompt },
      of(prompt),
    );
  }

  async takeHeldPrompt(
    key: SlackInstallationKey,
    eventId: string,
    slackUserId: string,
  ): Promise<IncomingPrompt | undefined> {
    let taken: IncomingPrompt | undefined;
    await this.records.update<KeptHeld>(
      KINDS.held,
      `${installationKey(key)}:${eventId}`,
      (before) => {
        if (
          !before ||
          before.prompt.userId !== slackUserId ||
          Date.now() - new Date(before.heldAt).getTime() > HELD_FOR_MS
        )
          return undefined;
        taken = before.prompt;
        return null;
      },
    );
    return taken;
  }

  // -- turns -----------------------------------------------------------------

  async beginTurn(
    key: ThreadKey,
    eventId: string,
    now: Date,
    staleAfterMs: number,
  ): Promise<TurnClaim> {
    // The thread's lock, whether or not its turn exists yet: two workers
    // never both start a thread's first turn (S-207).
    let claim: TurnClaim | undefined;
    await this.records.update<ThreadTurn>(
      KINDS.turn,
      threadKey(key),
      async (current) => {
        const finished = await this.records.get(
          KINDS.finished,
          `${threadKey(key)}:${eventId}`,
        );
        if (finished)
          claim = {
            outcome: "done",
            turn:
              current?.eventId === eventId
                ? current
                : {
                    ...threadKeyOf(key),
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
        if (claim) return undefined;
        const turn: ThreadTurn = {
          ...threadKeyOf(key),
          eventId,
          startedAt: now.toISOString(),
          state: "running",
        };
        claim = { outcome: "started", turn };
        return { fields: { ...of(key), state_s: "running" }, record: turn };
      },
    );
    if (!claim) throw new Error("The turn was neither begun nor found.");
    return claim;
  }

  async updateTurn(
    key: ThreadKey,
    eventId: string,
    patch: Partial<
      Pick<ThreadTurn, "heartbeatAt" | "messageTs" | "runId" | "sessionId">
    >,
  ): Promise<void> {
    await this.#changeTurn(key, eventId, (turn) => ({
      ...turn,
      heartbeatAt: patch.heartbeatAt ?? turn.heartbeatAt,
      messageTs: patch.messageTs ?? turn.messageTs,
      runId: patch.runId ?? turn.runId,
      sessionId: patch.sessionId ?? turn.sessionId,
    }));
  }

  async markStopped(
    key: ThreadKey,
    eventId: string,
    slackUserId: string | undefined,
  ): Promise<void> {
    await this.#changeTurn(key, eventId, (turn) => ({
      ...turn,
      stoppedBy: slackUserId,
    }));
  }

  async endTurn(key: ThreadKey, eventId: string): Promise<void> {
    await this.records.locked(
      [lockKey(KINDS.turn, threadKey(key))],
      async () => {
        await this.records.create(
          KINDS.finished,
          `${threadKey(key)}:${eventId}`,
          { eventId },
          of(key),
        );
        await this.#changeTurn(key, eventId, (turn) => ({
          ...turn,
          state: "done",
        }));
      },
    );
  }

  async getTurn(key: ThreadKey): Promise<ThreadTurn | undefined> {
    return this.records.get<ThreadTurn>(KINDS.turn, threadKey(key));
  }

  async #changeTurn(
    key: ThreadKey,
    eventId: string,
    change: (turn: ThreadTurn) => ThreadTurn,
  ): Promise<void> {
    await this.records.update<ThreadTurn>(
      KINDS.turn,
      threadKey(key),
      (current) => {
        if (current?.eventId !== eventId) return undefined;
        const turn = change(current);
        return { fields: { ...of(key), state_s: turn.state }, record: turn };
      },
    );
  }

  // -- quotas ----------------------------------------------------------------

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

function threadKeyOf(key: ThreadKey): ThreadKey {
  return {
    appId: key.appId,
    channelId: key.channelId,
    enterpriseId: key.enterpriseId,
    teamId: key.teamId,
    threadTs: key.threadTs,
  };
}

function installationFields(kept: KeptInstallation) {
  return {
    ...of(kept),
    host_bound_b: kept.datalayerHostKey !== undefined,
    host_uid_s: kept.datalayerHostUid,
    status_s: kept.status,
  };
}
