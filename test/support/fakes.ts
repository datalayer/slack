import type {
  IncomingPrompt,
  SlackInstallationKey,
  ThreadKey,
  TurnRequest,
} from "../../src/domain.js";
import type { AccountLinks } from "../../src/host-installations.js";
import {
  Logger,
  type AgentClient,
  type Clock,
  type SemanticEvent,
  type TurnStream,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import type {
  SlackMessage,
  SlackPort,
  SlackStreaming,
} from "../../src/slack-port.js";
import { MemorySlackStore } from "../../src/store.js";

/** A clock tests move by hand: `sleep` advances it at once. */
export class FakeClock implements Clock {
  constructor(public time = Date.parse("2026-10-16T08:00:00Z")) {}
  now(): number {
    return this.time;
  }
  async sleep(milliseconds: number): Promise<void> {
    this.time += milliseconds;
  }
  advance(milliseconds: number): void {
    this.time += milliseconds;
  }
}

export type SlackCall = Readonly<{
  method: string;
  key: SlackInstallationKey | ThreadKey;
  userId?: string;
  ts?: string;
  message?: SlackMessage;
  markdown?: string;
}>;

/** Slack's Web API as calls kept in order; `fail` makes the next calls of a method fail. */
export class FakeSlack implements SlackPort {
  readonly calls: SlackCall[] = [];
  readonly failures = new Map<string, unknown[]>();
  #ts = 1;
  streaming?: SlackStreaming;

  constructor(options: { streaming?: boolean } = {}) {
    if (options.streaming)
      this.streaming = {
        append: async (key, ts, markdown) => {
          this.#maybeFail("chat.appendStream");
          this.calls.push({ key, markdown, method: "chat.appendStream", ts });
        },
        start: async (key, userId) => {
          this.#maybeFail("chat.startStream");
          const ts = this.#next();
          this.calls.push({
            key,
            method: "chat.startStream",
            ts,
            userId,
          });
          return ts;
        },
        stop: async (key, ts, message) => {
          this.#maybeFail("chat.stopStream");
          this.calls.push({ key, message, method: "chat.stopStream", ts });
        },
      };
  }

  fail(method: string, ...errors: unknown[]): void {
    this.failures.set(method, [
      ...(this.failures.get(method) ?? []),
      ...errors,
    ]);
  }

  #maybeFail(method: string): void {
    const queued = this.failures.get(method);
    if (queued && queued.length > 0) throw queued.shift();
  }

  #next(): string {
    this.#ts += 1;
    return `${this.#ts}.0`;
  }

  of(method: string): SlackCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  async postDirect(
    key: SlackInstallationKey,
    userId: string,
    message: SlackMessage,
  ) {
    this.#maybeFail("chat.postMessage");
    const ts = this.#next();
    this.calls.push({ key, message, method: "direct", ts, userId });
    return { channelId: `D${userId}`, ts };
  }

  async postPrivate(
    key: SlackInstallationKey | ThreadKey,
    userId: string,
    message: SlackMessage,
  ) {
    this.#maybeFail("private");
    this.calls.push({ key, message, method: "private", userId });
  }

  async postThread(key: ThreadKey, message: SlackMessage): Promise<string> {
    this.#maybeFail("chat.postMessage");
    const ts = this.#next();
    this.calls.push({ key, message, method: "chat.postMessage", ts });
    return ts;
  }

  async updateMessage(key: ThreadKey, ts: string, message: SlackMessage) {
    this.#maybeFail("chat.update");
    this.calls.push({ key, message, method: "chat.update", ts });
  }
}

/** A Slack 429 as `@slack/web-api` throws it. */
export function rateLimited(retryAfterSeconds: number): Error {
  return Object.assign(new Error("A rate limit was exceeded"), {
    code: "slack_webapi_rate_limited_error",
    retryAfter: retryAfterSeconds,
  });
}

/** A Slack platform error as `@slack/web-api` throws it. */
export function platformError(error: string): Error {
  return Object.assign(new Error(`An API error occurred: ${error}`), {
    code: "slack_webapi_platform_error",
    data: { error, ok: false },
  });
}

export async function* streamOf(
  ...events: SemanticEvent[]
): AsyncIterable<SemanticEvent> {
  for (const event of events) yield event;
}

/** An agent client that answers each turn with its scripted events and keeps every request. */
export class FakeAgents implements AgentClient<ThreadKey> {
  readonly requests: TurnRequest[] = [];
  readonly stops: Array<{ sessionId: string; request: TurnRequest }> = [];
  script: (request: TurnRequest) => Promise<TurnStream> | TurnStream;

  constructor(
    script?: (request: TurnRequest) => Promise<TurnStream> | TurnStream,
  ) {
    this.script =
      script ??
      ((request) => ({
        run: { id: "t1" },
        sessionId: request.sessionId ?? `S-${request.sessionGeneration ?? 0}`,
        updates: streamOf(
          { kind: "text", text: "Hello from Datalayer." },
          { kind: "completion" },
        ),
      }));
  }

  async startTurn(request: TurnRequest): Promise<TurnStream> {
    this.requests.push(request);
    return this.script(request);
  }

  async stopTurn(sessionId: string, request: TurnRequest): Promise<void> {
    this.stops.push({ request, sessionId });
  }
}

/** Links decided by a map: Slack user → principal. */
export class FakeLinks implements AccountLinks {
  readonly unlinked: string[] = [];
  constructor(
    readonly linked: Map<string, string> = new Map([["U1", "alice"]]),
    readonly connectUrl?: string,
  ) {}
  async linkOf(_key: SlackInstallationKey, slackUserId: string) {
    const principalId = this.linked.get(slackUserId);
    return principalId ? { principalId } : undefined;
  }
  async connectUrlOf() {
    return this.connectUrl;
  }
  async unlink(_key: SlackInstallationKey, slackUserId: string) {
    this.unlinked.push(slackUserId);
    return this.linked.delete(slackUserId);
  }
}

export const installationKey = { appId: "A1", teamId: "T1" } as const;

export async function installedStore(
  options: {
    defaultApplication?: string;
    allow?: Array<{ id: string; name: string; directOnly?: boolean }>;
  } = {},
): Promise<MemorySlackStore> {
  const store = new MemorySlackStore();
  await store.putInstallation({
    ...installationKey,
    botToken: "xoxb-test",
    botUserId: "B1",
    installedBy: "U0",
    scopes: ["app_mentions:read", "chat:write", "im:history"],
    status: "active",
    updatedAt: new Date(0).toISOString(),
  });
  if (options.defaultApplication)
    await store.setDefaultApplication(
      installationKey,
      options.defaultApplication,
    );
  if (options.allow)
    await store.putAllowances(
      installationKey,
      options.allow.map((one) => ({
        ...installationKey,
        applicationId: one.id,
        channelPolicy: one.directOnly
          ? ("direct-only" as const)
          : ("channels" as const),
        configuredBy: "owner",
        enabled: true,
        isDefault: one.id === options.defaultApplication,
        name: one.name,
        updatedAt: new Date(0).toISOString(),
      })),
    );
  return store;
}

export function promptOf(
  overrides: Partial<IncomingPrompt> = {},
): IncomingPrompt {
  return {
    ...installationKey,
    channelId: "C1",
    eventId: "Ev1",
    text: "<@B1> compare the launch options",
    threadTs: "1.0",
    userId: "U1",
    ...overrides,
  };
}

/** A logger whose lines are kept, to read what was logged. */
export function keptLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return { lines, logger: new Logger((line) => lines.push(line)) };
}
