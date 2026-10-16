import type { KnownBlock } from "@slack/types";

import type { SlackInstallationKey, ThreadKey } from "./domain.js";

export type SlackMessage = Readonly<{
  blocks?: readonly KnownBlock[] | readonly unknown[];
  text: string;
}>;

/**
 * Slack's text streaming (`chat.startStream`, `appendStream`, `stopStream`):
 * offered where the workspace and the app support it; otherwise a
 * placeholder is updated at a bounded cadence.
 */
export interface SlackStreaming {
  start(
    key: ThreadKey,
    recipientUserId: string,
    markdown: string,
  ): Promise<string>;
  append(key: ThreadKey, ts: string, markdown: string): Promise<void>;
  stop(key: ThreadKey, ts: string, message: SlackMessage): Promise<void>;
}

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
  /**
   * Said to one person only: an ephemeral message in a channel thread, a
   * direct message otherwise (plans/SLACK.md §8: setup UI is private).
   */
  postPrivate(
    key: SlackInstallationKey | ThreadKey,
    userId: string,
    message: SlackMessage,
  ): Promise<void>;
  postThread(key: ThreadKey, message: SlackMessage): Promise<string>;
  updateMessage(
    key: ThreadKey,
    messageTs: string,
    message: SlackMessage,
  ): Promise<void>;
  /** Present when Slack streaming is available to this installation. */
  readonly streaming?: SlackStreaming;
}

/** Whether a key names a conversation (a channel and thread), not only the workspace. */
export function isThreadKey(
  key: SlackInstallationKey | ThreadKey,
): key is ThreadKey {
  return "channelId" in key && "threadTs" in key;
}

/** A direct message's channel id starts with D. */
export const isDirectChannel = (channelId: string): boolean =>
  channelId.startsWith("D");
