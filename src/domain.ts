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
    updatedAt: string;
  }>;

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
  }>;

export type AgentUpdate =
  | Readonly<{ kind: "status"; label: string }>
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{
      kind: "tool";
      name: string;
      status: "running" | "complete" | "failed";
    }>
  | Readonly<{ kind: "complete"; text?: string }>
  | Readonly<{ kind: "error"; message: string }>;

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
}>;

export type TurnStream = Readonly<{
  sessionId: string;
  updates: AsyncIterable<AgentUpdate>;
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
