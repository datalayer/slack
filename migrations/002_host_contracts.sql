BEGIN;

-- The Datalayer host installation a workspace is bound to at install, its key
-- and what its pushed deliveries are signed with: encrypted like the bot token.
ALTER TABLE slack_installations ADD COLUMN IF NOT EXISTS datalayer_host_uid text;
ALTER TABLE slack_installations ADD COLUMN IF NOT EXISTS datalayer_host_key jsonb;
ALTER TABLE slack_installations ADD COLUMN IF NOT EXISTS delivery_secret jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS slack_installations_host_uid
  ON slack_installations (datalayer_host_uid) WHERE datalayer_host_uid IS NOT NULL;

-- The thread's status message while its turn is not finished.
ALTER TABLE slack_thread_bindings ADD COLUMN IF NOT EXISTS pending_message_ts text;

-- Where an approval was shown: the card, and a channel thread's waiting line.
CREATE TABLE IF NOT EXISTS slack_approval_cards (
  app_id text NOT NULL,
  enterprise_id text NOT NULL DEFAULT '',
  team_id text NOT NULL,
  approval_id text NOT NULL,
  channel_id text NOT NULL,
  message_ts text NOT NULL,
  thread_ts text,
  kind text NOT NULL CHECK (kind IN ('card', 'waiting')),
  slack_user_id text NOT NULL,
  deployment_uid text NOT NULL,
  tool_name text NOT NULL,
  decided_by_slack_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, enterprise_id, team_id, approval_id, channel_id, message_ts),
  FOREIGN KEY (app_id, enterprise_id, team_id)
    REFERENCES slack_installations (app_id, enterprise_id, team_id) ON DELETE CASCADE
);

COMMIT;
