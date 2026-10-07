import { createHash } from "node:crypto";

import { sseEvents, turnOf, updateOf } from "./ag-ui.js";
import type { AgentUpdate, TurnRequest, TurnStream } from "./domain.js";
import {
  exchangeSchema,
  HOST_KEY_HEADER,
  IDEMPOTENCY_HEADER,
  type HostExchange,
} from "./host-contracts.js";

export interface AgentClient {
  startTurn(request: TurnRequest): Promise<TurnStream>;
  stopTurn(sessionId: string, request: TurnRequest): Promise<void>;
}

/**
 * What a turn runs with: a short-lived credential for the linked person and
 * where the deployment's session API is. A workspace bot token is never one.
 */
export type HostSession = Readonly<{
  accessToken: string;
  agent: string;
  deploymentUid: string;
  /** Whether the session can be mapped to its Slack thread for deliveries. */
  bindable: boolean;
  sessionApiUrl: string;
  userToken?: string;
}>;

export interface HostCredentials {
  forTurn(request: TurnRequest): Promise<HostSession>;
}

/**
 * The host credential exchange (§4.3, 1): the installation's key and the
 * Slack user it speaks for, exchanged at ai-agents for a fifteen-minute host
 * token of the linked person and one deployment.
 */
export class HostKeyCredentials implements HostCredentials {
  constructor(
    readonly apiUrl: string,
    readonly hostKeyFor: (request: TurnRequest) => Promise<string>,
    readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async exchange(request: TurnRequest): Promise<HostExchange> {
    const response = await this.fetchImplementation(
      `${this.apiUrl}/api/ai-agents/v1/apps/hosts/self/token`,
      {
        body: JSON.stringify({
          deployment_uid: request.applicationId,
          external_user_id: request.externalUserId,
        }),
        headers: {
          "content-type": "application/json",
          [HOST_KEY_HEADER]: await this.hostKeyFor(request),
        },
        method: "POST",
      },
    );
    if (!response.ok)
      throw new Error(
        `Datalayer refused the host credential exchange (${response.status}).`,
      );
    return exchangeSchema.parse(await response.json());
  }

  async forTurn(request: TurnRequest): Promise<HostSession> {
    const exchanged = await this.exchange(request);
    return {
      accessToken: exchanged.access_token,
      agent: exchanged.session_api.agent,
      bindable: true,
      deploymentUid: exchanged.deployment.uid,
      sessionApiUrl: exchanged.session_api.url,
      userToken: exchanged.user_token,
    };
  }
}

/**
 * Development only: the developer's own Datalayer key, and their own kept
 * deployment, read from ai-agents as its owner. Never in production.
 */
export class DevelopmentCredentials implements HostCredentials {
  constructor(
    readonly apiUrl: string,
    readonly token: string,
    readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async forTurn(request: TurnRequest): Promise<HostSession> {
    const response = await this.fetchImplementation(
      `${this.apiUrl}/api/ai-agents/v1/apps/deployments/${encodeURIComponent(request.applicationId)}`,
      { headers: { authorization: `Bearer ${this.token}` } },
    );
    if (!response.ok)
      throw new Error(
        `Datalayer did not answer the deployment (${response.status}).`,
      );
    const body = (await response.json()) as {
      deployment?: { kept?: { agent_id?: string; url?: string } };
    };
    const kept = body.deployment?.kept;
    if (!kept?.url || !kept.agent_id)
      throw new Error(
        "The deployment is not kept always on: turn it on under Ship.",
      );
    return {
      accessToken: this.token,
      agent: kept.agent_id,
      bindable: false,
      deploymentUid: request.applicationId,
      sessionApiUrl: `${kept.url.replace(/\/+$/, "")}/api/v1/apps/sessions`,
    };
  }
}

/** One Slack thread is one session: its uid, derived, so a retry names it again. */
export function sessionUidOf(request: TurnRequest): string {
  const { appId, channelId, enterpriseId, teamId, threadTs } =
    request.provenance;
  const key = `${appId}:${enterpriseId ?? "-"}:${teamId}:${channelId}:${threadTs}`;
  return `slack-${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
}

/**
 * The portable Datalayer host client: a turn is started or sent on the
 * deployment's session API (idempotent by the Slack event id, §4.3, 2), its
 * AG-UI stream reduced to Slack-safe updates, and its session mapped to the
 * thread so that approvals and completions are delivered (§4.3, 3).
 */
export class HttpAgentClient implements AgentClient {
  constructor(
    readonly apiUrl: string,
    readonly credentials: HostCredentials,
    readonly fetchImplementation: typeof fetch = fetch,
    readonly hostKeyFor?: (request: TurnRequest) => Promise<string>,
  ) {}

  async startTurn(request: TurnRequest): Promise<TurnStream> {
    const host = await this.credentials.forTurn(request);
    assertTrustedStreamUrl(this.apiUrl, host.sessionApiUrl);
    const sessionId = request.sessionId ?? sessionUidOf(request);
    const headers = {
      accept: "text/event-stream",
      authorization: `Bearer ${host.accessToken}`,
      "content-type": "application/json",
      [IDEMPOTENCY_HEADER]: request.externalEventId,
    };
    const response = request.sessionId
      ? await this.fetchImplementation(
          `${host.sessionApiUrl}/${encodeURIComponent(sessionId)}/messages`,
          {
            body: JSON.stringify({
              external_event_id: request.externalEventId,
              text: request.prompt,
            }),
            headers,
            method: "POST",
          },
        )
      : await this.fetchImplementation(host.sessionApiUrl, {
          body: JSON.stringify({
            agent: host.agent,
            deployment_uid: host.deploymentUid,
            external_event_id: request.externalEventId,
            opener: request.prompt,
            session: sessionId,
            ...(host.userToken ? { user_token: host.userToken } : {}),
          }),
          headers,
          method: "POST",
        });
    if (!response.ok || !response.body)
      throw new Error(`Datalayer refused the turn (${response.status}).`);
    if (host.bindable && this.hostKeyFor)
      await this.#bind(
        request,
        host,
        sessionId,
        await this.hostKeyFor(request),
      );
    return {
      sessionId,
      updates: this.#updates(response.body, host, sessionId),
    };
  }

  async stopTurn(sessionId: string, request: TurnRequest): Promise<void> {
    const host = await this.credentials.forTurn(request);
    assertTrustedStreamUrl(this.apiUrl, host.sessionApiUrl);
    const response = await this.fetchImplementation(
      `${host.sessionApiUrl}/${encodeURIComponent(sessionId)}/stop`,
      {
        headers: { authorization: `Bearer ${host.accessToken}` },
        method: "POST",
      },
    );
    if (!response.ok && response.status !== 409) {
      throw new Error(
        `Datalayer could not stop the turn (${response.status}).`,
      );
    }
  }

  async #bind(
    request: TurnRequest,
    host: HostSession,
    sessionId: string,
    hostKey: string,
  ): Promise<void> {
    const { appId, channelId, enterpriseId, teamId, threadTs } =
      request.provenance;
    const response = await this.fetchImplementation(
      `${this.apiUrl}/api/ai-agents/v1/apps/hosts/sessions/${encodeURIComponent(sessionId)}`,
      {
        body: JSON.stringify({
          target: { appId, channelId, enterpriseId, teamId, threadTs },
        }),
        headers: {
          authorization: `Bearer ${host.accessToken}`,
          "content-type": "application/json",
          [HOST_KEY_HEADER]: hostKey,
        },
        method: "PUT",
      },
    );
    if (!response.ok)
      throw new Error(
        `Datalayer did not map the thread to its session (${response.status}).`,
      );
  }

  async *#updates(
    body: ReadableStream<Uint8Array>,
    host: HostSession,
    sessionId: string,
  ): AsyncIterable<AgentUpdate> {
    const tools = new Map<string, string>();
    for await (const event of sseEvents(body)) {
      const turn = turnOf(event);
      if (turn?.replayed) {
        // A retry: nothing ran again; what the turn said is the session's.
        yield* this.#replayed(host, sessionId, turn.state);
        return;
      }
      const update = updateOf(event, tools);
      if (update) yield update;
    }
  }

  async *#replayed(
    host: HostSession,
    sessionId: string,
    state: string,
  ): AsyncIterable<AgentUpdate> {
    if (state === "running") {
      yield { kind: "status", label: "Still working on this message…" };
      return;
    }
    const response = await this.fetchImplementation(
      `${host.sessionApiUrl}/${encodeURIComponent(sessionId)}/messages`,
      { headers: { authorization: `Bearer ${host.accessToken}` } },
    );
    if (!response.ok) {
      yield {
        kind: "error",
        message: "This message was already answered in Datalayer.",
      };
      return;
    }
    const { messages } = (await response.json()) as {
      messages?: Array<{ content?: unknown; role?: string }>;
    };
    const last = [...(messages ?? [])]
      .reverse()
      .find((message) => message.role === "assistant");
    yield {
      kind: "complete",
      text: typeof last?.content === "string" ? last.content : undefined,
    };
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
