import type { HomeView, KnownBlock } from "@slack/types";

import type { SlackInstallationKey, Starter, StarterSource } from "./domain.js";
import { StoreLinks, type AccountLinks } from "./host-installations.js";
import { bounded, escapeSlack } from "./presentation.js";
import type { SlackStore } from "./store.js";

export const CONNECT_ACTION = "datalayer_connect_account";
export const UNLINK_ACTION = "datalayer_unlink_account";
export const DOCS_ACTION = "open_datalayer_slack_docs";
export const SUPPORT_ACTION = "open_datalayer_support";

/** The words @Datalayer's Home and the docs page share (S-108). */
export const HOME_WORDS = {
  connect: "Connect your Datalayer account",
  unlink: "Unlink my account",
  guide: "Read the guide",
  support: "Get help",
  privacy:
    "Datalayer reads direct messages and messages that mention the app. It does not read ambient channel history, and Slack data is not used to train models.",
  tryAsking: "Try asking",
  startersUnread:
    "What it suggests asking could not be read from Datalayer just now. Open this Home again later.",
} as const;

/** How many of an application's starters App Home suggests. */
export const HOME_STARTERS = 5;

/** The starters App Home suggests: the default application's, read as this person. */
function startersBlocks(
  name: string,
  starters: readonly Starter[] | "unread",
): KnownBlock[] {
  if (starters === "unread")
    return [
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: HOME_WORDS.startersUnread }],
      },
    ];
  if (starters.length === 0) return [];
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: bounded(
          `*${HOME_WORDS.tryAsking} ${escapeSlack(name)}*\n${starters
            .slice(0, HOME_STARTERS)
            .map(
              (starter) =>
                `• *${escapeSlack(starter.label)}*: ${escapeSlack(bounded(starter.message, 400))}`,
            )
            .join("\n")}`,
          3_000,
        ),
      },
    },
  ];
}

/** A usage line for App Home (S-404): this person's turns against their quota. */
export type HomeUsage = Readonly<{
  used: number;
  limit: number;
  window: string;
}>;

/**
 * @Datalayer's Home (plans/SLACK.md §3.1, S-104): whether this person's
 * Datalayer account is connected; the applications this workspace allows
 * from Slack and the default; the privacy line; *Connect your Datalayer
 * account* (a fresh one-use link) or *Unlink my account*; the guide and
 * support. A workspace installed without Datalayer's code says so instead.
 */
export async function homeView(
  store: SlackStore,
  key: SlackInstallationKey,
  slackUserId: string,
  webUrl: string,
  links: AccountLinks = new StoreLinks(store),
  usage?: HomeUsage,
  /** Where the default application's starters are read (S-104), for a connected person. */
  starters?: StarterSource,
): Promise<HomeView> {
  const [link, applicationId, allowances] = await Promise.all([
    links.linkOf(key, slackUserId),
    store.getDefaultApplication(key),
    store.getAllowances(key),
  ]);
  const connected = Boolean(link);
  const connectUrl = connected
    ? undefined
    : await links.connectUrlOf(key, slackUserId);
  const base = webUrl.replace(/\/+$/, "");
  const enabled = allowances.filter((one) => one.enabled);
  const defaultName =
    allowances.find((one) => one.applicationId === applicationId)?.name ??
    applicationId;
  // Said when they cannot be read, never silently left out.
  const suggested: readonly Starter[] | "unread" =
    connected && applicationId && starters
      ? await starters
          .startersOf(key, slackUserId, applicationId)
          .catch(() => "unread" as const)
      : [];

  const buttons: KnownBlock = {
    type: "actions",
    elements: [
      ...(connectUrl
        ? [
            {
              type: "button" as const,
              style: "primary" as const,
              text: { type: "plain_text" as const, text: HOME_WORDS.connect },
              url: connectUrl,
              action_id: CONNECT_ACTION,
            },
          ]
        : []),
      ...(connected && links.unlink
        ? [
            {
              type: "button" as const,
              text: { type: "plain_text" as const, text: HOME_WORDS.unlink },
              action_id: UNLINK_ACTION,
              confirm: {
                title: {
                  type: "plain_text" as const,
                  text: "Unlink your account?",
                },
                text: {
                  type: "plain_text" as const,
                  text: "@Datalayer stops answering you here until you connect again. Your Datalayer records stay in Datalayer.",
                },
                confirm: { type: "plain_text" as const, text: "Unlink" },
                deny: { type: "plain_text" as const, text: "Keep it" },
              },
            },
          ]
        : []),
      {
        type: "button",
        text: { type: "plain_text", text: HOME_WORDS.guide },
        url: `${base}/docs/slack`,
        action_id: DOCS_ACTION,
      },
      {
        type: "button",
        text: { type: "plain_text", text: HOME_WORDS.support },
        url: `${base}/docs/slack#troubleshooting`,
        action_id: SUPPORT_ACTION,
      },
    ],
  };

  const applications: KnownBlock[] =
    enabled.length > 0
      ? [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Applications you can ask from Slack*\n${enabled
                .slice(0, 20)
                .map(
                  (one) =>
                    `• ${escapeSlack(one.name)}${one.isDefault ? " (default)" : ""}${one.channelPolicy === "direct-only" ? " — direct messages only" : ""}`,
                )
                .join("\n")}`,
            },
          },
        ]
      : [];

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
            text: `*Default application*\n${defaultName ? escapeSlack(defaultName) : "Not configured"}`,
          },
        ],
      },
      ...applications,
      ...startersBlocks(defaultName ?? "", suggested),
      ...(usage
        ? [
            {
              type: "context" as const,
              elements: [
                {
                  type: "mrkdwn" as const,
                  text: `You asked ${usage.used} of ${usage.limit} questions this ${usage.window}.`,
                },
              ],
            },
          ]
        : []),
      buttons,
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: HOME_WORDS.privacy }],
      },
    ],
  };
}
