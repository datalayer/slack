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
  /** Start the stream empty: whatever it starts with stays in the answer. */
  start(key: ThreadKey, recipientUserId: string): Promise<string>;
  append(key: ThreadKey, ts: string, markdown: string): Promise<void>;
  stop(key: ThreadKey, ts: string, message: SlackMessage): Promise<void>;
}

/**
 * Who a Slack member is, as `users.info` says (`users:read`, S-209): a guest
 * (single- or multi-channel) or a person of another organization (Slack
 * Connect) is refused by default (decided by the user 16 October 2026).
 */
export type SlackMember = Readonly<{
  /** A single- or multi-channel guest (`is_restricted`, `is_ultra_restricted`). */
  guest: boolean;
  /**
   * A person of another organization (`is_stranger`, or another home team
   * outside the installation's Enterprise Grid organization).
   */
  external: boolean;
  /** Deactivated in Slack (`deleted`): unlinked and answered nothing (S-103). */
  deactivated: boolean;
}>;

/** The fields of Slack's `users.info` user that @Datalayer reads. */
export type SlackUserInfo = Readonly<{
  deleted?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  is_stranger?: boolean;
  team_id?: string;
  enterprise_user?: Readonly<{ enterprise_id?: string }>;
}>;

/** One of the DM's suggested prompts (`assistant.threads.setSuggestedPrompts`, S-104). */
export type SuggestedPrompt = Readonly<{ title: string; message: string }>;

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
   * direct message otherwise (setup UI is private).
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
  /** Who a member is (`users.info`, `users:read`): guests and external people are refused (S-209). */
  memberOf(key: SlackInstallationKey, userId: string): Promise<SlackMember>;
  /**
   * The suggested prompts of @Datalayer's direct-message thread
   * (`assistant.threads.setSuggestedPrompts`, `assistant:write`, S-104).
   */
  suggestPrompts(
    key: ThreadKey,
    title: string,
    prompts: readonly SuggestedPrompt[],
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

/**
 * What `users.info` says of a member, read as @Datalayer decides it:
 * Slack's flags, and a home team other than the installation's. In an
 * Enterprise Grid organization a member of another of its workspaces has
 * another `team_id` but the installation's enterprise id: not external.
 */
export function slackMemberOf(
  user: SlackUserInfo,
  key: Pick<SlackInstallationKey, "enterpriseId" | "teamId">,
): SlackMember {
  const homeElsewhere =
    typeof user.team_id === "string" && user.team_id !== key.teamId;
  const sameEnterprise =
    key.enterpriseId !== undefined &&
    user.enterprise_user?.enterprise_id === key.enterpriseId;
  return {
    deactivated: user.deleted === true,
    external: user.is_stranger === true || (homeElsewhere && !sameEnterprise),
    guest: user.is_restricted === true || user.is_ultra_restricted === true,
  };
}
