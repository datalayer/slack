import type { SlackInstallationKey, ThreadKey } from "./domain.js";

export type SlackMessage = Readonly<{
  blocks?: readonly unknown[];
  text: string;
}>;

export interface SlackPort {
  /**
   * A direct message from @Datalayer to one person (its Messages tab): where
   * it was posted, so it can be updated.
   */
  postDirect(
    key: SlackInstallationKey,
    userId: string,
    message: SlackMessage,
  ): Promise<{ channelId: string; ts: string }>;
  postPrivate(
    key: SlackInstallationKey,
    userId: string,
    message: SlackMessage,
  ): Promise<void>;
  postThread(key: ThreadKey, message: SlackMessage): Promise<string>;
  updateMessage(
    key: ThreadKey,
    messageTs: string,
    message: SlackMessage,
  ): Promise<void>;
}
