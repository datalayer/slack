# ADR 0001: Bolt for JavaScript, signed HTTPS and a durable queue

- **Status:** accepted on 7 October 2026. Recorded on 16 October 2026 (S-002).
- **Plan:** `plans/SLACK.md` §4 and §7.1.

## Context

@Datalayer receives Slack Events API deliveries, interactive actions and OAuth
callbacks. Slack expects an acknowledgement within three seconds and retries
deliveries that are not acknowledged. An answer comes from a Datalayer session
that can run for minutes and needs approvals. The service has to:

- scale beyond one replica;
- survive restarts without losing acknowledged work;
- never run a turn twice.

## Decision

1. **TypeScript on Node.js ≥ 20 with `@slack/bolt`.** Bolt is the official
   Slack framework. It handles signature verification (raw body,
   constant-time comparison, a five-minute window), OAuth v2, the installation
   store and the Web API client. The business rules live outside the Bolt
   listeners (`src/service.ts`, `src/deliveries.ts`, `src/routing.ts`), so
   tests drive them with fixtures.
2. **Signed HTTPS in production, Socket Mode for development only.**
   `DATALAYER_SLACK_TRANSPORT=http` is the production receiver.
   `npm run dev:socket` serves a developer's sandbox without a tunnel. Config
   validation refuses production without OAuth, a signing secret and the
   Postgres store.
3. **Persist, then acknowledge, then work.** A listener normalizes the event
   and enqueues it, and Bolt acknowledges it. A worker claims the event id once
   (`slack_event_claims`) and does the work. The production queue is Postgres
   (`slack_jobs`, `FOR UPDATE SKIP LOCKED`, exponential retry, dead after five
   attempts, a five-minute lease that is reclaimed).
4. **Postgres from the plane's CloudNativePG operator** holds the store and the
   queue: one infrastructure family the plane already runs (§15, 1).

## Rejected alternatives

- **ai-agents' own `/slack` routes** (services e5fcfb9f, removed in
  **52f89858**). ai-agents served `POST /slack/events` and kept bot tokens
  among the owner's secrets. That made Slack a second agent host inside the
  authority, with Slack-specific authorization paths and tokens in the wrong
  store. It was replaced by generic `/apps/hosts` contracts that any host uses
  (ADR 0002). Consequence: nothing Slack-specific remains in ai-agents.
- **Socket Mode in production.** One WebSocket per app means no horizontal
  ingress, no standard load balancing or health checks, and a single
  connection whose drop stalls every workspace. Slack recommends HTTP for
  distributed apps. It stays as a development transport.
- **Doing the work inside the listener.** A slow Datalayer turn would miss
  Slack's three-second window, and Slack would retry. Retries would then
  depend on idempotency alone, and a restart would lose the in-flight turn.
- **Python (Bolt for Python) beside the services.** Rejected because the
  portable clients and reducers that Slack reuses (Core, agent-runtimes) are
  TypeScript.
- **A new queue family (Redis, Pulsar, Kafka).** Postgres already holds the
  installations, and a job enqueued in the same database can share its
  transaction with the idempotency claim.

## Consequences

- The service needs a Postgres database and an encryption key before
  production (needs_user: N3, N4).
- Ingress replicas and workers can scale apart: the same image runs with the
  queue consumer on or off (A-17, the chart in `k8s/services`).
- `/healthz` reports liveness. `/readyz` checks only the database and the
  queue, never Slack or Datalayer, so a dependency outage does not flap the
  pods.
