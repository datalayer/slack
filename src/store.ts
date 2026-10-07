import {
  installationKey,
  threadKey,
  userLinkKey,
  type SlackInstallation,
  type SlackInstallationKey,
  type SlackUserLink,
  type ThreadBinding,
  type ThreadKey,
} from "./domain.js";

export interface SlackStore {
  claimEvent(eventId: string): Promise<boolean>;
  deleteInstallation(key: SlackInstallationKey): Promise<void>;
  getDefaultApplication(key: SlackInstallationKey): Promise<string | undefined>;
  getInstallation(
    key: SlackInstallationKey,
  ): Promise<SlackInstallation | undefined>;
  getThread(key: ThreadKey): Promise<ThreadBinding | undefined>;
  getUserLink(
    key: SlackInstallationKey,
    slackUserId: string,
  ): Promise<SlackUserLink | undefined>;
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
  readonly #events = new Set<string>();
  readonly #installations = new Map<string, SlackInstallation>();
  readonly #links = new Map<string, SlackUserLink>();
  readonly #threads = new Map<string, ThreadBinding>();

  async claimEvent(eventId: string): Promise<boolean> {
    if (this.#events.has(eventId)) return false;
    this.#events.add(eventId);
    return true;
  }

  async deleteInstallation(key: SlackInstallationKey): Promise<void> {
    const prefix = `${installationKey(key)}:`;
    this.#installations.delete(installationKey(key));
    this.#applications.delete(installationKey(key));
    for (const link of this.#links.keys())
      if (link.startsWith(prefix)) this.#links.delete(link);
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

  async getThread(key: ThreadKey): Promise<ThreadBinding | undefined> {
    return this.#threads.get(threadKey(key));
  }

  async getUserLink(
    key: SlackInstallationKey,
    slackUserId: string,
  ): Promise<SlackUserLink | undefined> {
    return this.#links.get(userLinkKey(key, slackUserId));
  }

  async putInstallation(installation: SlackInstallation): Promise<void> {
    this.#installations.set(installationKey(installation), installation);
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
