import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  assertTrustedStreamUrl,
  HostKeyCredentials,
  HttpAgentClient,
  sessionUidOf,
} from "../src/agent-client.js";
import type { AgentUpdate, TurnRequest } from "../src/domain.js";

const contracts = JSON.parse(
  readFileSync(new URL("./contracts/contracts.json", import.meta.url), "utf8"),
) as {
  exchange: { request: Record<string, string>; response_keys: string[] };
  external_turn: { start_request: Record<string, string> };
  headers: Record<string, string>;
};

const API = "https://prod1.datalayer.run";

const request: TurnRequest = {
  applicationId: "dep-1",
  externalEventId: "Ev0123",
  externalUserId: "U0ALICE",
  principalId: "alice",
  prompt: "Summarize the launch risks",
  provenance: {
    appId: "A0",
    channelId: "C0",
    teamId: "T0",
    threadTs: "1700000000.000001",
  },
};

const exchanged = {
  success: true,
  access_token: "host-token",
  token_type: "Bearer",
  expires_in: 900,
  exp: 4102444800,
  principal_uid: "alice",
  host_uid: "inst-1",
  deployment: { uid: "dep-1", app_uid: "app-1", app_name: "Desk", version: 5 },
  session_api: { url: `${API}/rt-1/api/v1/apps/sessions`, agent: "agent-desk" },
};

function sse(...events: unknown[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

async function collect(updates: AsyncIterable<AgentUpdate>) {
  const seen: AgentUpdate[] = [];
  for await (const update of updates) seen.push(update);
  return seen;
}

type Call = {
  body?: unknown;
  headers: Record<string, string>;
  method: string;
  url: string;
};

function wire(answers: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fetchImplementation = (async (
    input: string | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    calls.push({
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
      method: init?.method ?? "GET",
      url,
    });
    const key = `${init?.method ?? "GET"} ${url}`;
    const answer = answers[key];
    if (!answer) throw new Error(`unexpected ${key}`);
    return answer();
  }) as typeof fetch;
  return { calls, fetchImplementation };
}

describe("Datalayer agent client", () => {
  it("accepts an HTTPS stream on the configured Datalayer origin", () => {
    expect(() =>
      assertTrustedStreamUrl(API, `${API}/api/v1/stream/one`),
    ).not.toThrow();
  });

  it("refuses a stream URL that could exfiltrate the host token", () => {
    expect(() =>
      assertTrustedStreamUrl(API, "https://attacker.example/collect"),
    ).toThrow(/untrusted stream URL/);
  });

  it("exchanges the host key, runs the turn once by its event id and maps the thread", async () => {
    const session = sessionUidOf(request);
    const { calls, fetchImplementation } = wire({
      [`POST ${API}/api/ai-agents/v1/apps/hosts/self/token`]: () =>
        Response.json(exchanged),
      [`POST ${exchanged.session_api.url}`]: () =>
        sse(
          { type: "CUSTOM", name: "loop.session", value: { uid: session } },
          {
            type: "CUSTOM",
            name: "loop.turn",
            value: { session, turn: "t1", replayed: false, state: "running" },
          },
          { type: "TOOL_CALL_START", toolCallId: "c1", toolCallName: "search" },
          { type: "TOOL_CALL_END", toolCallId: "c1" },
          { type: "TEXT_MESSAGE_CONTENT", delta: "Option B " },
          { type: "TEXT_MESSAGE_CONTENT", delta: "is safer." },
          { type: "RUN_FINISHED" },
        ),
      [`PUT ${API}/api/ai-agents/v1/apps/hosts/sessions/${session}`]: () =>
        Response.json({ success: true }),
    });
    const hostKey = async () => "dlhk_key";
    const client = new HttpAgentClient(
      API,
      new HostKeyCredentials(API, hostKey, fetchImplementation),
      fetchImplementation,
      hostKey,
    );

    const turn = await client.startTurn(request);
    const seen = await collect(turn.updates);

    expect(turn.sessionId).toBe(session);
    expect(session).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    const [exchange, start, bind] = calls;
    expect(exchange?.headers[contracts.headers.host_key!]).toBe("dlhk_key");
    expect(exchange?.body).toEqual({
      deployment_uid: "dep-1",
      external_user_id: "U0ALICE",
    });
    expect(Object.keys(contracts.exchange.request).sort()).toEqual(
      Object.keys(exchange?.body as object).sort(),
    );
    expect(start?.headers.authorization).toBe("Bearer host-token");
    expect(start?.headers[contracts.headers.idempotency_key!]).toBe("Ev0123");
    expect(Object.keys(start?.body as object).sort()).toEqual(
      Object.keys(contracts.external_turn.start_request)
        .filter((key) => key !== "user_token")
        .sort(),
    );
    expect(bind?.method).toBe("PUT");
    expect(bind?.headers[contracts.headers.host_key!]).toBe("dlhk_key");
    expect(seen).toEqual([
      { kind: "tool", name: "search", status: "running" },
      { kind: "tool", name: "search", status: "complete" },
      { kind: "text", text: "Option B " },
      { kind: "text", text: "is safer." },
      { kind: "complete" },
    ]);
  });

  it("answers a replayed turn from the session, running nothing again", async () => {
    const thread = `${exchanged.session_api.url}/S1`;
    const { calls, fetchImplementation } = wire({
      [`POST ${API}/api/ai-agents/v1/apps/hosts/self/token`]: () =>
        Response.json(exchanged),
      [`POST ${thread}/messages`]: () =>
        sse({
          type: "CUSTOM",
          name: "loop.turn",
          value: {
            session: "S1",
            turn: "t1",
            replayed: true,
            state: "finished",
          },
        }),
      [`GET ${thread}/messages`]: () =>
        Response.json({
          messages: [
            { role: "user", content: "Summarize" },
            { role: "assistant", content: "Option B is safer." },
          ],
        }),
    });
    const client = new HttpAgentClient(
      API,
      new HostKeyCredentials(API, async () => "dlhk_key", fetchImplementation),
      fetchImplementation,
    );

    const turn = await client.startTurn({ ...request, sessionId: "S1" });

    expect(await collect(turn.updates)).toEqual([
      { kind: "complete", text: "Option B is safer." },
    ]);
    expect(calls.map((call) => call.method)).toEqual(["POST", "POST", "GET"]);
    expect(calls[1]?.body).toEqual({
      external_event_id: "Ev0123",
      text: "Summarize the launch risks",
    });
  });

  it("says the exchange's refusal and starts nothing", async () => {
    const { calls, fetchImplementation } = wire({
      [`POST ${API}/api/ai-agents/v1/apps/hosts/self/token`]: () =>
        Response.json({ detail: "not linked" }, { status: 403 }),
    });
    const client = new HttpAgentClient(
      API,
      new HostKeyCredentials(API, async () => "dlhk_key", fetchImplementation),
      fetchImplementation,
    );
    await expect(client.startTurn(request)).rejects.toThrow(/403/);
    expect(calls).toHaveLength(1);
  });
});
