import {
  externalIdOf,
  type SlackInstallation,
  type SlackInstallationKey,
} from "./domain.js";
import type { BoundHost, DatalayerHostClient } from "./host-client.js";
import { LINK_PAGE_PATH } from "./host-contracts.js";
import type { SlackStore } from "./store.js";

/** Whether a Slack user is linked, and how one connects. */
export interface AccountLinks {
  /** The Datalayer principal a Slack user is linked to, when linked. */
  linkOf(
    key: SlackInstallationKey,
    slackUserId: string,
  ): Promise<{ principalId: string } | undefined>;
  /**
   * The landing's confirm page with a fresh one-use link code (ten
   * minutes); `undefined` when the workspace was never bound to Datalayer.
   */
  connectUrlOf(
    key: SlackInstallationKey,
    slackUserId: string,
  ): Promise<string | undefined>;
}

/** The links the store keeps: the development seed, and tests. */
export class StoreLinks implements AccountLinks {
  constructor(readonly store: SlackStore) {}

  async linkOf(
    key: SlackInstallationKey,
    slackUserId: string,
  ): Promise<{ principalId: string } | undefined> {
    const link = await this.store.getUserLink(key, slackUserId);
    return link?.status === "active"
      ? { principalId: link.datalayerPrincipalId }
      : undefined;
  }

  async connectUrlOf(): Promise<string | undefined> {
    return undefined;
  }
}

export type HostInstallationsOptions = Readonly<{
  /** Where Datalayer pushes this installation's deliveries; none: the outbox only. */
  deliveryUrlOf?: (hostUid: string) => string | undefined;
  /** Development only: one host key for every workspace without its own. */
  developmentHostKey?: string;
  logger?: Pick<Console, "warn">;
  webUrl: string;
}>;

/**
 * Each workspace as a Datalayer host installation (plans/SLACK.md §3.1,
 * §4.3): bound at install with the code the Ship card passed, its key kept
 * encrypted beside the Slack installation and used for every call of that
 * workspace; its people linked at Datalayer; ended at Datalayer when Slack
 * uninstalls it.
 */
export class HostInstallations implements AccountLinks {
  constructor(
    readonly store: SlackStore,
    readonly client: DatalayerHostClient,
    readonly options: HostInstallationsOptions,
  ) {}

  /** Bind the workspace with the Ship card's code: its key, answered once. */
  async bind(
    key: SlackInstallationKey,
    code: string,
    name?: string,
  ): Promise<BoundHost> {
    return this.client.bind({ code, externalId: externalIdOf(key), name });
  }

  /**
   * Keep a Slack installation, with the host it was just bound to when it
   * was: its key beside the bot token, the installation's default deployment
   * as the workspace's default, and the delivery address registered.
   * A reinstall without a code keeps the key the workspace already had.
   */
  async keep(
    installation: SlackInstallation,
    bound?: BoundHost,
  ): Promise<void> {
    await this.store.putInstallation(
      bound
        ? {
            ...installation,
            datalayerHostKey: bound.hostKey,
            datalayerHostUid: bound.hostUid,
          }
        : installation,
    );
    if (!bound) return;
    if (bound.defaultDeployment)
      await this.store.setDefaultApplication(
        installation,
        bound.defaultDeployment,
      );
    await this.registerDelivery(installation, bound);
  }

  /**
   * Register where Datalayer pushes this installation's deliveries, and keep
   * the secret they are signed with. Without a public address, or when it is
   * refused, the outbox poller reads them instead.
   */
  async registerDelivery(
    key: SlackInstallationKey,
    bound: Pick<BoundHost, "hostKey" | "hostUid">,
  ): Promise<boolean> {
    const url = this.options.deliveryUrlOf?.(bound.hostUid);
    if (!url) return false;
    try {
      const { signingSecret } = await this.client.setWebhook(
        bound.hostKey,
        url,
      );
      const installation = await this.store.getInstallation(key);
      if (!installation) return false;
      await this.store.putInstallation({
        ...installation,
        deliverySecret: signingSecret,
      });
      return true;
    } catch (error) {
      this.options.logger?.warn(
        `The delivery address was not registered; the outbox is read instead: ${(error as Error).message}`,
      );
      return false;
    }
  }

  /** The workspace's host key: its own, else (development) the configured one. */
  async hostKeyOf(key: SlackInstallationKey): Promise<string | undefined> {
    const installation = await this.store.getInstallation(key);
    if (!installation || installation.status !== "active") return undefined;
    return installation.datalayerHostKey ?? this.options.developmentHostKey;
  }

  async linkOf(
    key: SlackInstallationKey,
    slackUserId: string,
  ): Promise<{ principalId: string } | undefined> {
    const hostKey = await this.hostKeyOf(key);
    if (!hostKey) return new StoreLinks(this.store).linkOf(key, slackUserId);
    // Datalayer is the record of who is linked: the person confirmed it there.
    const state = await this.client.linkState(hostKey, slackUserId);
    return state.linked && state.principalUid
      ? { principalId: state.principalUid }
      : undefined;
  }

  async connectUrlOf(
    key: SlackInstallationKey,
    slackUserId: string,
  ): Promise<string | undefined> {
    const hostKey = await this.hostKeyOf(key);
    if (!hostKey) return undefined;
    const { code } = await this.client.linkCode(hostKey, slackUserId);
    return `${this.options.webUrl.replace(/\/+$/, "")}${LINK_PAGE_PATH}?code=${encodeURIComponent(code)}`;
  }

  /**
   * Slack uninstalled the app, or revoked its bot token: the installation
   * ends at Datalayer (`DELETE /apps/hosts/self`: its links, bindings and
   * outbox with it), then its key, bindings and cards are purged here. The
   * purge happens even when Datalayer cannot be reached: the key is gone, so
   * nothing here can use it again.
   */
  async uninstall(key: SlackInstallationKey): Promise<void> {
    const installation = await this.store.getInstallation(key);
    try {
      if (installation?.datalayerHostKey)
        await this.client.uninstalled(installation.datalayerHostKey);
    } catch (error) {
      this.options.logger?.warn(
        `Datalayer was not told of the uninstall: ${(error as Error).message}`,
      );
    } finally {
      await this.store.deleteInstallation(key);
    }
  }
}
