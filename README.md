[![Datalayer](https://images.datalayer.io/legacy/datalayer-25.svg)](https://datalayer.ai)

[![Become a Sponsor](https://img.shields.io/static/v1?label=Become%20a%20Sponsor&message=%E2%9D%A4&logo=GitHub&style=flat&color=1ABC9C)](https://github.com/sponsors/datalayer)

# ☰ 💬 @Datalayer for Slack

`@Datalayer` brings an existing Datalayer LOOP application or running agent into a Slack direct message or channel thread. Slack is a host of the existing session and approval contracts; it is not a separate agent runtime.

The implementation follows the delivery plan in `landings/datalayer/ui/plans/SLACK.md`.

## Current implementation

The repository currently provides the executable Phase 0/early Phase 2 foundation:

- Bolt for JavaScript 5 on Node.js 20+ and strict TypeScript;
- Socket Mode for local development and signed HTTP mode for deployed environments;
- `app_mention` and `message.im` normalization into one thread prompt;
- per-installation user links, default applications, thread/session bindings and event idempotency;
- a fast queue boundary between Slack acknowledgement and agent work;
- a portable Datalayer host client on the generic host contracts ai-agents and the runtime's session API answer every host (no Slack-specific endpoint): the host credential exchange, idempotent turns named by the Slack event id, the AG-UI stream reduced to Slack updates, the thread mapped to its session for deliveries, signed delivery verification and the approval presentation (`src/host-contracts.ts`, shared fixture `test/contracts/contracts.json`);
- progressively updated threaded answers and private setup failures;
- least-privilege manifests for development, staging and production;
- production refusal when only the in-memory development store is configured;
- encrypted, durable Slack OAuth installations with workspace-specific token routing;
- **bind at install**: the Ship card's one-use `datalayer_bind` code rides in a signed, one-use OAuth `state`; the callback binds the workspace at `POST /api/ai-agents/v1/apps/hosts/bind` and keeps the answered host key encrypted beside the bot token; every Datalayer call of that workspace uses its own key (`src/oauth-state.ts`, `src/host-installations.ts`);
- **account linking**: App Home's _Connect your Datalayer account_ asks a one-use link code (`POST …/self/link-codes`) and opens Datalayer's confirm page (`/hosts/link?code=…`), where the person, signed in, confirms; whether someone is linked is always Datalayer's answer (`GET …/self/links/{user}`);
- **deliveries**: a signed webhook (`POST /datalayer/deliveries/{host}`, registered with `PUT …/self/delivery`, verified with the installation's own secret over `<timestamp>.<body>` within five minutes) and an outbox poller (`GET …/self/deliveries` + ack) feed the queue; each delivery is handled once (`src/deliveries.ts`);
- **approval cards**: `approval.requested` becomes a Block Kit card built from `GET /tool-approvals/{id}/presentation`, every value whole (a long value continues in the next block, never cut); _Approve_ and _Decline_ only when the server says a host may decide and it fits Slack, each opening a confirmation modal; the decision is `POST /apps/hosts/approvals/{id}/decision` with the digest shown, as the person who pressed; otherwise only _Review in Datalayer_. A channel session's card goes privately to its person, the thread showing only _Waiting for …'s decision_; `approval.decided` updates every card, without buttons; `turn.completed` finishes a thread's status that its stream left waiting (`src/approval-card.ts`);
- uninstall cleanup: `app_uninstalled` and `tokens_revoked` end the installation at Datalayer (`DELETE /api/ai-agents/v1/apps/hosts/self`), then remove its key, credentials, bindings and cards; late queued work and deliveries are dropped;
- CI checks that prevent Jupyter, JupyterLab, Lumino, React DOM and Datalayer Jupyter imports.

Added on 16 October 2026 (plans/SLACK.md round 1):

- **ingress**: each signed event is normalized without a network call (`src/ingress.ts`) and persisted once by its event id, with the job, in one transaction. It is acknowledged only after that (`processBeforeResponse`). Bolt checks the signature over the raw body. A timestamp more than five minutes away, in the past or the future, is refused in front of Bolt (`src/health.ts`). Bot, self, unsupported-subtype and channel (non-mention) messages are ignored.
- **the turn worker** (`src/service.ts`, `src/routing.ts`, `src/worker.ts`):
  - It resolves installation → shared channel (refused) → linked person → application. The application is the thread's own, else an explicit choice, else the channel's binding, else the workspace default. It must be allowed here and in this kind of conversation. Every refusal is private (ephemeral in a channel) and starts no run.
  - One turn runs at a time per thread. A second prompt is refused privately while one runs.
  - _Stop_ names the run it stops.
  - After a crash, a redelivery resumes the same message, and Datalayer replays the turn rather than running it again.
  - _Use another application_ and _Start over_ archive the thread's binding and open a new session. Only the person who opened it can use them.
  - An edited direct message offers _Send edited text as a new turn_. A deleted one is told that the record stays.
- **rendering** (`src/semantic.ts`, `src/ag-ui.ts`, `src/presentation.ts`, `src/render.ts`, `src/rate-limit.ts`):
  - The AG-UI stream is reduced to versioned semantic events (`test/contracts/semantic-events.json`).
  - Answers stream with `chat.startStream` when the port offers it. Otherwise one placeholder is updated at most every 1.5 s.
  - Calls are spaced per method and channel, and Slack's `Retry-After` is honored on a 429.
  - Tables are shown as blocks, previewed when large. Citations are safe HTTPS links.
  - A plain-text fallback is always present, and Slack's block limits are kept.
- **records** (migration `003`): allowances, channel bindings, deliveries, the turn lock, held prompts, archived bindings, and the next application.
- **operations**:
  - `/healthz` and `/readyz` (the store and the queue only);
  - redacted JSON logs with pseudonymous ids, and identity audit events (`src/observability.ts`);
  - a production-graph import gate (`scripts/forbidden-graph.mjs`);
  - a `Dockerfile` (node 20 slim, non-root, `npm ci --omit=dev`) and `scripts/migrate.mjs`;
  - CI (`.github/workflows/ci.yml`).
- **documents**: `docs/inventory.md` (S-001), `docs/adr/` (S-002) and `docs/threat-model.md` (S-003, draft).

Still missing:

- the service deployed at a public HTTPS address, and that address in the Ship card (`SLACK_APP_URL`);
- the staging and production Slack apps registered from the manifests;
- an OTEL exporter (spans are written as redacted log lines until then);
- Marketplace work.

The service says this through configuration rather than using a workspace token as a human identity. Enterprise Grid organization-wide installation is refused on purpose until its ownership and routing model is implemented.

## Why each scope exists

The manifests request exactly three bot scopes and no user scope. `test/operations.test.ts` fails if a manifest asks for more.

| Scope               | Why @Datalayer needs it                                                                                                                         | What it does not allow                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `app_mentions:read` | Receive `@Datalayer …` in a channel the app was invited to (`app_mention`).                                                                     | Reading any other message in the channel.                                         |
| `chat:write`        | Answer in the thread, update and stream the answer (`chat.update`, `chat.startStream`), and send private setup messages (`chat.postEphemeral`). | Posting in a channel the app was not invited to: there is no `chat:write.public`. |
| `im:history`        | Receive the messages people send in @Datalayer's Messages tab (`message.im`).                                                                   | Reading other people's direct messages.                                           |

Absent until a shipped feature needs them, each behind its own reauthorization:

- `channels:history` and `groups:history`: optional thread context, S-401 and S-402;
- `files:write`: files uploaded to Slack;
- `users:read`;
- `commands`.

Because channel history is not read, an edit to a channel message is never delivered. Only edits in direct messages are handled.

## Requirements

- Node.js 20.19 or newer (required for optional `.env` loading)
- npm 10 or newer
- A Slack development sandbox
- A Datalayer development account and deployed LOOP application
- PostgreSQL only for HTTP/OAuth or production setup

## What can be tested today

The quickest supported setup is one development workspace over Socket Mode. It exercises App Home, direct messages, channel mentions, queuing, thread binding and Slack response updates without a public URL or database.

A complete agent answer runs on the deployment's session API (`POST {session_api.url}`, AG-UI over server-sent events) on its kept runtime: the deployment must be kept always on. A workspace installed through OAuth from the Ship card holds its own host key, bound at install; every turn then goes through the host credential exchange (`POST /api/ai-agents/v1/apps/hosts/self/token`) for the linked Slack user. In development, `DATALAYER_HOST_KEY` stands in for a workspace without its own. Without one, development seeds one Slack-user-to-Datalayer-principal link from `.env` and uses `DATALAYER_DEV_HOST_TOKEN` — the developer's own key, on their own deployment. Do not use that shortcut outside `NODE_ENV=development`.

## Workspace and distribution model

There are two distinct setup paths:

| Path                | Who configures Slack                                                                             | Installation method                                | Intended use                                          |
| ------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------- | ----------------------------------------------------- |
| Datalayer workspace | A Datalayer developer                                                                            | Development manifest, Socket Mode and local tokens | Development and internal testing                      |
| Customer workspace  | Datalayer configures the app once; a customer workspace administrator only approves installation | Public Datalayer OAuth install URL                 | External customer use, unlisted pilot and Marketplace |

### Datalayer's own workspace

The instructions in the next section are for Datalayer developers. The `Datalayer Dev` app belongs to Datalayer's development workspace. A developer creates it from [`manifests/development.yaml`](manifests/development.yaml), obtains its `xapp-` and `xoxb-` credentials, and runs the adapter locally over Socket Mode. These credentials are internal secrets and must never be given to customers.

### Third-party customer workspaces

The product goal is that any eligible Slack customer can register with Datalayer, install `@Datalayer` in a workspace they administer, connect their Datalayer organization and account, select an allowed LOOP application, and talk to it by direct message or `@Datalayer` mention.

A customer does **not** create a separate Slack app, paste a manifest, generate an app token or send Datalayer an `xoxb-` token. Datalayer owns one staging/production Slack application and publishes an **Install @Datalayer** link backed by `GET /slack/install`. Slack's OAuth consent flow issues a workspace-specific installation to Datalayer; the service encrypts it and selects it by app, enterprise and team for every Slack API call.

The intended customer journey is:

1. Sign in or register at Datalayer and select a Datalayer organization.
2. Choose **Install @Datalayer in Slack**.
3. Select a Slack workspace and approve the three baseline bot scopes.
4. Return to Datalayer, bind the Slack workspace to the selected organization and choose allowed/default LOOP applications.
5. Open App Home and connect the individual Slack member to their Datalayer identity through a one-use browser handoff.
6. Invite `@Datalayer` to a channel and mention it, or send it a direct message.

The encrypted multi-workspace OAuth store, reinstall handling, tenant-specific token routing and uninstall cleanup are implemented. Public customer registration is **not available yet**: the authoritative Datalayer host contracts (installation binding, account links, the audience-bound host-token exchange, deliveries, approval presentation, revocation) are built in ai-agents but not deployed, and neither is this adapter; it keeps a host key per workspace, asks link codes from App Home, receives deliveries and renders approval cards, but has not run against a real workspace. Public distribution operations are also missing. Until those are implemented and tested, use only the Datalayer development workspace flow below; do not onboard third-party customers manually with shared tokens.

## Datalayer workspace setup: Socket Mode

Follow these steps in order. They create a development-only Slack app and keep all work in memory.

### 1. Install the repository

```bash
cd /home/echarles/datalayer-osp/src/tech/datalayer/slack
npm ci
cp .env.example .env
chmod 600 .env
```

The development commands load `.env` automatically. The file is ignored by Git.

### 2. Create the Slack app from the manifest

1. Open [Slack API apps](https://api.slack.com/apps), choose **Create New App**, then **From an app manifest**.
2. Select the development workspace.
3. Choose YAML and paste [`manifests/development.yaml`](manifests/development.yaml).
4. Review and create the app.
5. Under **Install App**, choose **Install to Workspace**, approve the scopes, and copy the **Bot User OAuth Token** beginning with `xoxb-`.

The development manifest intentionally disables token rotation for this single-workspace static-token workflow. [Slack does not allow rotation to be turned off after it is enabled](https://docs.slack.dev/authentication/using-token-rotation/). If an existing development app already has rotation enabled, either use the HTTP/OAuth setup below or create a fresh development app from the current manifest. Staging and production keep rotation enabled.

### 3. Create the Socket Mode token

1. In the app's **Settings → Socket Mode**, enable Socket Mode.
2. In **Settings → Basic Information → App-Level Tokens**, choose **Generate Token and Scopes**.
3. Name it `datalayer-local`, add the app-level `connections:write` scope, generate it, and copy the `xapp-` value.

The [`connections:write` scope](https://docs.slack.dev/reference/scopes/connections.write/) belongs to the app-level token; it is not a bot scope.

### 4. Collect the Slack identifiers

- `SLACK_APP_ID`: **Settings → Basic Information → App Credentials → App ID**.
- `SLACK_TEAM_ID`: the workspace ID returned by Slack's `auth.test` method.
- `SLACK_BOT_USER_ID`: the `user_id` returned by the same call.

Put the bot token into `.env` temporarily, load it, and ask Slack for the two identifiers:

```bash
set -a
. ./.env
set +a
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" \
  https://slack.com/api/auth.test
```

The response must contain `"ok":true`. Copy `team_id` to `SLACK_TEAM_ID` and `user_id` to `SLACK_BOT_USER_ID`. Do not paste the response into an issue or commit it.

### 5. Collect the Datalayer development values

You need four values from the Datalayer environment that will receive the turn:

- `DATALAYER_API_URL`: origin exposing the Slack host turn contract, without a trailing API path;
- `DATALAYER_DEFAULT_APP_ID`: the uid of your deployment of the LOOP application, kept always on (Studio → Ship);
- `DATALAYER_DEV_PRINCIPAL_ID`: the Datalayer principal represented by your Slack user;
- `DATALAYER_API_KEY`: the existing development API key exported in your shell. The Makefile maps it to the adapter's development host-token variable only for the child process.

You also need your Slack member ID for `DATALAYER_DEV_SLACK_USER_ID`. In Slack, open your profile, choose **More → Copy member ID**.

Use the Datalayer CLI to sign in and display your principal UID:

```bash
datalayer login
datalayer whoami --details
```

Copy the displayed `UID` into `DATALAYER_DEV_PRINCIPAL_ID`. Confirm that the CLI's existing API key is exported in your shell:

```bash
test -n "${DATALAYER_API_KEY}" && echo "Datalayer API key is available"
```

The local Makefile passes `DATALAYER_API_KEY` to the adapter as `DATALAYER_DEV_HOST_TOKEN` only in the `dev-socket` process. It does not copy the credential into `.env`, logs or command output. This existing API key is a development bootstrap only; third-party customers must use the audience-bound account-link and host-token exchange described above.

If the deployment is not kept always on, or the target Datalayer environment does not yet run the session API with `external_event_id`, Slack setup can still be verified through App Home and receipt of events, but prompts cannot complete.

### 6. Fill `.env`

Set these values and leave the PostgreSQL and OAuth values blank:

```dotenv
NODE_ENV=development
PORT=3000
DATALAYER_SLACK_TRANSPORT=socket
DATALAYER_SLACK_STORE=memory

DATALAYER_API_URL=https://your-datalayer-api.example
DATALAYER_WEB_URL=https://datalayer.ai
DATALAYER_DEFAULT_APP_ID=your-deployed-application-id
DATALAYER_DEV_PRINCIPAL_ID=your-datalayer-principal-id
DATALAYER_DEV_SLACK_USER_ID=U0123456789

SLACK_APP_ID=A0123456789
SLACK_APP_TOKEN=xapp-...
SLACK_BOT_TOKEN=xoxb-...
SLACK_BOT_USER_ID=U0123456789
SLACK_TEAM_ID=T0123456789
```

Never commit `.env`, Slack tokens, Datalayer tokens, database passwords or encryption keys.

### 7. Validate and start

```bash
make check
make dev-socket
```

Successful startup ends with a message similar to:

```text
@Datalayer Slack is listening on 3000 (socket).
```

Keep that terminal running.

`make dev-socket` fails before starting when `DATALAYER_API_KEY` is unavailable. To bypass the Makefile intentionally, provide the adapter-specific value for one command:

```bash
DATALAYER_DEV_HOST_TOKEN="${DATALAYER_API_KEY}" npm run dev:socket
```

### 8. Exercise the app

1. Open the app in Slack and select its **Home** tab. It should show **Account: Connected** and the configured default application.
2. Send a direct message such as `Summarize the launch risks`.
3. Invite the app to a test channel, then send `@Datalayer summarize the launch risks`.
4. Confirm the reply is in the mention's thread, not a new top-level message.

If the Datalayer host contract is available, the `_Working…_` placeholder is progressively replaced by the answer. If it is unavailable, see the terminal error and the troubleshooting table below; do not interpret the placeholder as a successful run.

## HTTP and OAuth development

Use this path to test public HTTPS ingress, multi-workspace installation, encrypted credentials, token rotation and uninstall cleanup. It requires a public HTTPS tunnel and PostgreSQL.

### 1. Start PostgreSQL

Use an existing development PostgreSQL instance, or start an isolated local container:

```bash
docker run --name datalayer-slack-postgres \
  -e POSTGRES_PASSWORD=datalayer-slack-local \
  -e POSTGRES_DB=datalayer_slack \
  -p 127.0.0.1:5432:5432 \
  -d postgres:16
```

This example password is only for a database bound to your development machine. Use a secret manager and TLS for any shared environment.

### 2. Expose port 3000 over HTTPS

For example, with ngrok:

```bash
ngrok http 3000
```

Copy the generated HTTPS origin, such as `https://example.ngrok-free.app`. Tunnel hostnames often change when restarted; update Slack and `.env` whenever yours changes.

### 3. Configure Slack URLs

In the development app settings, set these exact URLs using the tunnel origin:

- **OAuth & Permissions → Redirect URLs:** `https://example.ngrok-free.app/slack/oauth/callback`
- **Event Subscriptions → Request URL:** `https://example.ngrok-free.app/slack/events`
- **Interactivity & Shortcuts → Request URL:** `https://example.ngrok-free.app/slack/events`

Disable Socket Mode for this HTTP test. Copy the App ID, Client ID, Client Secret and Signing Secret from **Basic Information → App Credentials**.

### 4. Configure durable OAuth

Generate two different secrets:

```bash
openssl rand -base64 32
openssl rand -hex 32
```

Use the first as `SLACK_TOKEN_ENCRYPTION_KEY` and the second as `SLACK_STATE_SECRET`. Configure `.env`:

```dotenv
NODE_ENV=development
PORT=3000
DATALAYER_SLACK_TRANSPORT=http
DATALAYER_SLACK_STORE=postgres
DATABASE_URL=postgresql://postgres:datalayer-slack-local@127.0.0.1:5432/datalayer_slack

SLACK_APP_ID=A0123456789
SLACK_SIGNING_SECRET=...
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
SLACK_STATE_SECRET=at-least-32-random-characters
SLACK_REDIRECT_URI=https://example.ngrok-free.app/slack/oauth/callback
SLACK_TOKEN_ENCRYPTION_KEY=base64-encoded-32-byte-key
SLACK_TOKEN_ENCRYPTION_KEY_VERSION=1

DATALAYER_API_URL=https://your-datalayer-api.example
DATALAYER_WEB_URL=https://datalayer.ai
```

The static `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_TEAM_ID` and `SLACK_BOT_USER_ID` values are not used by the HTTP OAuth path.

### 5. Migrate, run and install

```bash
npm run migrate
npm run dev:http
```

Install from Datalayer: on the application's Ship tab, the Slack card's _Install @Datalayer_ sets up a host installation at ai-agents and opens `https://example.ngrok-free.app/slack/install?datalayer_bind=dlhc_…` (for a local landing, set its `SLACK_APP_URL` to your tunnel origin). This service puts the code in a signed, one-use OAuth `state` and sends you to Slack; at the callback it binds the workspace (`POST /api/ai-agents/v1/apps/hosts/bind`), stores the installation, the host key and, when the delivery address registers, its signing secret, all encrypted in PostgreSQL, and makes the installation's default deployment the workspace's default. An expired or spent code stores nothing: the page says to install again from the Ship tab. Reinstalling without a code (a scope change) keeps the key the workspace had.

In development, `/slack/install` without a code still runs Bolt's plain install (unbound: App Home says the workspace is not connected). Outside development it is refused with a page pointing to the Ship tab.

Then open @Datalayer's **Home** in Slack and choose _Connect your Datalayer account_: Datalayer's `/hosts/link` page shows the workspace and your Slack member and links them to you on _Link_. The link works once, for ten minutes.

Uninstalling the Slack app (or revoking its bot token) tells Datalayer (`DELETE …/hosts/self`), then deletes its OAuth credentials, host key and tenant bindings; late queued jobs and deliveries then fail closed.

Datalayer pushes approvals and finished turns to `<origin>/datalayer/deliveries/<host uid>` (origin: `DATALAYER_SLACK_PUBLIC_URL`, else that of `SLACK_REDIRECT_URI`); the outbox is also read every `DATALAYER_DELIVERY_POLL_SECONDS` (30), so a missed push still arrives.

## Production checklist

Do not deploy the development shortcut. A production process must set:

- `NODE_ENV=production`, `DATALAYER_SLACK_TRANSPORT=http` and `DATALAYER_SLACK_STORE=postgres`;
- `DATABASE_URL` for a backed-up, TLS-protected PostgreSQL database;
- `SLACK_APP_ID`, `SLACK_SIGNING_SECRET`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_STATE_SECRET` and the exact `SLACK_REDIRECT_URI`;
- `SLACK_TOKEN_ENCRYPTION_KEY` from a secret manager and its explicit key version;
- production `DATALAYER_API_URL` and `DATALAYER_WEB_URL` values;
- the URLs from [`manifests/production.yaml`](manifests/production.yaml), reachable over HTTPS.

Run `npm run migrate` once per release before starting `npm run build && npm start` (it applies every file of `migrations/` in order; each is idempotent). Production configuration rejects memory storage, any `DATALAYER_DEV_HOST_TOKEN` and any shared `DATALAYER_HOST_KEY`: each installation keeps its own key, bound at install. Do not expose production until ai-agents' host contracts are deployed and the operational health endpoints and public policy/support flows are implemented.

## Configuration reference

| Variable                                  | Required when                    | Purpose                                                      |
| ----------------------------------------- | -------------------------------- | ------------------------------------------------------------ |
| `PORT`                                    | Always; defaults to `3000`       | Bolt HTTP listener or local Socket Mode process port         |
| `DATALAYER_SLACK_TRANSPORT`               | Always                           | `socket` locally or `http` for public ingress                |
| `DATALAYER_SLACK_STORE`                   | Always                           | `memory` for local work or `postgres` for durable/OAuth work |
| `DATABASE_URL`                            | PostgreSQL store                 | PostgreSQL connection string                                 |
| `SLACK_TOKEN_ENCRYPTION_KEY`              | PostgreSQL store                 | Base64-encoded 32-byte AES key                               |
| `SLACK_TOKEN_ENCRYPTION_KEY_VERSION`      | PostgreSQL store                 | Positive key version; defaults to `1`                        |
| `SLACK_APP_TOKEN`                         | Socket Mode                      | App-level `xapp-` token with `connections:write`             |
| `SLACK_BOT_TOKEN`                         | Static development install       | Workspace bot `xoxb-` token                                  |
| `SLACK_APP_ID`                            | Seeded development or PostgreSQL | Slack application ID                                         |
| `SLACK_TEAM_ID` / `SLACK_BOT_USER_ID`     | Seeded Socket Mode development   | Workspace and installed bot user identifiers                 |
| `SLACK_SIGNING_SECRET`                    | HTTP                             | Verifies signed Slack requests                               |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | OAuth; required in production    | Slack OAuth application credentials                          |
| `SLACK_STATE_SECRET`                      | OAuth; required in production    | At least 32 characters for OAuth state signing               |
| `SLACK_REDIRECT_URI`                      | OAuth; required in production    | Exact public OAuth callback URL                              |
| `DATALAYER_API_URL`                       | Always                           | Datalayer host-contract origin                               |
| `DATALAYER_WEB_URL`                       | Always                           | Base URL used for docs and session links                     |
| `DATALAYER_DEFAULT_APP_ID`                | Seeded development               | Deployment uid selected for prompts                          |
| `DATALAYER_HOST_KEY`                      | Development only                 | One host key for workspaces installed without OAuth          |
| `DATALAYER_SLACK_PUBLIC_URL`              | Optional                         | Public HTTPS origin Datalayer pushes deliveries to           |
| `DATALAYER_DELIVERY_POLL_SECONDS`         | Optional; defaults to `30`       | How often the outbox is read; `0` never                      |
| `DATALAYER_DEV_*`                         | Socket Mode development only     | Temporary principal/link/token bootstrap                     |

## Troubleshooting

| Symptom                                   | Check                                                                                                                                                                                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SLACK_APP_TOKEN` configuration error     | Socket Mode needs an `xapp-` token with `connections:write`.                                                                                                                                                                                              |
| `not_authed` or `invalid_auth` from Slack | Recopy the correct bot/app token. If rotation was enabled, the static token may have expired; use OAuth or recreate the development app.                                                                                                                  |
| App does not receive events               | Confirm Socket Mode is enabled for the socket path, or that Slack verifies the exact `/slack/events` HTTPS URL for HTTP.                                                                                                                                  |
| App cannot post in a channel              | Invite `@Datalayer` to that channel; the manifest deliberately omits `chat:write.public`.                                                                                                                                                                 |
| App Home says **Not connected**           | Choose _Connect your Datalayer account_ and confirm on Datalayer's page. Without that button the workspace was installed without the Ship card's code: install again from the Ship tab. In Socket Mode development, verify `DATALAYER_DEV_SLACK_USER_ID`. |
| The install page refuses                  | Start from the application's Ship tab: its code is good for ten minutes and works once.                                                                                                                                                                   |
| No approval card arrives                  | The deployment must be kept always on; check that `<origin>/datalayer/deliveries/<host>` is reachable over HTTPS, or wait for the outbox poll.                                                                                                            |
| App Home says no default application      | Set `DATALAYER_DEFAULT_APP_ID` and restart.                                                                                                                                                                                                               |
| `_Working…_` never becomes an answer      | Inspect the terminal. Confirm the host key or development token, the deployment uid, that it is kept always on and that its runtime is on the `DATALAYER_API_URL` origin.                                                                                 |
| HTTP requests are rejected                | Confirm the tunnel URL, `SLACK_SIGNING_SECRET`, system clock and Slack Request URLs.                                                                                                                                                                      |
| OAuth callback fails                      | The Slack redirect URL and `SLACK_REDIRECT_URI` must match exactly, including path and HTTPS origin.                                                                                                                                                      |
| PostgreSQL startup fails                  | Check `DATABASE_URL`, run `npm run migrate`, and verify the database is reachable.                                                                                                                                                                        |

## Durable storage internals

Production uses PostgreSQL for installations, linked identities, application defaults, thread/session bindings, event claims and durable worker jobs. Configure:

```text
DATALAYER_SLACK_STORE=postgres
DATABASE_URL=postgresql://...
SLACK_APP_ID=A…
SLACK_TOKEN_ENCRYPTION_KEY=<base64-encoded 32-byte key>
SLACK_TOKEN_ENCRYPTION_KEY_VERSION=1
```

Create a key with `openssl rand -base64 32` and keep it in the platform secret manager. The key version is stored with every ciphertext so rotation can be introduced without ambiguous decryptions. Slack tokens are encrypted with AES-256-GCM and bound to their installation key as authenticated data.

Apply the idempotent schema migration before starting a release:

```bash
npm run migrate
```

The PostgreSQL queue uses `FOR UPDATE SKIP LOCKED`, so multiple workers may process different Slack jobs safely. Failed jobs retry with bounded exponential backoff, become dead after five attempts, and jobs abandoned by a worker are reclaimed after five minutes.

## Checks

```bash
npm run check
```

This runs formatting, lint, type checking, forbidden-import and manifest checks, unit tests, and the production TypeScript build.

Render the three manifests after changing the template:

```bash
npm run manifest:render
```

## Security boundary

- Slack request verification is delegated to Bolt's signed HTTP receiver in HTTP mode.
- A Slack bot or installation token never represents the human asking the question.
- The linked Datalayer principal is carried by an audience-bound host token.
- The baseline app receives only direct mentions and direct messages; it does not request channel-history scopes.
- Slack event ids are claimed before a turn, so a retry cannot start a second turn; an OAuth state and a delivery are each claimed once too.
- Each workspace's host key is answered once at install and kept encrypted beside its bot token, never logged; deliveries are verified with that installation's own secret.
- An approval is decided only by the person who pressed, exchanged for their own host token: Datalayer decides only its owner's, and only the digest the card showed.
- The authoritative conversation, approval and audit record remains in Datalayer.

User and administrator documentation will be published at [datalayer.ai/docs/slack](https://datalayer.ai/docs/slack).
