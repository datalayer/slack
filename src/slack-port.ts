import type { ThreadKey } from "./domain.js";

export type SlackMessage = Readonly<{
  blocks?: readonly unknown[];
  text: string;
}>;

export interface SlackPort {
  postPrivate(userId: string, message: SlackMessage): Promise<void>;
  postThread(key: ThreadKey, message: SlackMessage): Promise<string>;
  updateMessage(
    channelId: string,
    messageTs: string,
    message: SlackMessage,
  ): Promise<void>;
}
