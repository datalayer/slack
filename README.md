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
- a portable Datalayer host client with streamed NDJSON agent updates;
- progressively updated threaded answers and private setup failures;
- least-privilege manifests for development, staging and production;
- production refusal when only the in-memory development store is configured;
- encrypted, durable Slack OAuth installations with workspace-specific token routing;
- uninstall cleanup that removes credentials and bindings and rejects late queued work;
- CI checks that prevent Jupyter, JupyterLab, Lumino, React DOM and Datalayer Jupyter imports.

Account-link callbacks, the host-token exchange, approval actions and Marketplace work still require the corresponding server/platform contracts. The service says this through configuration rather than using a workspace token as a human identity. Enterprise Grid organization-wide installation is intentionally refused until its ownership and routing model is implemented.

## Requirements

- Node.js 20.19 or newer (required for optional `.env` loading)
- npm 10 or newer
- A Slack development sandbox
- A Datalayer development account and deployed LOOP application
- PostgreSQL only for HTTP/OAuth or production setup

## What can be tested today

The quickest supported setup is one development workspace over Socket Mode. It exercises App Home, direct messages, channel mentions, queuing, thread binding and Slack response updates without a public URL or database.

A complete agent answer additionally requires the Datalayer host contract implemented by this adapter: `POST /api/v1/apps/sessions/turns` returning a same-origin NDJSON `stream_url`. The individual account-link and production host-token exchange endpoints are not implemented yet. Development therefore seeds one Slack-user-to-Datalayer-principal link from `.env` and uses `DATALAYER_DEV_HOST_TOKEN`. Do not use that shortcut outside `NODE_ENV=development`.

## First setup: Socket Mode

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
- `DATALAYER_DEFAULT_APP_ID`: the deployed LOOP application identifier;
- `DATALAYER_DEV_PRINCIPAL_ID`: the Datalayer principal represented by your Slack user;
- `DATALAYER_DEV_HOST_TOKEN`: a short-lived token accepted for that principal by the configured API.

You also need your Slack member ID for `DATALAYER_DEV_SLACK_USER_ID`. In Slack, open your profile, choose **More → Copy member ID**.

If the target Datalayer environment does not yet expose `/api/v1/apps/sessions/turns`, Slack setup can still be verified through App Home and receipt of events, but prompts cannot complete. This is currently the main server-side prerequisite.

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
DATALAYER_DEV_HOST_TOKEN=your-short-lived-development-token
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
npm run check
npm run dev:socket
```

Successful startup ends with a message similar to:

```text
@Datalayer Slack is listening on 3000 (socket).
```

Keep that terminal running.

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

Open `https://example.ngrok-free.app/slack/install` in a browser and approve the installation. [Bolt's built-in OAuth flow](https://docs.slack.dev/tools/bolt-js/concepts/authenticating-oauth/) verifies state and handles the callback; this service stores the complete installation encrypted in PostgreSQL. Reinstalling the same app/workspace updates that record. Uninstalling the Slack app deletes its OAuth credentials and tenant bindings; late queued jobs then fail closed.

OAuth currently binds the Slack workspace only. Datalayer organization selection and individual browser account linking are not available yet, so a fresh OAuth installation will not complete a Datalayer turn until those server contracts are implemented.

## Production checklist

Do not deploy the development shortcut. A production process must set:

- `NODE_ENV=production`, `DATALAYER_SLACK_TRANSPORT=http` and `DATALAYER_SLACK_STORE=postgres`;
- `DATABASE_URL` for a backed-up, TLS-protected PostgreSQL database;
- `SLACK_APP_ID`, `SLACK_SIGNING_SECRET`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_STATE_SECRET` and the exact `SLACK_REDIRECT_URI`;
- `SLACK_TOKEN_ENCRYPTION_KEY` from a secret manager and its explicit key version;
- production `DATALAYER_API_URL` and `DATALAYER_WEB_URL` values;
- the URLs from [`manifests/production.yaml`](manifests/production.yaml), reachable over HTTPS.

Run `npm run migrate` once per release before starting `npm run build && npm start`. Production configuration rejects memory storage and any `DATALAYER_DEV_HOST_TOKEN`. Do not expose production until account linking, the audience-bound host-token exchange, operational health endpoints and public policy/support flows are implemented.

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
| `DATALAYER_DEFAULT_APP_ID`                | Seeded development               | Deployed LOOP application selected for prompts               |
| `DATALAYER_DEV_*`                         | Socket Mode development only     | Temporary principal/link/token bootstrap                     |

## Troubleshooting

| Symptom                                   | Check                                                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SLACK_APP_TOKEN` configuration error     | Socket Mode needs an `xapp-` token with `connections:write`.                                                                                     |
| `not_authed` or `invalid_auth` from Slack | Recopy the correct bot/app token. If rotation was enabled, the static token may have expired; use OAuth or recreate the development app.         |
| App does not receive events               | Confirm Socket Mode is enabled for the socket path, or that Slack verifies the exact `/slack/events` HTTPS URL for HTTP.                         |
| App cannot post in a channel              | Invite `@Datalayer` to that channel; the manifest deliberately omits `chat:write.public`.                                                        |
| App Home says **Not connected**           | Verify `DATALAYER_DEV_SLACK_USER_ID` is your member ID and restart so the development seed runs.                                                 |
| App Home says no default application      | Set `DATALAYER_DEFAULT_APP_ID` and restart.                                                                                                      |
| `_Working…_` never becomes an answer      | Inspect the terminal. Confirm `/api/v1/apps/sessions/turns`, the host token, application ID and same-origin HTTPS stream contract are available. |
| HTTP requests are rejected                | Confirm the tunnel URL, `SLACK_SIGNING_SECRET`, system clock and Slack Request URLs.                                                             |
| OAuth callback fails                      | The Slack redirect URL and `SLACK_REDIRECT_URI` must match exactly, including path and HTTPS origin.                                             |
| PostgreSQL startup fails                  | Check `DATABASE_URL`, run `npm run migrate`, and verify the database is reachable.                                                               |

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
- Slack event ids are claimed before a turn, so a retry cannot start a second turn.
- The authoritative conversation, approval and audit record remains in Datalayer.

User and administrator documentation will be published at [datalayer.ai/docs/slack](https://datalayer.ai/docs/slack).
