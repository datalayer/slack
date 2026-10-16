# Inventory of the contracts @Datalayer uses

S-001 of `plans/SLACK.md` (landing `plans/SLACK.md`, §4.3, §11). Written on
16 October 2026, and checked against the services source on
`feat/earthdata-toolset` (ai-agents), agent-runtimes on `feat/app-avatar` and
this repo's `test/contracts/contracts.json`. Every route below appears in that
fixture under `routes` unless it says otherwise. Both sides test the fixture:
ai-agents in `tests/fixtures/hosts/` and this repo in `test/contracts/`.

**Where the routes answer.** On 16 October 2026,
`/api/ai-agents/v1/apps/hosts/*` answers 401 without a key on **r1**
(`https://r1.datalayer.run`) and **404 on prod1** (`https://prod1.datalayer.run`):
prod1's ai-agents image predates services 43a2bb58. Probe:

```sh
curl -s -o /dev/null -w '%{http_code}' https://r1.datalayer.run/api/ai-agents/v1/apps/hosts/whoami     # 401
curl -s -o /dev/null -w '%{http_code}' https://prod1.datalayer.run/api/ai-agents/v1/apps/hosts/whoami  # 404
```

The adapter's default `DATALAYER_API_URL` (`https://prod1.datalayer.run`)
therefore reaches no host route today. A deployment of this service points at
r1, or waits until prod1 runs ai-agents ≥ 0.0.70.

## 1. The host installation (ai-agents)

The owner is `k8s/services/ai-agents`. The routes are in
`datalayer_ai_agents/api/v1/endpoints/app_hosts.py`, the rules in
`datalayer_ai_agents/services/app_hosts.py` and the Solr records in
`datalayer_solr.app_hosts`. There is no `/slack` route: Slack is one `kind` of
host.

| Contract key   | Route                                                               | Caller                      | Answer                                                                                                            |
| -------------- | ------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| —              | `POST /apps/hosts`                                                  | the owner (their own token) | a pending installation with `deployments[]`, `default_deployment` and a one-use bind code                         |
| —              | `PATCH /apps/hosts/{uid}`                                           | the owner                   | changes `deployments`, `default_deployment` or `name`. A deployment that is removed has its sessions unbound      |
| —              | `DELETE /apps/hosts/{uid}`                                          | the owner                   | revokes (Disconnect)                                                                                              |
| `bind`         | `POST /apps/hosts/bind`                                             | the host, with the code     | `host` plus `host_key` (`dlhk_…`). The key is answered once and kept hashed                                       |
| `self`         | `GET /apps/hosts/self`                                              | host key                    | the installation and its allowed deployments, each with `uid`, `app_uid`, `app_name`, `state` and `kept`          |
| `uninstalled`  | `DELETE /apps/hosts/self`                                           | host key                    | revokes (Slack uninstall or `tokens_revoked`)                                                                     |
| `link_code`    | `POST /apps/hosts/self/link-codes`                                  | host key                    | `code` (`dlhc_…`), `expires_in`, `confirm`                                                                        |
| `link_state`   | `GET /apps/hosts/self/links/{external_user_id}`                     | host key                    | `linked`, `principal_uid?`                                                                                        |
| `unlink`       | `DELETE /apps/hosts/self/links/{external_user_id}`                  | host key                    | `revoked` (a count)                                                                                               |
| `preview_link` | `GET /apps/hosts/links/preview?code=`                               | the person                  | `host`, `external_user_id`, `external_user_name`, `expires_in`. **Gap:** it does not name the deployments (S-103) |
| `confirm_link` | `POST /apps/hosts/links`                                            | the person                  | `link`, `host`. Audited as `app.host.linked`                                                                      |
| —              | `GET /apps/hosts/links/mine`, `DELETE /apps/hosts/links/{link_uid}` | the person                  | their links, and unlinking one from Datalayer                                                                     |

The header is `X-Datalayer-Host-Key` (fixture `headers.host_key`).

**Gaps that the remaining boxes close:**

- the channel policy and pause on an installation (S-104, S-105, S-403);
- the deployments in the link preview (S-103);
- a one-use handoff to an exact session or approval (S-305).

All three were closed in services dccb4fa7 (ai-agents 0.0.71, live on r1 on
16 October 2026):

- `PATCH /apps/hosts/{uid}` takes `channels`, `direct_only` and `paused`;
- the exchange takes `place`;
- the preview names `deployments`;
- `POST /apps/hosts/handoffs` creates a handoff, and `…/handoffs/redeem`
  redeems it.

A drill on r1 showed one more gap. For an application that signs its users
(D-21), the exchange answers 502: IAM refuses the owner key of a kept runtime
when it reads the user secret ("This key of a kept runtime was minted to read
no secret").

## 2. The host credential exchange (ai-agents and common)

`POST /apps/hosts/self/token` (contract key `exchange`) is called with the host
key and `{deployment_uid, external_user_id}`. It answers `access_token` (a host
token), `token_type: Bearer`, `expires_in`, `exp`, `principal_uid`, `host_uid`,
`deployment {uid, app_uid, app_name, version}`, `session_api {url, agent}` and
`user_token?` (the D-21 signed user).

The token is minted and verified by
`common/datalayer_common/authn/app_host.py`:

- `aud` is `datalayer:app:host`, which the shared decoder refuses everywhere
  else;
- `sub` is the person;
- `azp` is the installation;
- it names one deployment and its link;
- it lives at most fifteen minutes (`max_ttl_seconds` in the fixture).

A runtime asks `GET /apps/hosts/whoami` (`whoami`) whether a token still stands.
A host token is also let into a deployment's `/opens`, `/principal-token` and
`/tool-approvals`.

This repo's caller is `HostKeyCredentials` in `src/agent-client.ts`.

## 3. The session API (agent-runtimes, on the kept runtime)

The owner is `ai/agent-runtimes`. The routes are in
`agent_runtimes/routes/apps.py`, under the URL the exchange answers
(`session_api.url`, …`/api/v1/apps/sessions`):

| Contract key    | Route                                       | Body                                                                               |
| --------------- | ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `start_session` | `POST {session_api.url}`                    | `agent`, `deployment_uid`, `opener`, `session`, `external_event_id`, `user_token?` |
| `send_message`  | `POST {session_api.url}/{session}/messages` | `text`, `external_event_id`                                                        |
| —               | `GET {session_api.url}/{session}/messages`  | the session's messages, which a replay reads its answer from                       |
| —               | `POST {session_api.url}/{session}/stop`     | stops the running turn. The session waits to be resumed                            |

Idempotency (`external_turn.replay`) works as follows:

- The `Idempotency-Key` header, or without one `external_event_id`, is sent with
  the same request. The original session and turn are answered with a
  `CUSTOM loop.turn` event, `replayed: true`, and nothing runs.
- The same key with another request is answered 409.

This repo sends the Slack `event_id` as both.

## 4. AG-UI events (agent-runtimes)

The stream is server-sent AG-UI events. The adapter reads:

- `TEXT_MESSAGE_CONTENT` (`delta`);
- `TOOL_CALL_START` (`toolCallId`, `toolCallName`) and `TOOL_CALL_END`;
- `RUN_FINISHED`, `RUN_ERROR` (`message`);
- `CUSTOM loop.turn` (`turn`, `external_event_id`, `replayed`, `state`);
- `CUSTOM loop.ask`.

The portable reducer of these events is `src/portable/conversation.ts` in
agent-runtimes, shared by the web chat and Datalayer Mobile. **Decision
(S-005, §4.2):** this adapter keeps its own reduction to the Slack semantic
events. The reasons are in §8. The versioned semantic contract is
`test/contracts/semantic-events.json`.

## 5. Approval presentation and decision (ai-agents)

`GET /tool-approvals/{id}/presentation` (`presentation`) is read with the
person's host token. It answers version 1:

- `fields` (display-safe, whole);
- `arguments` (complete, with secrets withheld);
- `secret_fields`;
- `action_class`, one of `read`, `send`, `write`, `execute`, `publish`,
  `delete`, `financial` or `unknown`;
- `complete`, `host_may_decide`, `reasons`;
- `digest` (sha256).

`POST /apps/hosts/approvals/{id}/decision` (`decision`) takes
`{approve, digest, note?}`. It decides only the person's own approval, and only
on the digest that was shown. The adapter's side is `slackMayDecide` in
`src/host-contracts.ts` and `src/approval-card.ts`.

## 6. Deliveries (ai-agents)

- `PUT /apps/hosts/sessions/{session_uid}` (`bind_session`, host key plus host
  token) maps a session to the host's `target`, which is handed back verbatim.
- `PUT /apps/hosts/self/delivery` (`webhook`) registers an HTTPS URL and answers
  `signing_secret` once.
- `GET …/self/deliveries` (`outbox`) and `POST …/self/deliveries/{uid}/ack`
  (`ack`) read the outbox.
- The events are `approval.requested`, `approval.decided` and `turn.completed`,
  with the payload keys of `delivery.payload_keys`.
- A push is signed `v1=` HMAC-SHA256 of `"<ts>.<raw body>"`
  (`X-Datalayer-Signature`, `X-Datalayer-Timestamp`, `X-Datalayer-Delivery`).

The adapter's side is in `src/deliveries.ts`: the route
`POST /datalayer/deliveries/{host}`, a five-minute window, and the poller.

## 7. Deployment authentication and conventions

- **Slack to this service:** the signing secret (HTTP), or the app-level token
  (Socket Mode, development only).
- **This service to ai-agents:** each workspace's host key, encrypted at rest
  (`SLACK_TOKEN_ENCRYPTION_KEY`, AES-256-GCM, versioned). A host token per
  person and turn. Never a Datalayer bearer token stored for a person.
- **ai-agents to this service:** a signed push, verified with the
  installation's own delivery secret.
- **Plane conventions:** services are Helm releases installed by
  `k8s/services/plane/datalayer_plane/sbin/up.sh`, where the image tag is the
  real pin. The cluster runs a CloudNativePG operator (`datalayer-postgresql`),
  which this service's Postgres store and queue target (§15, 1). OTEL goes to
  `datalayer-otel-otel-collector-svc.datalayer-otel:4317`. Secrets come from
  the rc files and are never created by an agent.

## 8. Reuse boundary (S-005)

The production graph is checked by `scripts/check-forbidden-imports.mjs`. It
walks the source imports and the installed transitive production graph
(`npm ls --omit=dev --all`). It reads what was installed, so it works with or
without a lockfile; the monorepo keeps none. It fails on `@jupyter/*`,
`@jupyterlab/*`, `@jupyter-widgets/*`, `@lumino/*`, `@datalayer/jupyter-*`,
`react-dom`, `react` and `@primer/*`. The lockfile walk (`productionGraph`) is
kept for fixtures.

**Decision, 16 October 2026: the Bolt adapter keeps its own AG-UI reduction.**
`@datalayer/agent-runtimes` 1.5.44 publishes no `exports` map, and its
production dependencies include `@jupyterlab/*`, `@lumino/*`, `react-dom`,
`@primer/react` and `@datalayer/jupyter-react`. Installing it, even for a deep
import of `lib/portable/conversation.js`, would bring all of them into this
service's production graph, and the gate refuses that. Extracting
`src/portable` into a dependency-free package is the §4.2 path. It is a new npm
package and release of agent-runtimes, with web, mobile and Slack moved onto
it. It is worth doing once a second server-side consumer exists.

Until then, the reduction here is small: AG-UI to the eleven semantic kinds,
not the web's conversation state. It is pinned by
`test/contracts/semantic-events.json`, which reduces the AG-UI event names that
agent-runtimes emits. If agent-runtimes renames an event, the fixture and this
reducer change in the same pull request.

## 9. Core's portable clients (tech/datalayer/core)

`@datalayer/core` 1.2.20 has no `exports` map. Its production dependencies
include `@jupyterlab/*`, `@lumino/*`, `@datalayer/jupyter-react` and
`@datalayer/jupyter-lexical`, so it fails the same gate as agent-runtimes.
The adapter therefore uses none of its clients. It speaks the HTTP contracts
above directly (`src/host-client.ts`, `src/agent-client.ts`) and validates
every answer with zod against `contracts.json`.

Reused only as conventions:

- Datalayer's URL layout: `/api/ai-agents/v1`, and the session API under the
  runtime;
- bearer authentication;
- the OTEL collector.

A server-safe export of Core's typed client and auth errors is the same
§4.2 extraction as agent-runtimes'. Nothing in the adapter waits on it.

## 10. Owners

| Area                                                               | Owner                                   |
| ------------------------------------------------------------------ | --------------------------------------- |
| Host installations, exchange, presentation, deliveries, revocation | ai-agents (`k8s/services`)              |
| Session API, AG-UI stream, idempotent turns, Stop                  | agent-runtimes                          |
| Identity, organizations, people                                    | IAM (`k8s/services`), read by ai-agents |
| Slack ingress, store, queue, rendering, App Home, OAuth            | this repo                               |
| `/docs/slack`, the Ship → Slack card, `/hosts/link`                | the landing (`landings/datalayer/ui`)   |
