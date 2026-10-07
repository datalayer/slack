import type { SlackInstallationKey, ThreadKey } from "./domain.js";

export type SlackMessage = Readonly<{
  blocks?: readonly unknown[];
  text: string;
}>;

export interface SlackPort {
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
