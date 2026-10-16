import type { SemanticEvent } from "./semantic.js";

export type SlackInstallationKey = Readonly<{
  appId: string;
  enterpriseId?: string;
  teamId: string;
}>;

export type SlackInstallation = SlackInstallationKey &
  Readonly<{
    botToken: string;
    botUserId: string;
    /** The Datalayer host installation this workspace was bound to at install. */
    datalayerHostUid?: string;
    /**
     * Its host key (`dlhk_…`), answered once by `POST /apps/hosts/bind`: the
     * installation proof of every host call. Encrypted at rest beside the bot
     * token; never logged.
     */
    datalayerHostKey?: string;
    /** What Datalayer signs this installation's pushed deliveries with. */
    deliverySecret?: string;
    datalayerOrganizationId?: string;
    installedBy: string;
    scopes: readonly string[];
    status: "active" | "disconnected";
    updatedAt: string;
  }>;

export type SlackUserLink = Readonly<{
  datalayerPrincipalId: string;
  linkedAt: string;
  slackUserId: string;
  status: "active" | "revoked";
}> &
  SlackInstallationKey;

export type ThreadKey = SlackInstallationKey &
  Readonly<{
    channelId: string;
    threadTs: string;
  }>;

export type ThreadBinding = ThreadKey &
  Readonly<{
    applicationId: string;
    openedByPrincipalId: string;
    /**
     * The thread's status message while its turn is not finished: what a
     * `turn.completed` delivery updates with the answer.
     */
    pendingMessageTs?: string;
    sessionId: string;
    /** The Slack event of the last turn sent to the session: the Slack cursor. */
    lastEventId?: string;
    /** The Datalayer run of the last turn, as its `loop.turn` named it: the Datalayer cursor. */
    lastRunId?: string;
    /** Where the thread is: a channel's shared thread or a direct message. */
    visibility?: "channel" | "direct";
    updatedAt: string;
  }>;

/**
 * An application the installation allows (plans/SLACK.md §5,
 * `slack_app_allowance`): Datalayer's allowlist (`GET /apps/hosts/self`),
 * kept here to show and choose from — never what authorizes a turn; the
 * exchange decides that at every turn.
 */
export type AppAllowance = SlackInstallationKey &
  Readonly<{
    applicationId: string;
    name: string;
    enabled: boolean;
    isDefault: boolean;
    /** Whether the application answers in channels, or in direct messages only. */
    channelPolicy: "channels" | "direct-only";
    configuredBy: string;
    updatedAt: string;
  }>;

/** A channel's own rule (`slack_channel_binding`): denied, or its default application. */
export type ChannelBinding = SlackInstallationKey &
  Readonly<{
    channelId: string;
    applicationId?: string;
    state: "allow" | "deny";
    updatedBy: string;
    updatedAt: string;
  }>;

/** One delivery to Slack (`slack_delivery`): where, which payload version, how it went. */
export type SlackDelivery = SlackInstallationKey &
  Readonly<{
    deliveryId: string;
    target: Readonly<Record<string, unknown>>;
    payloadVersion: number;
    status: "pending" | "sent" | "failed" | "dropped";
    attempts: number;
    lastError?: string;
    slackTs?: string;
    updatedAt: string;
  }>;

/** The turn a thread runs now: one at a time per thread (S-207). */
export type ThreadTurn = ThreadKey &
  Readonly<{
    eventId: string;
    state: "running" | "done";
    startedAt: string;
    /** The run the stream named: what Stop stops. */
    runId?: string;
    /** The message the answer is in: what a recovered turn resumes. */
    messageTs?: string;
    sessionId?: string;
  }>;

/**
 * What beginning a turn came to: started; the same event resumed after a
 * crash; refused while another event's turn runs; or the same event already
 * answered (a duplicate).
 */
export type TurnClaim =
  | Readonly<{ outcome: "started"; turn: ThreadTurn }>
  | Readonly<{ outcome: "resumed"; turn: ThreadTurn }>
  | Readonly<{ outcome: "busy"; turn: ThreadTurn }>
  | Readonly<{ outcome: "done"; turn: ThreadTurn }>;

/**
 * Where an approval was shown in Slack: the card itself (in a direct message
 * or the session's DM thread) and, for a channel session, the waiting line
 * left in the shared thread. Each is updated when the approval is decided.
 */
export type ApprovalCard = SlackInstallationKey &
  Readonly<{
    approvalId: string;
    channelId: string;
    /** Who decided it from Slack, once decided there. */
    decidedBySlackUserId?: string;
    deploymentUid: string;
    kind: "card" | "waiting";
    messageTs: string;
    /** The Slack user it waits on. */
    slackUserId: string;
    threadTs?: string;
    toolName: string;
  }>;

export type IncomingPrompt = ThreadKey &
  Readonly<{
    eventId: string;
    text: string;
    userId: string;
    /** The application chosen explicitly (the selector, *Use another application*). */
    applicationId?: string;
    /** A Slack Connect or shared channel: v1 fails closed. */
    isExtShared?: boolean;
    /** The speaker's own workspace, when Slack says it (`user_team`). */
    userTeamId?: string;
  }>;

export type TurnRequest = Readonly<{
  /** The deployment the turn runs: one the installation allows. */
  applicationId: string;
  externalEventId: string;
  /** The Slack user the host speaks for: what the credential exchange names. */
  externalUserId: string;
  principalId: string;
  prompt: string;
  provenance: ThreadKey;
  sessionId?: string;
  /**
   * How many sessions the thread had before (an explicit start over or
   * another application): a new session's uid is derived with it.
   */
  sessionGeneration?: number;
}>;

export type TurnStream = Readonly<{
  /**
   * The run the stream is of, as its `loop.turn` event names it: known once
   * the stream has said it (what the Stop button names).
   */
  run: { id?: string };
  sessionId: string;
  updates: AsyncIterable<SemanticEvent>;
}>;

export function installationKey(value: SlackInstallationKey): string {
  return `${value.appId}:${value.enterpriseId ?? "-"}:${value.teamId}`;
}

export function userLinkKey(
  value: SlackInstallationKey,
  slackUserId: string,
): string {
  return `${installationKey(value)}:${slackUserId}`;
}

export function approvalCardKey(
  value: SlackInstallationKey,
  approvalId: string,
): string {
  return `${installationKey(value)}:${approvalId}`;
}

/** What the installation calls itself at ai-agents: `app:enterprise|-:team`. */
export function externalIdOf(value: SlackInstallationKey): string {
  return installationKey(value);
}

export function threadKey(value: ThreadKey): string {
  return `${installationKey(value)}:${value.channelId}:${value.threadTs}`;
}
