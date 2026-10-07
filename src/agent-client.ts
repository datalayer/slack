import { z } from "zod";

import type { AgentUpdate, TurnRequest, TurnStream } from "./domain.js";

export interface AgentClient {
  startTurn(request: TurnRequest): Promise<TurnStream>;
  stopTurn(sessionId: string): Promise<void>;
}

const startSchema = z.object({
  session_id: z.string().min(1),
  stream_url: z.url(),
});
const updateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("status"), label: z.string() }),
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({
    kind: z.literal("tool"),
    name: z.string(),
    status: z.enum(["running", "complete", "failed"]),
  }),
  z.object({ kind: z.literal("complete"), text: z.string().optional() }),
  z.object({ kind: z.literal("error"), message: z.string() }),
]);

/**
 * Portable HTTP adapter for the Datalayer Slack host contract.
 * The endpoints are deliberately host-oriented and require an audience-bound
 * token minted for the linked principal; a workspace bot token is never used.
 */
export class HttpAgentClient implements AgentClient {
  constructor(
    readonly baseUrl: string,
    readonly getHostToken: (request: TurnRequest) => Promise<string>,
    readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async startTurn(request: TurnRequest): Promise<TurnStream> {
    const token = await this.getHostToken(request);
    const response = await this.fetchImplementation(
      `${this.baseUrl}/api/v1/apps/sessions/turns`,
      {
        body: JSON.stringify({
          app_id: request.applicationId,
          external_event_id: request.externalEventId,
          prompt: request.prompt,
          provenance: { host: "slack", ...request.provenance },
          session_id: request.sessionId,
        }),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        method: "POST",
      },
    );
    if (!response.ok)
      throw new Error(`Datalayer refused the turn (${response.status}).`);
    const started = startSchema.parse(await response.json());
    assertTrustedStreamUrl(this.baseUrl, started.stream_url);
    return {
      sessionId: started.session_id,
      updates: this.#readUpdates(started.stream_url, token),
    };
  }

  async stopTurn(sessionId: string): Promise<void> {
    const response = await this.fetchImplementation(
      `${this.baseUrl}/api/v1/apps/sessions/${encodeURIComponent(sessionId)}/stop`,
      { method: "POST" },
    );
    if (!response.ok && response.status !== 409) {
      throw new Error(
        `Datalayer could not stop the turn (${response.status}).`,
      );
    }
  }

  async *#readUpdates(
    streamUrl: string,
    token: string,
  ): AsyncIterable<AgentUpdate> {
    const response = await this.fetchImplementation(streamUrl, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/x-ndjson",
      },
    });
    if (!response.ok || !response.body)
      throw new Error(`Datalayer stream unavailable (${response.status}).`);
    const decoder = new TextDecoder();
    let pending = "";
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines)
        if (line.trim()) yield updateSchema.parse(JSON.parse(line));
    }
    pending += decoder.decode();
    if (pending.trim()) yield updateSchema.parse(JSON.parse(pending));
  }
}

export function assertTrustedStreamUrl(
  baseUrl: string,
  streamUrl: string,
): void {
  const base = new URL(baseUrl);
  const stream = new URL(streamUrl);
  if (stream.protocol !== "https:" || stream.origin !== base.origin) {
    throw new Error("Datalayer returned an untrusted stream URL.");
  }
}
