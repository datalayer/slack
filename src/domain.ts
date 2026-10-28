import type {
  HostTurnRequest,
  StarterSource as HostStarterSource,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

export type SlackInstallationKey = Readonly<{
  appId: string;
  enterpriseId?: string;
  teamId: string;
}>;

export type SlackInstallation = SlackInstallationKey &
  Readonly<{
    botToken: string;
    /**
     * With token rotation (staging and production manifests): the refresh
     * token Slack answered with the bot token, and when that token expires
     * (UTC seconds). Encrypted at rest like the bot token; never logged.
     */
    botRefreshToken?: string;
    botTokenExpiresAt?: number;
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

/**
 * A Slack app the person brings (decided 28 October 2026): their own app,
 * installed to one workspace from an application's Ship tab with its bot
 * token pasted. Its installation is a `SlackInstallation` like any (keyed
 * by its app id); this is what only a custom app has: the signing secret
 * the service verifies Slack's requests to `/slack/apps/<app_id>/events`
 * with — encrypted at rest, never logged — and its bot id.
 */
export type SlackCustomApp = Readonly<{
  appId: string;
  teamId: string;
  botId: string;
  signingSecret: string;
  createdAt: string;
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
 * An application the installation allows (`slack_app_allowance`):
 * Datalayer's allowlist (`GET /apps/hosts/self`),
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
/** How an answer shows its work (S-308): one status line, or every tool listed. */
export type EventPolicy = "quiet" | "noisy";

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
    /** The last heartbeat of the worker answering it (S-207): a long turn is not a crashed one. */
    heartbeatAt?: string;
    /** The run the stream named: what Stop stops. */
    runId?: string;
    /** The message the answer is in: what a recovered turn resumes. */
    messageTs?: string;
    sessionId?: string;
    /**
     * The Slack member whose Stop ended this turn (S-205): written before
     * Datalayer is asked to stop it, read by the worker answering it when its
     * stream ends without an ending (a stopped session's stream just ends).
     */
    stoppedBy?: string;
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
 * The idempotency record of an inbound Slack event (S-004): the ingress
 * claim of its event id, made with its job, holding the hash of the request
 * as normalized at ingress, where its turn stands, what answered it, and
 * until when it is kept. A redelivery is the same hash; the same event id
 * with another hash is another request, refused.
 */
export type InboundState = "claimed" | "answered" | "refused" | "failed";

/** What answered an inbound event: its Datalayer session and turn, its Slack message. */
export type InboundResult = Readonly<{
  sessionId?: string;
  turnId?: string;
  messageTs?: string;
}>;

export type InboundRecord = Readonly<{
  eventId: string;
  requestHash: string;
  state: InboundState;
  result?: InboundResult;
  expiresAt: string;
}>;

/**
 * An inbound event's hash against its record: recorded the first time, the
 * same request again (a Slack retry), or another request under the event id.
 */
export type InboundOutcome = "first" | "replay" | "conflict";

/** How long an inbound event's record is kept: longer than Slack retries for. */
export const INBOUND_TTL_MS = 24 * 3600 * 1000;

/** How often the expired inbound records are purged. */
export const INBOUND_PURGE_MS = 3600 * 1000;

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

/** A Slack turn: the shared host turn, its provenance the Slack thread. */
export type TurnRequest = HostTurnRequest<ThreadKey>;

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

/** Where an application's starters are read, as one linked person of one workspace. */
export type StarterSource = HostStarterSource<SlackInstallationKey>;
