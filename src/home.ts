import type { HomeView } from "@slack/types";

import type { SlackInstallationKey } from "./domain.js";
import type { SlackStore } from "./store.js";

export async function homeView(
  store: SlackStore,
  key: SlackInstallationKey,
  slackUserId: string,
  webUrl: string,
): Promise<HomeView> {
  const [link, applicationId] = await Promise.all([
    store.getUserLink(key, slackUserId),
    store.getDefaultApplication(key),
  ]);
  const connected = link?.status === "active";
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
            : "Connect your Datalayer account before asking an application from Slack.",
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
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: connected ? "Manage in Datalayer" : "Connect account",
            },
            url: `${webUrl}/settings/integrations/slack`,
            action_id: "open_datalayer_slack_settings",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Read the guide" },
            url: `${webUrl}/docs/slack`,
            action_id: "open_datalayer_slack_docs",
          },
        ],
      },
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
