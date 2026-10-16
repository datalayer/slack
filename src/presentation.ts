import {
  answerParts,
  TurnState,
  type AnswerPart,
  type AskQuestion,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import type { KnownBlock } from "@slack/types";

import type { SlackMessage } from "./slack-port.js";

/** Slack's limits on one message (Block Kit reference). */
export const SLACK_LIMITS = {
  /** Blocks in one message. */
  blocks: 50,
  /** Characters of one section's text. */
  sectionText: 3000,
  /** Characters of a message's `text`, the notification and accessibility fallback. */
  fallbackText: 3000,
  /** Characters of one button's value. */
  buttonValue: 2000,
  /** Elements of one context block. */
  contextElements: 10,
} as const;

/** A table shown whole in Slack: at most this many rows and characters. */
export const TABLE_PREVIEW_ROWS = 12;
const TABLE_CHARACTERS = 2_400;

export const STOP_ACTION = "datalayer_stop_turn";
/** A Slack member id: what may be written as a mention. */
export const SLACK_MEMBER_ID = /^[UW][A-Z0-9]{1,23}$/;
export const ASK_CHOICE_ACTION = "datalayer_ask_choice";
export const OPEN_ACTION = "datalayer_open_in_datalayer";
/**
 * What *Open in Datalayer* carries (S-306): the session and the Slack member
 * whose conversation it is. Each press mints its own one-use handoff for
 * that member, so the button never goes stale; the session's person is
 * checked at Datalayer, the member id only names them to anyone else.
 */
export type OpenValue = Readonly<{ s: string; u: string }>;
export function openValueOf(sessionId: string, slackUserId: string): string {
  return JSON.stringify({ s: sessionId, u: slackUserId } satisfies OpenValue);
}
/** Where a link to the conversation would be: the button, pressed for a fresh link. */
const PRESS_OPEN = "press *Open in Datalayer*";
/** The finished answer's menu: *Use another application*, *Start over* (S-208). */
export const THREAD_MENU_ACTION = "datalayer_thread_menu";
export const USE_ANOTHER = "use-another-application";
export const START_OVER = "start-over";

/** Escaped text within Slack's message limit, said when cut. */
export function safeSlackText(text: string): string {
  const escaped = escapeSlack(text);
  return escaped.length <= 39_000
    ? escaped
    : `${escaped.slice(0, 38_984)}\n… Open in Datalayer`;
}

export function stripAppMention(text: string, botUserId?: string): string {
  const expression = botUserId
    ? new RegExp(`<@${escapeRegExp(botUserId)}>`, "g")
    : /<@[A-Z0-9]+>/g;
  return text.replace(expression, "").replace(/\s+/g, " ").trim();
}

/** Text Slack shows as written: its control characters escaped. */
export function escapeSlack(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** A safe Slack link: HTTPS only, its label without link syntax. */
export function slackLink(url: string, label: string): string {
  const parsed = safeHttpsUrl(url);
  const words = escapeSlack(label).replaceAll("|", "¦");
  return parsed ? `<${parsed.replaceAll("|", "%7C")}|${words}>` : words;
}

/** An `https:` URL with no credentials, or nothing. */
export function safeHttpsUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password)
      return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/** A Markdown link in an answer: `[label](url)`. */
const MARKDOWN_LINK = /\[([^\]\n]{1,300})\]\(([^\s)]{1,2000})\)/g;
/**
 * A bare address Slack would make a link of: a `scheme://` URL, or a
 * scheme that runs or mails (`javascript:`, `data:`, `mailto:` …).
 */
const BARE_ADDRESS =
  /\b(?:[a-z][a-z0-9+.-]{1,30}:\/\/|(?:javascript|data|vbscript|file|mailto|tel|slack):)[^\s<>`]+/gi;

/** An address shown as written, in code: Slack makes no link of it. */
function inert(address: string): string {
  return `\`${escapeSlack(address.replaceAll("`", "'"))}\``;
}

/**
 * The answer's links held to HTTPS, as its sources are (S-306): a Markdown
 * link to anything but a credential-free `https:` address, and any bare
 * address that is not one, are kept as code Slack does not link. `link`
 * writes an HTTPS link in the target's own syntax; `text` escapes the rest.
 */
function linksHeldToHttps(
  answer: string,
  link: (url: string, label: string) => string,
  text: (words: string) => string,
): string {
  const kept: string[] = [];
  const hold = (made: string) => {
    kept.push(made);
    return `\uE000${kept.length - 1}\uE001`;
  };
  const marked = answer
    .replace(MARKDOWN_LINK, (_, label: string, url: string) =>
      safeHttpsUrl(url)
        ? hold(link(url, label))
        : `${label} ${hold(inert(url))}`,
    )
    .replace(BARE_ADDRESS, (address) =>
      address.toLowerCase().startsWith("https://") && safeHttpsUrl(address)
        ? address
        : hold(inert(address)),
    );
  return text(marked).replace(
    /\uE000(\d+)\uE001/g,
    (_, index: string) => kept[Number(index)] ?? "",
  );
}

/** Escaped answer words, its Markdown HTTPS links as Slack links, no other link. */
export function answerMrkdwn(text: string): string {
  return linksHeldToHttps(text, slackLink, escapeSlack);
}

/**
 * Streamed answer words (`markdown_text`), held like `answerMrkdwn`: an HTTPS
 * Markdown link stays a Markdown link, no other address is a link.
 */
export function streamMarkdown(text: string): string {
  return linksHeldToHttps(
    text,
    (url, label) =>
      `[${escapeSlack(label).replace(/[[\]]/g, "")}](${safeHttpsUrl(url)!.replaceAll(")", "%29")})`,
    escapeSlack,
  );
}

/** Text cut to `limit` characters, said when cut. */
export function bounded(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** Long words as sections of at most Slack's section length, never cut. */
export function sectionsOf(mrkdwn: string): KnownBlock[] {
  const sections: KnownBlock[] = [];
  let rest = mrkdwn;
  while (rest.length > 0) {
    let cut = rest.length;
    if (cut > SLACK_LIMITS.sectionText) {
      const newline = rest.lastIndexOf("\n", SLACK_LIMITS.sectionText);
      cut = newline > 0 ? newline : SLACK_LIMITS.sectionText;
      // Never split an escape or a link.
      const open = rest.lastIndexOf("<", cut);
      if (open > rest.lastIndexOf(">", cut)) cut = open > 0 ? open : cut;
      const amp = rest.lastIndexOf("&", cut);
      if (amp > cut - 6 && amp > 0 && rest.indexOf(";", amp) >= cut) cut = amp;
    }
    sections.push({
      type: "section",
      text: { type: "mrkdwn", text: rest.slice(0, cut) },
    });
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  return sections;
}

/** A table as a block: fixed width, its first rows when large, and how many more. */
export function tableBlocks(
  table: Extract<AnswerPart, { kind: "table" }>,
  open: boolean,
): KnownBlock[] {
  const rows = table.rows.slice(0, TABLE_PREVIEW_ROWS);
  const widths = table.columns.map((column, index) =>
    Math.min(
      40,
      Math.max(column.length, ...rows.map((row) => (row[index] ?? "").length)),
    ),
  );
  const line = (cells: readonly string[]) =>
    cells
      .map((cell, index) => bounded(cell, widths[index] ?? 40))
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join("  ")
      .trimEnd();
  let body = [
    line(table.columns),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.map(line),
  ].join("\n");
  let shown = rows.length;
  while (body.length > TABLE_CHARACTERS && shown > 1) {
    shown -= 1;
    body = body
      .split("\n")
      .slice(0, shown + 2)
      .join("\n");
  }
  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `\`\`\`${escapeSlack(body)}\`\`\`` },
    },
  ];
  const more = table.rows.length - shown;
  if (more > 0)
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${more} more row${more === 1 ? "" : "s"}: ${open ? `${PRESS_OPEN} to see the whole table` : "the whole table is in the conversation in Datalayer"}.`,
        },
      ],
    });
  return blocks;
}

/**
 * A turn's state as Slack shows it: the shared host kit's `TurnState`
 * (answer, tools, status, question, how it ended), rendered in Block Kit.
 */
export class TurnPresentation extends TurnState {
  /**
   * The message: blocks within Slack's limits and a plain-text fallback for
   * notifications and screen readers. While running, a Stop button names the
   * run shown (`runId`). `openValue` is what *Open in Datalayer* carries
   * (`openValueOf`): no button without one.
   */
  message(
    openValue: string,
    options: {
      runId?: string;
      stopValue?: string;
      askValue?: string;
      threadMenu?: boolean;
      /** A direct message: a plain reply reaches @Datalayer there; in a channel only a mention does. */
      direct?: boolean;
      /** quiet: one status line; noisy: every tool the turn used, listed (S-308). */
      events?: "quiet" | "noisy";
      /**
       * The answer's words were streamed (S-206): these blocks go under them
       * at `chat.stopStream`, so they carry no answer text or table again.
       */
      streamed?: boolean;
      /** The Slack member whose Stop ended the turn (S-205): named on its status line. */
      stoppedBy?: string;
    } = {},
  ): SlackMessage {
    const blocks: KnownBlock[] = [];
    const running = this.running;
    const open = openValue !== "";
    const parts = answerParts(this.answer);
    const citations = parts.filter(
      (part): part is Extract<AnswerPart, { kind: "citation" }> =>
        part.kind === "citation",
    );
    for (const part of options.streamed ? [] : parts) {
      if (part.kind === "text")
        blocks.push(...sectionsOf(answerMrkdwn(part.text)));
      if (part.kind === "table") blocks.push(...tableBlocks(part, open));
    }
    // A file is named, never linked by its own address (S-306): it opens in
    // the conversation in Datalayer, through *Open in Datalayer*'s one-use
    // handoff that needs sign-in, minted on each press. Nothing is uploaded
    // to Slack, and nothing is public.
    for (const file of this.files)
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: bounded(
            `${escapeSlack(file.name)}${file.mediaType ? ` (${escapeSlack(file.mediaType)})` : ""}: ${open ? `${PRESS_OPEN} to open it` : "in the conversation in Datalayer"}`,
            SLACK_LIMITS.sectionText,
          ),
        },
      });
    if (citations.length > 0)
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: bounded(
              `Sources: ${citations.map((one) => slackLink(one.url, one.title)).join(" · ")}`,
              SLACK_LIMITS.sectionText,
            ),
          },
        ],
      });
    if (options.events === "noisy" && this.tools.size > 0)
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: bounded(
              [...this.tools.values()]
                .map(
                  (tool) =>
                    `${tool.status === "running" ? "⏳" : tool.status === "failed" ? "✗" : "✓"} ${escapeSlack(tool.name)}`,
                )
                .join("  "),
              SLACK_LIMITS.sectionText,
            ),
          },
        ],
      });
    if (this.asking)
      blocks.push(
        ...askBlocks(this.asking, open, options.askValue, options.direct),
      );
    const status =
      this.ending === "error"
        ? `Could not finish: ${this.error ?? "the run failed"}`
        : this.ending === "completion"
          ? undefined
          : this.status;
    // A member id is Slack's own (`U…`/`W…`), so the mention is never input.
    const stopper =
      this.ending === "stop" &&
      options.stoppedBy &&
      SLACK_MEMBER_ID.test(options.stoppedBy)
        ? options.stoppedBy
        : undefined;
    if (status)
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: stopper
              ? `_Stopped by <@${stopper}>_`
              : `_${bounded(escapeSlack(status), 300)}_`,
          },
        ],
      });
    const actions: KnownBlock = {
      type: "actions",
      elements: [
        ...(running && options.stopValue
          ? [
              {
                type: "button" as const,
                action_id: STOP_ACTION,
                style: "danger" as const,
                text: { type: "plain_text" as const, text: "Stop" },
                value: bounded(options.stopValue, SLACK_LIMITS.buttonValue),
                accessibility_label: options.runId
                  ? `Stop run ${options.runId}`
                  : "Stop this answer",
              },
            ]
          : []),
        ...(!running && options.threadMenu
          ? [
              {
                type: "overflow" as const,
                action_id: THREAD_MENU_ACTION,
                options: [
                  {
                    text: {
                      type: "plain_text" as const,
                      text: "Use another application",
                    },
                    value: USE_ANOTHER,
                  },
                  {
                    text: { type: "plain_text" as const, text: "Start over" },
                    value: START_OVER,
                  },
                ],
              },
            ]
          : []),
        ...(open
          ? [
              {
                type: "button" as const,
                action_id: OPEN_ACTION,
                text: {
                  type: "plain_text" as const,
                  text: "Open in Datalayer",
                },
                value: bounded(openValue, SLACK_LIMITS.buttonValue),
                accessibility_label:
                  "Open this conversation in Datalayer: a new link, for you only",
              },
            ]
          : []),
      ],
    };
    // The limit holds: the answer's tail is cut, never the actions.
    const room = SLACK_LIMITS.blocks - 1;
    const kept =
      blocks.length <= room
        ? blocks
        : [
            ...blocks.slice(0, room - 1),
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `The rest of this answer is in Datalayer: ${open ? `${PRESS_OPEN}.` : "open the conversation there."}`,
                },
              ],
            } as KnownBlock,
          ];
    return { blocks: [...kept, actions], text: this.fallback() };
  }

  /** The plain words of the message: what a notification and a screen reader say. */
  fallback(): string {
    const words =
      this.ending === "error"
        ? `Could not finish: ${this.error ?? "the run failed"}`
        : this.asking
          ? `${this.answer ? `${this.answer}\n\n` : ""}${this.asking.prompt}`
          : this.answer || this.status;
    // Escaped like the blocks: the notification text never pings
    // <!channel> or anyone the answer happens to spell out.
    return bounded(
      escapeSlack(words.replace(/\s+\n/g, "\n").trim() || "Working…"),
      SLACK_LIMITS.fallbackText,
    );
  }
}

/** A choice button's value: the answer, and the asking event it answers once. */
export function askChoiceValue(option: string, askValue: string): string {
  return JSON.stringify({ a: option, k: askValue });
}

/** The question's message once answered: its buttons replaced by who answered what. */
export function answeredAskBlocks(
  blocks: readonly KnownBlock[],
  option: string,
  slackUserId: string,
): KnownBlock[] {
  return blocks.map(
    (block): KnownBlock =>
      block.type === "actions" &&
      block.elements.some((element) =>
        (element as { action_id?: string }).action_id?.startsWith(
          `${ASK_CHOICE_ACTION}_`,
        ),
      )
        ? {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: bounded(
                  `<@${slackUserId}> answered: ${escapeSlack(option)}`,
                  SLACK_LIMITS.sectionText,
                ),
              },
            ],
          }
        : block,
  );
}

function askBlocks(
  question: AskQuestion,
  open: boolean,
  askValue?: string,
  direct = false,
): KnownBlock[] {
  const prompt: KnownBlock = {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*${bounded(escapeSlack(question.prompt), 2900)}*`,
    },
  };
  if (question.kind === "text")
    return [
      prompt,
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: direct
              ? "Reply in this thread to answer."
              : "Answer in this thread by mentioning @Datalayer with your answer.",
          },
        ],
      },
    ];
  const options = question.options ?? [];
  // Buttons only when every option fits its button whole (S-307): a value
  // cut would lose the press, an empty choice would be an empty block.
  if (
    question.kind === "choice" &&
    askValue &&
    options.length > 0 &&
    options.length <= 5 &&
    options.every(
      (option) =>
        option.length <= 75 &&
        askChoiceValue(option, askValue).length <= SLACK_LIMITS.buttonValue,
    )
  )
    return [
      prompt,
      {
        type: "actions",
        elements: options.map((option, index) => ({
          type: "button" as const,
          action_id: `${ASK_CHOICE_ACTION}_${index}`,
          text: { type: "plain_text" as const, text: option },
          value: askChoiceValue(option, askValue),
        })),
      },
    ];
  // A file, a form, or a choice too long for buttons: answered in Datalayer.
  return [
    prompt,
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `This question is answered in Datalayer, where every field is shown: ${open ? `${PRESS_OPEN} to answer it.` : "open the conversation there to answer it."}`,
        },
      ],
    },
  ];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
