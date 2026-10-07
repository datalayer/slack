import type { AgentUpdate } from "./domain.js";

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

/** The Slack-safe update an AG-UI event means, or nothing. */
export function updateOf(
  event: AgUiEvent,
  toolNames: Map<string, string>,
): AgentUpdate | undefined {
  switch (event.type) {
    case "TEXT_MESSAGE_CONTENT":
      return typeof event.delta === "string" && event.delta
        ? { kind: "text", text: event.delta }
        : undefined;
    case "TOOL_CALL_START": {
      const name = String(event.toolCallName ?? "a tool");
      toolNames.set(String(event.toolCallId ?? ""), name);
      return { kind: "tool", name, status: "running" };
    }
    case "TOOL_CALL_END":
      return {
        kind: "tool",
        name: toolNames.get(String(event.toolCallId ?? "")) ?? "a tool",
        status: "complete",
      };
    case "RUN_FINISHED":
      return { kind: "complete" };
    case "RUN_ERROR":
      return {
        kind: "error",
        message: String(event.message ?? "The run failed."),
      };
    case "CUSTOM":
      if (event.name === "loop.ask")
        return { kind: "status", label: "Waiting for your answer" };
      return undefined;
    default:
      return undefined;
  }
}
