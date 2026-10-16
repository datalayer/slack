import type { CustomRoute } from "@slack/bolt";
import type { IncomingMessage, ServerResponse } from "node:http";

export type ReadinessChecks = Readonly<Record<string, () => Promise<boolean>>>;

/**
 * Liveness and readiness (plans/SLACK.md §10, S-101). `/healthz` says the
 * process answers. `/readyz` says it can take durable work now — its store
 * and its queue answer — and never asks Slack or Datalayer, so a transient
 * outage of either does not take the pods out of service: accepted work
 * waits in the queue instead.
 */
export async function readiness(
  checks: ReadinessChecks,
  timeoutMs = 2_000,
): Promise<{ ready: boolean; checks: Record<string, boolean> }> {
  const results: Record<string, boolean> = {};
  await Promise.all(
    Object.entries(checks).map(async ([name, check]) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        results[name] = await Promise.race([
          check(),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
          }),
        ]);
      } catch {
        results[name] = false;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }),
  );
  return {
    checks: results,
    ready: Object.values(results).every(Boolean),
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(JSON.stringify(body));
}

export function healthRoutes(checks: ReadinessChecks): CustomRoute[] {
  return [
    {
      method: ["GET"],
      path: "/healthz",
      handler: (_request: IncomingMessage, response: ServerResponse) =>
        json(response, 200, { status: "ok" }),
    },
    {
      method: ["GET"],
      path: "/readyz",
      handler: (_request: IncomingMessage, response: ServerResponse) => {
        void readiness(checks).then((answer) =>
          json(response, answer.ready ? 200 : 503, answer),
        );
      },
    },
  ];
}

/** How far a Slack request's timestamp may be from now, either way (§7.1, 1). */
export const REQUEST_WINDOW_SECONDS = 5 * 60;

/**
 * Whether a request's `X-Slack-Request-Timestamp` is within five minutes of
 * now, in the past or the future. Bolt refuses only a past timestamp; a
 * future one, which a replay with a skewed clock could carry, is refused here.
 */
export function timestampWithinWindow(
  header: string | string[] | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const value = Number(Array.isArray(header) ? header[0] : header);
  return (
    Number.isInteger(value) &&
    Math.abs(nowSeconds - value) <= REQUEST_WINDOW_SECONDS
  );
}

type Listener = (request: IncomingMessage, response: ServerResponse) => void;

/**
 * Put the two-sided timestamp window in front of Bolt's HTTP receiver, for
 * every Slack route (events, actions, OAuth callbacks are not signed and
 * pass). Bolt 5.1.0 keeps its receiver as `app.receiver` and calls its
 * `requestListener` per request; `test/receiver.test.ts` holds this.
 */
export function guardRequestTimestamps(
  app: unknown,
  paths: readonly string[],
): void {
  const receiver = (app as { receiver?: { requestListener?: Listener } })
    .receiver;
  const original = receiver?.requestListener;
  if (!receiver || !original)
    throw new Error(
      "Bolt's HTTP receiver was not found: the timestamp window cannot be enforced.",
    );
  receiver.requestListener = (request, response) => {
    const path = (request.url ?? "").split("?")[0] ?? "";
    if (
      request.method === "POST" &&
      paths.includes(path) &&
      !timestampWithinWindow(request.headers["x-slack-request-timestamp"])
    ) {
      response.writeHead(401);
      response.end();
      return;
    }
    original(request, response);
  };
}
