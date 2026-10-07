import type { AgentUpdate } from "./domain.js";

const SLACK_TEXT_LIMIT = 39_000;

export function stripAppMention(text: string, botUserId?: string): string {
  const expression = botUserId
    ? new RegExp(`<@${escapeRegExp(botUserId)}>`, "g")
    : /<@[A-Z0-9]+>/g;
  return text.replace(expression, "").replace(/\s+/g, " ").trim();
}

export function safeSlackText(text: string): string {
  const escaped = text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return escaped.length <= SLACK_TEXT_LIMIT
    ? escaped
    : `${escaped.slice(0, SLACK_TEXT_LIMIT - 16)}\n… Open in Datalayer`;
}

export class TurnPresentation {
  #answer = "";
  #status = "Working…";

  apply(update: AgentUpdate): void {
    switch (update.kind) {
      case "status":
        this.#status = update.label;
        break;
      case "text":
        this.#answer += update.text;
        break;
      case "tool":
        this.#status = `${update.status === "running" ? "Using" : "Used"} ${update.name}`;
        break;
      case "complete":
        if (update.text && !this.#answer) this.#answer = update.text;
        this.#status = "Complete";
        break;
      case "error":
        this.#status = `Could not finish: ${update.message}`;
        break;
    }
  }

  message(openUrl: string): { text: string } {
    const body = this.#answer
      ? safeSlackText(this.#answer)
      : `_${safeSlackText(this.#status)}_`;
    return { text: `${body}\n\n<${openUrl}|Open in Datalayer>` };
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
