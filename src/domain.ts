export type SlackInstallationKey = Readonly<{
  appId: string;
  enterpriseId?: string;
  teamId: string;
}>;

export type SlackInstallation = SlackInstallationKey &
  Readonly<{
    botToken: string;
    botUserId: string;
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

export type ThreadKey = Readonly<{
  channelId: string;
  enterpriseId?: string;
  teamId: string;
  threadTs: string;
}>;

export type ThreadBinding = ThreadKey &
  Readonly<{
    applicationId: string;
    openedByPrincipalId: string;
    sessionId: string;
    updatedAt: string;
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
  applicationId: string;
  externalEventId: string;
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

export function threadKey(value: ThreadKey): string {
  return `${value.enterpriseId ?? "-"}:${value.teamId}:${value.channelId}:${value.threadTs}`;
}
