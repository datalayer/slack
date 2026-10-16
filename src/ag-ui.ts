import type { AskQuestion, SemanticEvent } from "./semantic.js";

/**
 * The runtime's session API streams AG-UI events as server-sent events. This
 * reads them and reduces each to the semantic update Slack renders; it never
 * renders a notebook or a web component.
 */

export type AgUiEvent = Readonly<Record<string, unknown> & { type?: unknown }>;

/** Each whole `data:` event of an SSE stream, parsed. */
export async function* sseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<AgUiEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let pending = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const blocks = pending.split(/\r?\n\r?\n/);
    pending = blocks.pop() ?? "";
    for (const block of blocks) {
      const event = parseBlock(block);
      if (event) yield event;
    }
  }
  pending += decoder.decode();
  const last = parseBlock(pending);
  if (last) yield last;
}

function parseBlock(block: string): AgUiEvent | undefined {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("");
  if (!data) return undefined;
  const parsed: unknown = JSON.parse(data);
  return parsed && typeof parsed === "object"
    ? (parsed as AgUiEvent)
    : undefined;
}

/** What one turn says of itself: its id, and whether it is a replay. */
export type TurnInfo = Readonly<{
  replayed: boolean;
  session: string;
  state: string;
  turn: string;
}>;

export function turnOf(event: AgUiEvent): TurnInfo | undefined {
  if (event.type !== "CUSTOM" || event.name !== "loop.turn") return undefined;
  const value = (event.value ?? {}) as Record<string, unknown>;
  return {
    replayed: value.replayed === true,
    session: String(value.session ?? ""),
    state: String(value.state ?? ""),
    turn: String(value.turn ?? ""),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** What a tool's result says of itself: JSON when it is JSON, else nothing. */
function resultRecord(content: unknown): Record<string, unknown> | undefined {
  if (isRecord(content)) return content;
  if (typeof content !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The question a turn ends on (`RUN_FINISHED.result.asking`, `loop.ask`). */
export function questionOf(value: unknown): AskQuestion | undefined {
  if (!isRecord(value) || typeof value.prompt !== "string") return undefined;
  const kind =
    value.kind === "choice" || value.kind === "file" || value.kind === "form"
      ? value.kind
      : "text";
  const options = Array.isArray(value.options)
    ? value.options.filter((one): one is string => typeof one === "string")
    : undefined;
  return kind === "choice"
    ? { kind, prompt: value.prompt, options: options ?? [] }
    : { kind, prompt: value.prompt };
}

/**
 * The semantic events (version 1, `src/semantic.ts`) one AG-UI event means:
 * none for an event Slack does not show. `tools` keeps each running call's
 * name by its id, for its result.
 */
export function semanticOf(
  event: AgUiEvent,
  tools: Map<string, string>,
): SemanticEvent[] {
  switch (event.type) {
    case "TEXT_MESSAGE_CONTENT":
    case "TEXT_MESSAGE_CHUNK":
      return typeof event.delta === "string" && event.delta
        ? [{ kind: "text", text: event.delta }]
        : [];
    case "TOOL_CALL_START": {
      const id = String(event.toolCallId ?? "");
      const name = String(event.toolCallName ?? "a tool");
      tools.set(id, name);
      return [{ kind: "tool", id, name, status: "running" }];
    }
    case "TOOL_CALL_RESULT": {
      const id = String(event.toolCallId ?? "");
      const name = tools.get(id) ?? "a tool";
      const result = resultRecord(event.content);
      if (result?.pending_approval === true)
        return [{ kind: "approval", toolCallId: id, toolName: name }];
      const failed = result?.success === false || result?.isError === true;
      return [
        { kind: "tool", id, name, status: failed ? "failed" : "complete" },
      ];
    }
    case "STEP_STARTED":
      return typeof event.stepName === "string" && event.stepName
        ? [{ kind: "progress", label: event.stepName }]
        : [];
    case "RUN_FINISHED": {
      const asking = questionOf(
        isRecord(event.result) ? event.result.asking : undefined,
      );
      return asking
        ? [{ kind: "ask", question: asking }]
        : [{ kind: "completion" }];
    }
    case "RUN_ERROR":
      return [
        {
          kind: "error",
          message: String(event.message ?? "The run failed."),
        },
      ];
    case "CUSTOM": {
      if (event.name === "loop.ask") {
        const asking = questionOf(event.value);
        return asking ? [{ kind: "ask", question: asking }] : [];
      }
      if (event.name === "loop.turn" && isRecord(event.value))
        return event.value.state === "stopped" ? [{ kind: "stop" }] : [];
      return [];
    }
    default:
      return [];
  }
}
