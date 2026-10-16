import { createHash } from "node:crypto";

import { semanticOf, sseEvents, turnOf } from "./ag-ui.js";
import type { TurnRequest, TurnStream } from "./domain.js";
import { HostRefusedError } from "./host-client.js";
import type { SemanticEvent } from "./semantic.js";
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

/** What the installation's key is, for a turn: `undefined` when it was never bound. */
export type HostKeyLookup = (
  request: TurnRequest,
) => Promise<string | undefined>;

/** Where a host asks from (`exchange.optional_request.place`): a channel, or a direct conversation. */
export type Place = Readonly<{ kind: "channel" | "direct"; id: string }>;

/** A turn's place: its Slack conversation, a direct message's channel starting with D. */
export function placeOf(request: TurnRequest): Place {
  const { channelId } = request.provenance;
  return {
    id: channelId,
    kind: channelId.startsWith("D") ? "direct" : "channel",
  };
}

/** Said when a workspace has no host key: it was installed without Datalayer's code. */
export const NOT_BOUND =
  "This Slack workspace is not connected to Datalayer: install @Datalayer again from the application's Ship tab.";

/**
 * The host credential exchange (§4.3, 1): the installation's key and the
 * Slack user it speaks for, exchanged at ai-agents for a fifteen-minute host
 * token of the linked person and one deployment.
 */
export class HostKeyCredentials implements HostCredentials {
  constructor(
    readonly apiUrl: string,
    readonly hostKeyFor: HostKeyLookup,
    readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async exchange(request: TurnRequest): Promise<HostExchange> {
    const hostKey = await this.hostKeyFor(request);
    if (!hostKey) throw new Error(NOT_BOUND);
    return this.exchangeFor({
      deploymentUid: request.applicationId,
      externalUserId: request.externalUserId,
      hostKey,
      place: placeOf(request),
    });
  }

  /** The exchange for one Slack user and deployment, with a key in hand (a delivery, an action). */
  async exchangeFor(input: {
    deploymentUid: string;
    externalUserId: string;
    hostKey: string;
    /** Where the turn is asked from: Datalayer refuses a denied channel at once. */
    place?: Place;
  }): Promise<HostExchange> {
    const response = await this.fetchImplementation(
      `${this.apiUrl}/api/ai-agents/v1/apps/hosts/self/token`,
      {
        body: JSON.stringify({
          deployment_uid: input.deploymentUid,
          external_user_id: input.externalUserId,
          ...(input.place ? { place: input.place } : {}),
        }),
        headers: {
          "content-type": "application/json",
          [HOST_KEY_HEADER]: input.hostKey,
        },
        method: "POST",
      },
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        detail?: unknown;
      };
      throw new HostRefusedError(
        response.status,
        typeof body.detail === "string" ? body.detail : "refused",
        "Datalayer refused the host credential exchange",
      );
    }
    return exchangeSchema.parse(await response.json());
  }

  async forTurn(request: TurnRequest): Promise<HostSession> {
    return hostSessionOf(await this.exchange(request));
  }
}

export function hostSessionOf(exchanged: HostExchange): HostSession {
  return {
    accessToken: exchanged.access_token,
    agent: exchanged.session_api.agent,
    bindable: true,
    deploymentUid: exchanged.deployment.uid,
    sessionApiUrl: exchanged.session_api.url,
    userToken: exchanged.user_token,
  };
}

/**
 * A turn's credentials: the exchange when its workspace holds a host key;
 * otherwise, in development only, the developer's own (`fallback`); otherwise
 * a refusal saying the workspace is not connected.
 */
export class InstallationCredentials implements HostCredentials {
  constructor(
    readonly keyed: HostKeyCredentials,
    readonly fallback?: HostCredentials,
  ) {}

  async forTurn(request: TurnRequest): Promise<HostSession> {
    if (await this.keyed.hostKeyFor(request))
      return this.keyed.forTurn(request);
    if (this.fallback) return this.fallback.forTurn(request);
    throw new Error(NOT_BOUND);
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
  const generation = request.sessionGeneration
    ? `:${request.sessionGeneration}`
    : "";
  const key = `${appId}:${enterpriseId ?? "-"}:${teamId}:${channelId}:${threadTs}${generation}`;
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
    readonly hostKeyFor?: HostKeyLookup,
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
    const hostKey =
      host.bindable && this.hostKeyFor
        ? await this.hostKeyFor(request)
        : undefined;
    if (hostKey) await this.#bind(request, host, sessionId, hostKey);
    const run: { id?: string } = {};
    return {
      run,
      sessionId,
      updates: this.#updates(response.body, host, sessionId, run),
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
        // Handed back with every delivery (`targetSchema`): the thread, and
        // the Slack user the host token speaks for, whom an approval waits on.
        body: JSON.stringify({
          target: {
            appId,
            channelId,
            enterpriseId,
            teamId,
            threadTs,
            userId: request.externalUserId,
          },
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
    run: { id?: string },
  ): AsyncIterable<SemanticEvent> {
    const tools = new Map<string, string>();
    for await (const event of sseEvents(body)) {
      const turn = turnOf(event);
      if (turn?.turn) run.id = turn.turn;
      if (turn?.replayed) {
        // A retry: nothing ran again; what the turn said is the session's.
        yield* this.#replayed(host, sessionId, turn.state);
        return;
      }
      yield* semanticOf(event, tools);
    }
  }

  async *#replayed(
    host: HostSession,
    sessionId: string,
    state: string,
  ): AsyncIterable<SemanticEvent> {
    if (state === "running") {
      yield { kind: "progress", label: "Still working on this message…" };
      return;
    }
    const text = await lastAnswer(this.fetchImplementation, host, sessionId);
    if (text === null) {
      yield {
        kind: "error",
        message: "This message was already answered in Datalayer.",
      };
      return;
    }
    yield { kind: "completion", text };
  }
}

/**
 * The session's last answer, read with the host token (what a replayed turn
 * and a `turn.completed` delivery show); `null` when the session is not read.
 */
export async function lastAnswer(
  fetchImplementation: typeof fetch,
  host: HostSession,
  sessionId: string,
): Promise<string | undefined | null> {
  const response = await fetchImplementation(
    `${host.sessionApiUrl}/${encodeURIComponent(sessionId)}/messages`,
    { headers: { authorization: `Bearer ${host.accessToken}` } },
  );
  if (!response.ok) return null;
  const { messages } = (await response.json()) as {
    messages?: Array<{ content?: unknown; role?: string }>;
  };
  const last = [...(messages ?? [])]
    .reverse()
    .find((message) => message.role === "assistant");
  return typeof last?.content === "string" ? last.content : undefined;
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
