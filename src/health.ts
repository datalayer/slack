import {
  answerHealth,
  timestampWithinWindow,
  type ReadinessChecks,
} from "@datalayer/agent-runtimes/lib/portable/hosts";
import type { CustomRoute } from "@slack/bolt";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Liveness and readiness as Bolt routes (plans/SLACK.md §10, S-101): the
 * shared host kit's `/healthz` and `/readyz`, served by Bolt's receiver.
 */
export function healthRoutes(checks: ReadinessChecks): CustomRoute[] {
  return ["/healthz", "/readyz"].map((path) => ({
    method: ["GET"],
    path,
    handler: (request: IncomingMessage, response: ServerResponse) => {
      answerHealth(checks, request, response);
    },
  }));
}

type Listener = (request: IncomingMessage, response: ServerResponse) => void;

/**
 * Put the shared two-sided timestamp window (`timestampWithinWindow`) in
 * front of Bolt's HTTP receiver, for every Slack route (events, actions,
 * OAuth callbacks are not signed and pass). Bolt refuses only a past
 * timestamp; a future one, which a replay with a skewed clock could carry,
 * is refused here. Bolt 5.1.0 keeps its receiver as `app.receiver` and calls
 * its `requestListener` per request; `test/receiver.test.ts` holds this.
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
