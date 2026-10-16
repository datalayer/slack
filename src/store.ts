import type { QuotaEntry } from "./quotas.js";
import {
  type AppAllowance,
  type IncomingPrompt,
  type ChannelBinding,
  type SlackDelivery,
  type ThreadTurn,
  type TurnClaim,
  approvalCardKey,
  installationKey,
  threadKey,
  userLinkKey,
  type ApprovalCard,
  type SlackInstallation,
  type SlackInstallationKey,
  type SlackUserLink,
  type ThreadBinding,
  type ThreadKey,
} from "./domain.js";

export interface SlackStore {
  /** Claim an event, action or delivery once: `false` when already claimed. */
  claimEvent(eventId: string): Promise<boolean>;
  /** Give a claim back when its work failed, so a retry can claim it again. */
  releaseEvent(eventId: string): Promise<void>;
  deleteInstallation(key: SlackInstallationKey): Promise<void>;
  getApprovalCards(
    key: SlackInstallationKey,
    approvalId: string,
  ): Promise<ApprovalCard[]>;
  getDefaultApplication(key: SlackInstallationKey): Promise<string | undefined>;
  getInstallation(
    key: SlackInstallationKey,
  ): Promise<SlackInstallation | undefined>;
  /** The active installation bound to a Datalayer host installation. */
  getInstallationByHostUid(
    hostUid: string,
  ): Promise<SlackInstallation | undefined>;
  getThread(key: ThreadKey): Promise<ThreadBinding | undefined>;
  getUserLink(
    key: SlackInstallationKey,
    slackUserId: string,
  ): Promise<SlackUserLink | undefined>;
  /** Every active installation that holds a host key: what the outbox poller reads. */
  listBoundInstallations(): Promise<SlackInstallation[]>;
  putApprovalCard(card: ApprovalCard): Promise<void>;
  /**
   * Keep an installation. Its Datalayer host fields are kept as they were
   * when the value leaves them out: a Slack reinstall without a bind code
   * never forgets the workspace's host key.
   */
  putInstallation(installation: SlackInstallation): Promise<void>;
  putThread(binding: ThreadBinding): Promise<void>;
  putUserLink(link: SlackUserLink): Promise<void>;
  setDefaultApplication(
    key: SlackInstallationKey,
    applicationId: string,
  ): Promise<void>;

  /** The applications the installation allows, as last read from Datalayer. */
  getAllowances(key: SlackInstallationKey): Promise<AppAllowance[]>;
  /** Replace them all: what Datalayer answered now (an application no longer allowed is gone). */
  putAllowances(
    key: SlackInstallationKey,
    allowances: readonly AppAllowance[],
  ): Promise<void>;
  getChannelBinding(
    key: SlackInstallationKey,
    channelId: string,
  ): Promise<ChannelBinding | undefined>;
  putChannelBinding(binding: ChannelBinding): Promise<void>;
  getDelivery(
    key: SlackInstallationKey,
    deliveryId: string,
  ): Promise<SlackDelivery | undefined>;
  putDelivery(delivery: SlackDelivery): Promise<void>;
  /** A binding the thread had before an explicit switch or start over: kept, never reused. */
  archiveThread(binding: ThreadBinding, reason: string): Promise<void>;
  getArchivedThreads(key: ThreadKey): Promise<ThreadBinding[]>;
  /**
   * Begin the thread's turn for one Slack event, atomically: `busy` while
   * another event's turn runs (and is younger than `staleAfterMs`),
   * `resumed` for the same event again (a redelivery after a crash).
   */
  beginTurn(
    key: ThreadKey,
    eventId: string,
    now: Date,
    staleAfterMs: number,
  ): Promise<TurnClaim>;
  updateTurn(
    key: ThreadKey,
    eventId: string,
    patch: Partial<Pick<ThreadTurn, "messageTs" | "runId" | "sessionId">>,
  ): Promise<void>;
  endTurn(key: ThreadKey, eventId: string): Promise<void>;
  getTurn(key: ThreadKey): Promise<ThreadTurn | undefined>;
  /** Forget a thread's binding: after it was archived (start over, another application). */
  deleteThread(key: ThreadKey): Promise<void>;
  /** The application the thread's next session opens with, chosen explicitly (S-208). */
  setNextApplication(key: ThreadKey, applicationId: string): Promise<void>;
  getNextApplication(key: ThreadKey): Promise<string | undefined>;
  clearNextApplication(key: ThreadKey): Promise<void>;
  /**
   * Take one of each quota for a window, all or none (S-404): refused when
   * any is spent, naming the first spent.
   */
  takeQuota(
    entries: readonly QuotaEntry[],
    window: string,
  ): Promise<{ ok: true } | { ok: false; entry: QuotaEntry }>;
  /** How much of a quota is used in a window. */
  quotaUsed(key: string, window: string): Promise<number>;
  /** Keep a prompt that waits for its person to choose an application. */
  holdPrompt(prompt: IncomingPrompt): Promise<void>;
  /** Take it back, once, for the same person only. */
  takeHeldPrompt(
    key: SlackInstallationKey,
    eventId: string,
    slackUserId: string,
  ): Promise<IncomingPrompt | undefined>;
}

/** Whether a running turn has gone quiet long enough to be taken over. */
export function turnIsStale(
  turn: ThreadTurn,
  now: Date,
  staleAfterMs: number,
): boolean {
  return now.getTime() - new Date(turn.startedAt).getTime() > staleAfterMs;
}

/** Development and test store. Production configuration rejects it. */
export class MemorySlackStore implements SlackStore {
  readonly #applications = new Map<string, string>();
  readonly #cards = new Map<string, ApprovalCard[]>();
  readonly #events = new Set<string>();
  readonly #installations = new Map<string, SlackInstallation>();
  readonly #links = new Map<string, SlackUserLink>();
  readonly #threads = new Map<string, ThreadBinding>();
  readonly #allowances = new Map<string, AppAllowance[]>();
  readonly #channels = new Map<string, ChannelBinding>();
  readonly #deliveries = new Map<string, SlackDelivery>();
  readonly #archived = new Map<string, ThreadBinding[]>();
  readonly #turns = new Map<string, ThreadTurn>();
  readonly #finished = new Set<string>();
  readonly #held = new Map<string, IncomingPrompt>();
  readonly #next = new Map<string, string>();
  readonly #usage = new Map<string, number>();

  async claimEvent(eventId: string): Promise<boolean> {
    if (this.#events.has(eventId)) return false;
    this.#events.add(eventId);
    return true;
  }

  async releaseEvent(eventId: string): Promise<void> {
    this.#events.delete(eventId);
  }

  async deleteInstallation(key: SlackInstallationKey): Promise<void> {
    const prefix = `${installationKey(key)}:`;
    this.#installations.delete(installationKey(key));
    this.#applications.delete(installationKey(key));
    this.#allowances.delete(installationKey(key));
    for (const map of [
      this.#links,
      this.#threads,
      this.#cards,
      this.#channels,
      this.#deliveries,
      this.#archived,
      this.#turns,
      this.#held,
      this.#next,
    ])
      for (const entry of map.keys())
        if (entry.startsWith(prefix)) map.delete(entry);
  }

  async getApprovalCards(
    key: SlackInstallationKey,
    approvalId: string,
  ): Promise<ApprovalCard[]> {
    return [...(this.#cards.get(approvalCardKey(key, approvalId)) ?? [])];
  }

  async getDefaultApplication(
    key: SlackInstallationKey,
  ): Promise<string | undefined> {
    return this.#applications.get(installationKey(key));
  }

  async getInstallation(
    key: SlackInstallationKey,
  ): Promise<SlackInstallation | undefined> {
    return this.#installations.get(installationKey(key));
  }

  async getInstallationByHostUid(
    hostUid: string,
  ): Promise<SlackInstallation | undefined> {
    return [...this.#installations.values()].find(
      (installation) =>
        installation.datalayerHostUid === hostUid &&
        installation.status === "active",
    );
  }

  async getThread(key: ThreadKey): Promise<ThreadBinding | undefined> {
    return this.#threads.get(threadKey(key));
  }

  async getUserLink(
    key: SlackInstallationKey,
    slackUserId: string,
  ): Promise<SlackUserLink | undefined> {
    return this.#links.get(userLinkKey(key, slackUserId));
  }

  async listBoundInstallations(): Promise<SlackInstallation[]> {
    return [...this.#installations.values()].filter(
      (installation) =>
        installation.status === "active" && installation.datalayerHostKey,
    );
  }

  async putApprovalCard(card: ApprovalCard): Promise<void> {
    const key = approvalCardKey(card, card.approvalId);
    const cards = (this.#cards.get(key) ?? []).filter(
      (one) =>
        one.channelId !== card.channelId || one.messageTs !== card.messageTs,
    );
    this.#cards.set(key, [...cards, card]);
  }

  async putInstallation(installation: SlackInstallation): Promise<void> {
    const before = this.#installations.get(installationKey(installation));
    this.#installations.set(installationKey(installation), {
      ...installation,
      datalayerHostUid:
        installation.datalayerHostUid ?? before?.datalayerHostUid,
      datalayerHostKey:
        installation.datalayerHostKey ?? before?.datalayerHostKey,
      deliverySecret: installation.deliverySecret ?? before?.deliverySecret,
    });
  }

  async putThread(binding: ThreadBinding): Promise<void> {
    this.#threads.set(threadKey(binding), binding);
  }

  async putUserLink(link: SlackUserLink): Promise<void> {
    this.#links.set(userLinkKey(link, link.slackUserId), link);
  }

  async setDefaultApplication(
    key: SlackInstallationKey,
    applicationId: string,
  ): Promise<void> {
    this.#applications.set(installationKey(key), applicationId);
  }

  async getAllowances(key: SlackInstallationKey): Promise<AppAllowance[]> {
    return [...(this.#allowances.get(installationKey(key)) ?? [])];
  }

  async putAllowances(
    key: SlackInstallationKey,
    allowances: readonly AppAllowance[],
  ): Promise<void> {
    this.#allowances.set(installationKey(key), [...allowances]);
  }

  async getChannelBinding(
    key: SlackInstallationKey,
    channelId: string,
  ): Promise<ChannelBinding | undefined> {
    return this.#channels.get(`${installationKey(key)}:${channelId}`);
  }

  async putChannelBinding(binding: ChannelBinding): Promise<void> {
    this.#channels.set(
      `${installationKey(binding)}:${binding.channelId}`,
      binding,
    );
  }

  async getDelivery(
    key: SlackInstallationKey,
    deliveryId: string,
  ): Promise<SlackDelivery | undefined> {
    return this.#deliveries.get(`${installationKey(key)}:${deliveryId}`);
  }

  async putDelivery(delivery: SlackDelivery): Promise<void> {
    this.#deliveries.set(
      `${installationKey(delivery)}:${delivery.deliveryId}`,
      delivery,
    );
  }

  async archiveThread(binding: ThreadBinding): Promise<void> {
    const key = threadKey(binding);
    this.#archived.set(key, [...(this.#archived.get(key) ?? []), binding]);
  }

  async getArchivedThreads(key: ThreadKey): Promise<ThreadBinding[]> {
    return [...(this.#archived.get(threadKey(key)) ?? [])];
  }

  async beginTurn(
    key: ThreadKey,
    eventId: string,
    now: Date,
    staleAfterMs: number,
  ): Promise<TurnClaim> {
    const current = this.#turns.get(threadKey(key));
    if (this.#finished.has(`${threadKey(key)}:${eventId}`))
      return {
        outcome: "done",
        turn:
          current?.eventId === eventId
            ? current
            : { ...key, eventId, startedAt: now.toISOString(), state: "done" },
      };
    if (current?.eventId === eventId)
      return current.state === "running"
        ? { outcome: "resumed", turn: current }
        : { outcome: "done", turn: current };
    if (
      current?.state === "running" &&
      !turnIsStale(current, now, staleAfterMs)
    )
      return { outcome: "busy", turn: current };
    const turn: ThreadTurn = {
      appId: key.appId,
      channelId: key.channelId,
      enterpriseId: key.enterpriseId,
      eventId,
      startedAt: now.toISOString(),
      state: "running",
      teamId: key.teamId,
      threadTs: key.threadTs,
    };
    this.#turns.set(threadKey(key), turn);
    return { outcome: "started", turn };
  }

  async updateTurn(
    key: ThreadKey,
    eventId: string,
    patch: Partial<Pick<ThreadTurn, "messageTs" | "runId" | "sessionId">>,
  ): Promise<void> {
    const current = this.#turns.get(threadKey(key));
    if (current?.eventId === eventId)
      this.#turns.set(threadKey(key), { ...current, ...patch });
  }

  async endTurn(key: ThreadKey, eventId: string): Promise<void> {
    this.#finished.add(`${threadKey(key)}:${eventId}`);
    const current = this.#turns.get(threadKey(key));
    if (current?.eventId === eventId)
      this.#turns.set(threadKey(key), { ...current, state: "done" });
  }

  async getTurn(key: ThreadKey): Promise<ThreadTurn | undefined> {
    return this.#turns.get(threadKey(key));
  }

  async holdPrompt(prompt: IncomingPrompt): Promise<void> {
    this.#held.set(`${installationKey(prompt)}:${prompt.eventId}`, prompt);
  }

  async takeHeldPrompt(
    key: SlackInstallationKey,
    eventId: string,
    slackUserId: string,
  ): Promise<IncomingPrompt | undefined> {
    const id = `${installationKey(key)}:${eventId}`;
    const held = this.#held.get(id);
    if (!held || held.userId !== slackUserId) return undefined;
    this.#held.delete(id);
    return held;
  }

  async deleteThread(key: ThreadKey): Promise<void> {
    this.#threads.delete(threadKey(key));
  }

  async setNextApplication(
    key: ThreadKey,
    applicationId: string,
  ): Promise<void> {
    this.#next.set(threadKey(key), applicationId);
  }

  async getNextApplication(key: ThreadKey): Promise<string | undefined> {
    return this.#next.get(threadKey(key));
  }

  async clearNextApplication(key: ThreadKey): Promise<void> {
    this.#next.delete(threadKey(key));
  }

  async takeQuota(
    entries: readonly QuotaEntry[],
    window: string,
  ): Promise<{ ok: true } | { ok: false; entry: QuotaEntry }> {
    const spent = entries.find(
      (entry) =>
        (this.#usage.get(`${window}:${entry.key}`) ?? 0) >= entry.limit,
    );
    if (spent) return { entry: spent, ok: false };
    for (const entry of entries)
      this.#usage.set(
        `${window}:${entry.key}`,
        (this.#usage.get(`${window}:${entry.key}`) ?? 0) + 1,
      );
    return { ok: true };
  }

  async quotaUsed(key: string, window: string): Promise<number> {
    return this.#usage.get(`${window}:${key}`) ?? 0;
  }
}
