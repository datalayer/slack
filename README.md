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
- CI checks that prevent Jupyter, JupyterLab, Lumino, React DOM and Datalayer Jupyter imports.

Account-link callbacks, the host-token exchange, approval actions and Marketplace work still require the corresponding server/platform contracts. The service says this through configuration rather than using a workspace token as a human identity. Enterprise Grid organization-wide installation is intentionally refused until its ownership and routing model is implemented.

## Requirements

- Node.js 20 or newer
- A Slack development sandbox
- A Slack app created from `manifests/development.yaml`
- A Datalayer development account and deployed LOOP application

Install dependencies:

```bash
npm install
```

## Local development

Copy `.env.example` to `.env` in a secret manager or load the variables through your shell. Do not commit the values.

For Socket Mode, set at least:

```text
DATALAYER_SLACK_TRANSPORT=socket
SLACK_APP_TOKEN=xapp-…
SLACK_BOT_TOKEN=xoxb-…
SLACK_APP_ID=A…
SLACK_BOT_USER_ID=U…
SLACK_TEAM_ID=T…
DATALAYER_DEFAULT_APP_ID=<deployed application id>
DATALAYER_DEV_SLACK_USER_ID=U…
DATALAYER_DEV_PRINCIPAL_ID=<your Datalayer principal id>
DATALAYER_DEV_HOST_TOKEN=<short-lived development token>
```

Then run:

```bash
npm run dev:socket
```

The development token is accepted only in `NODE_ENV=development`; production configuration rejects it. Production will use the audience-bound Slack host-token exchange described in the plan.

HTTP development uses `npm run dev:http`, a signing secret and an HTTPS tunnel whose `/slack/events` URL is configured in the development app.

## OAuth installation

HTTP deployments expose Bolt's install and callback routes at:

- `GET /slack/install`
- `GET /slack/oauth/callback`

Configure the Slack app's OAuth redirect URL to the exact public value of `SLACK_REDIRECT_URI`, then set:

```text
SLACK_APP_ID=A…
SLACK_CLIENT_ID=…
SLACK_CLIENT_SECRET=…
SLACK_STATE_SECRET=<at least 32 random characters>
SLACK_REDIRECT_URI=https://slack.example.datalayer.run/slack/oauth/callback
```

Production requires all five values. Bolt verifies OAuth state, exchanges the temporary code, and calls the PostgreSQL installation adapter. The adapter encrypts the complete installation and mirrors the active bot identity into the domain store. Reinstallation and Slack token rotation use the same upsert path. Every outbound Slack call selects the bot token by app, enterprise and team; there is no process-global production bot token.

The install callback currently records Slack ownership only. Binding an installation to a Datalayer organization remains blocked on the authoritative Datalayer organization-selection and host-token APIs described in the delivery plan.

## Durable storage

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
