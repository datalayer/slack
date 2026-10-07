import type { HomeView, KnownBlock } from "@slack/types";

import type { SlackInstallationKey } from "./domain.js";
import { StoreLinks, type AccountLinks } from "./host-installations.js";
import type { SlackStore } from "./store.js";

export const CONNECT_ACTION = "datalayer_connect_account";

/**
 * @Datalayer's Home (plans/SLACK.md §3.1, S-104): whether this person's
 * Datalayer account is connected and, when it is not, *Connect your
 * Datalayer account* — a fresh one-use link to Datalayer's confirm page,
 * where they are signed in and confirm the link themselves. A workspace
 * installed without Datalayer's code says so instead.
 */
export async function homeView(
  store: SlackStore,
  key: SlackInstallationKey,
  slackUserId: string,
  webUrl: string,
  links: AccountLinks = new StoreLinks(store),
): Promise<HomeView> {
  const [link, applicationId] = await Promise.all([
    links.linkOf(key, slackUserId),
    store.getDefaultApplication(key),
  ]);
  const connected = Boolean(link);
  const connectUrl = connected
    ? undefined
    : await links.connectUrlOf(key, slackUserId);
  const buttons: KnownBlock = {
    type: "actions",
    elements: [
      ...(connectUrl
        ? [
            {
              type: "button" as const,
              style: "primary" as const,
              text: {
                type: "plain_text" as const,
                text: "Connect your Datalayer account",
              },
              url: connectUrl,
              action_id: CONNECT_ACTION,
            },
          ]
        : []),
      {
        type: "button",
        text: { type: "plain_text", text: "Read the guide" },
        url: `${webUrl}/docs/slack`,
        action_id: "open_datalayer_slack_docs",
      },
    ],
  };
  return {
    type: "home",
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "Datalayer", emoji: true },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: connected
            ? "Ask a Datalayer application in a direct message, or invite `@Datalayer` to a channel and mention it."
            : connectUrl
              ? "Connect your Datalayer account before asking an application from Slack: Datalayer asks you to sign in, then to confirm. The link works once, for ten minutes; open this Home again for another."
              : "This workspace is not connected to Datalayer yet: the application's owner installs @Datalayer from its Ship tab in Datalayer.",
        },
      },
      { type: "divider" },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Account*\n${connected ? "Connected" : "Not connected"}`,
          },
          {
            type: "mrkdwn",
            text: `*Default application*\n${applicationId ?? "Not configured"}`,
          },
        ],
      },
      buttons,
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "Datalayer reads direct messages and messages that mention the app. It does not read ambient channel history.",
          },
        ],
      },
    ],
  };
}
