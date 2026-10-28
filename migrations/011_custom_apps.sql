BEGIN;

-- A Slack app the person brings (decided 28 October 2026): their own app,
-- installed to their workspace from an application's Ship tab with its bot
-- token pasted, beside Datalayer's own app. Its installation is a row of
-- slack_installations like any workspace's (its bot token encrypted there,
-- its key from Datalayer, its allowances); what is kept here is what only a
-- custom app has: its signing secret (SecretCipher, bound to
-- `custom-app:<app_id>`), with which the service verifies the requests Slack
-- posts to /slack/apps/<app_id>/events, and its bot id. Idempotent;
-- re-applied every time after 001 to 010.
CREATE TABLE IF NOT EXISTS slack_custom_apps (
  app_id text PRIMARY KEY,
  team_id text NOT NULL,
  bot_id text NOT NULL,
  signing_secret jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
