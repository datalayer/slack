import type { KnownBlock } from "@slack/types";

import type { SlackMessage } from "./slack-port.js";

import {
  answerParts,
  type AnswerPart,
  type AskQuestion,
  type SemanticEvent,
} from "./semantic.js";

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
export const ASK_CHOICE_ACTION = "datalayer_ask_choice";
export const OPEN_ACTION = "datalayer_open_in_datalayer";
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

/** Escaped answer words, its Markdown HTTPS links as Slack links. */
export function answerMrkdwn(text: string): string {
  const links: string[] = [];
  const marked = text.replace(
    /\[([^\]\n]{1,300})\]\((https:\/\/[^\s)]{1,2000})\)/g,
    (_, label: string, url: string) => {
      links.push(slackLink(url, label));
      return `\uE000${links.length - 1}\uE001`;
    },
  );
  return escapeSlack(marked).replace(
    /\uE000(\d+)\uE001/g,
    (_, index: string) => links[Number(index)] ?? "",
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
  openUrl: string,
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
          text: `${more} more row${more === 1 ? "" : "s"}: ${slackLink(openUrl, "see the whole table in Datalayer")}`,
        },
      ],
    });
  return blocks;
}

/** A turn's state as Slack shows it, from its semantic events. */
export class TurnPresentation {
  #answer = "";
  #asking?: AskQuestion;
  #approvals: string[] = [];
  #ended?: "completion" | "stop" | "error";
  #error?: string;
  #files: Array<{ mediaType?: string; name: string; url: string }> = [];
  #status = "Working…";
  #tools = new Map<string, { name: string; status: string }>();

  /** Whether the turn finished while it streamed: else a `turn.completed` delivery finishes it. */
  get complete(): boolean {
    return this.#ended === "completion";
  }

  /** Whether the turn ended (answered, stopped, failed) or waits on a question. */
  get ended(): boolean {
    return this.#ended !== undefined || this.#asking !== undefined;
  }

  get answer(): string {
    return this.#answer;
  }

  apply(event: SemanticEvent): void {
    switch (event.kind) {
      case "text":
        this.#answer += event.text;
        break;
      case "progress":
        this.#status = event.label;
        break;
      case "tool":
        this.#tools.set(event.id || event.name, {
          name: event.name,
          status: event.status,
        });
        this.#status = `${event.status === "running" ? "Using" : event.status === "failed" ? "Failed:" : "Used"} ${event.name}`;
        break;
      case "approval":
        this.#approvals.push(event.toolName);
        this.#status = `Waiting for approval to use ${event.toolName}`;
        break;
      case "file":
        this.#files.push({
          mediaType: event.mediaType,
          name: event.name,
          url: event.url,
        });
        break;
      case "table":
        this.#answer += `\n\n| ${event.columns.join(" | ")} |\n|${event.columns.map(() => "---").join("|")}|\n${event.rows.map((row) => `| ${row.join(" | ")} |`).join("\n")}\n`;
        break;
      case "citation":
        this.#answer += `\n[${event.title}](${event.url})`;
        break;
      case "ask":
        this.#asking = event.question;
        this.#status = "Waiting for your answer";
        break;
      case "completion":
        if (event.text && !this.#answer) this.#answer = event.text;
        this.#ended = "completion";
        this.#status = "Complete";
        break;
      case "stop":
        this.#ended = "stop";
        this.#status = "Stopped";
        break;
      case "error":
        this.#ended = "error";
        this.#error = event.message;
        this.#status = "Could not finish";
        break;
    }
  }

  /**
   * The message: blocks within Slack's limits and a plain-text fallback for
   * notifications and screen readers. While running, a Stop button names the
   * run shown (`runId`).
   */
  message(
    openUrl: string,
    options: {
      runId?: string;
      stopValue?: string;
      askValue?: string;
      threadMenu?: boolean;
      /** A direct message: a plain reply reaches @Datalayer there; in a channel only a mention does. */
      direct?: boolean;
      /** quiet: one status line; noisy: every tool the turn used, listed (S-308). */
      events?: "quiet" | "noisy";
    } = {},
  ): SlackMessage {
    const blocks: KnownBlock[] = [];
    const running = this.#ended === undefined && this.#asking === undefined;
    const parts = answerParts(this.#answer);
    const citations = parts.filter(
      (part): part is Extract<AnswerPart, { kind: "citation" }> =>
        part.kind === "citation",
    );
    for (const part of parts) {
      if (part.kind === "text")
        blocks.push(...sectionsOf(answerMrkdwn(part.text)));
      if (part.kind === "table") blocks.push(...tableBlocks(part, openUrl));
    }
    for (const file of this.#files)
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${slackLink(file.url, file.name)}${file.mediaType ? ` (${escapeSlack(file.mediaType)})` : ""}`,
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
    if (options.events === "noisy" && this.#tools.size > 0)
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: bounded(
              [...this.#tools.values()]
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
    if (this.#asking)
      blocks.push(
        ...askBlocks(this.#asking, openUrl, options.askValue, options.direct),
      );
    const status =
      this.#ended === "error"
        ? `Could not finish: ${this.#error ?? "the run failed"}`
        : this.#ended === "completion"
          ? undefined
          : this.#status;
    if (status)
      blocks.push({
        type: "context",
        elements: [
          { type: "mrkdwn", text: `_${bounded(escapeSlack(status), 300)}_` },
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
        ...(safeHttpsUrl(openUrl)
          ? [
              {
                type: "button" as const,
                action_id: OPEN_ACTION,
                text: {
                  type: "plain_text" as const,
                  text: "Open in Datalayer",
                },
                url: safeHttpsUrl(openUrl),
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
                  text: `The rest of this answer is in Datalayer: ${slackLink(openUrl, "Open in Datalayer")}`,
                },
              ],
            } as KnownBlock,
          ];
    return { blocks: [...kept, actions], text: this.fallback() };
  }

  /** The plain words of the message: what a notification and a screen reader say. */
  fallback(): string {
    const words =
      this.#ended === "error"
        ? `Could not finish: ${this.#error ?? "the run failed"}`
        : this.#asking
          ? `${this.#answer ? `${this.#answer}\n\n` : ""}${this.#asking.prompt}`
          : this.#answer || this.#status;
    return bounded(
      words.replace(/\s+\n/g, "\n").trim() || "Working…",
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
  openUrl: string,
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
          text: `This question is answered in Datalayer, where every field is shown: ${slackLink(openUrl, "Answer in Datalayer")}`,
        },
      ],
    },
  ];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
