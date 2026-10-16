BEGIN;

-- A person's own choice of how answers show their work (S-308): quiet (one
-- status line) or noisy (every tool the turn used, listed), chosen on
-- @Datalayer's Home, per installation and Slack member. The renderer reads it
-- before the service's default (DATALAYER_SLACK_EVENTS). Gone with the
-- installation.
CREATE TABLE IF NOT EXISTS slack_user_event_policies (
  app_id text NOT NULL,
  enterprise_id text NOT NULL DEFAULT '',
  team_id text NOT NULL,
  slack_user_id text NOT NULL,
  events text NOT NULL CHECK (events IN ('quiet', 'noisy')),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (app_id, enterprise_id, team_id, slack_user_id),
  FOREIGN KEY (app_id, enterprise_id, team_id)
    REFERENCES slack_installations (app_id, enterprise_id, team_id) ON DELETE CASCADE
);

COMMIT;
