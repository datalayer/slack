import {
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
}

/** Development and test store. Production configuration rejects it. */
export class MemorySlackStore implements SlackStore {
  readonly #applications = new Map<string, string>();
  readonly #cards = new Map<string, ApprovalCard[]>();
  readonly #events = new Set<string>();
  readonly #installations = new Map<string, SlackInstallation>();
  readonly #links = new Map<string, SlackUserLink>();
  readonly #threads = new Map<string, ThreadBinding>();

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
    for (const map of [this.#links, this.#threads, this.#cards])
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
}
