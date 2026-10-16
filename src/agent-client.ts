import {
  hostSessionUid,
  type HostShape,
  type Place,
} from "@datalayer/agent-runtimes/lib/portable/hosts";

import type { TurnRequest } from "./domain.js";

/**
 * What is Slack's own in a turn (plans/SLACK.md §4.3; DISCORD DC-004): the
 * session uid a thread derives, the place Datalayer checks the channel
 * policy against, and the target handed back with every delivery. The
 * exchange, the session API and the stream are the shared host kit's
 * (`@datalayer/agent-runtimes/lib/portable/hosts`).
 */

/** A turn's place: its Slack conversation, a direct message's channel starting with D. */
export function placeOf(request: TurnRequest): Place {
  const { channelId } = request.provenance;
  return {
    id: channelId,
    kind: channelId.startsWith("D") ? "direct" : "channel",
  };
}

/** Said when a workspace has no host key: it was installed without Datalayer's code. */
export const NOT_BOUND =
  "This Slack workspace is not connected to Datalayer: install @Datalayer again from the application's Ship tab.";

/** One Slack thread is one session: its uid, derived, so a retry names it again. */
export function sessionUidOf(request: TurnRequest): string {
  const { appId, channelId, enterpriseId, teamId, threadTs } =
    request.provenance;
  return hostSessionUid(
    "slack",
    [appId, enterpriseId ?? "-", teamId, channelId, threadTs],
    request.sessionGeneration,
  );
}

/**
 * Handed back with every delivery (`targetSchema`): the thread, and the
 * Slack user the host token speaks for, whom an approval waits on.
 */
export function targetOf(request: TurnRequest): Record<string, unknown> {
  const { appId, channelId, enterpriseId, teamId, threadTs } =
    request.provenance;
  return {
    appId,
    channelId,
    enterpriseId,
    teamId,
    threadTs,
    userId: request.externalUserId,
  };
}

/** Slack's shape, injected into the shared agent client and exchange. */
export const slackShape: HostShape<TurnRequest["provenance"]> = {
  notBound: NOT_BOUND,
  placeOf,
  sessionUidOf,
  targetOf,
};
