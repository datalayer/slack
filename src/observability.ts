import { pseudonym } from "@datalayer/agent-runtimes/lib/portable/hosts";

/**
 * Slack's side of the shared observability (plans/SLACK.md §9, §12.2): what
 * its pseudonyms are salted with, and its span attribute names. Logs,
 * redaction, audit and spans are the shared host kit's.
 */

/** What Slack's pseudonyms are salted with. */
export const LOG_SALT =
  process.env.DATALAYER_SLACK_LOG_SALT ?? "datalayer-slack";

/** The pseudonymous attributes of a Slack conversation, for a span. */
export function traceAttributes(key: {
  appId: string;
  enterpriseId?: string;
  teamId: string;
  channelId?: string;
}): Record<string, string> {
  return {
    "datalayer.slack.installation": pseudonym(
      `${key.appId}:${key.enterpriseId ?? "-"}:${key.teamId}`,
      LOG_SALT,
    ),
    ...(key.channelId
      ? { "datalayer.slack.channel": pseudonym(key.channelId, LOG_SALT) }
      : {}),
  };
}
