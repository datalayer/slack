BEGIN;

-- The shared tables (slack_event_claims, slack_jobs, slack_usage,
-- slack_payload_access, slack_job_replays) are the host kit's:
-- applyHostSchema(db, "slack") from @datalayer/agent-runtimes/lib/portable/hosts
-- runs before these files (scripts/migrate.ts, DC-004).

CREATE TABLE IF NOT EXISTS slack_installations (
  app_id text NOT NULL,
  enterprise_id text NOT NULL DEFAULT '',
  team_id text NOT NULL,
  bot_token jsonb NOT NULL,
  bot_user_id text NOT NULL,
  datalayer_organization_id text,
  installed_by text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (status IN ('active', 'disconnected')),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (app_id, enterprise_id, team_id)
);

CREATE TABLE IF NOT EXISTS slack_oauth_installations (
  app_id text NOT NULL,
  enterprise_id text NOT NULL DEFAULT '',
  team_id text NOT NULL DEFAULT '',
  installation jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, enterprise_id, team_id)
);

CREATE TABLE IF NOT EXISTS slack_user_links (
  app_id text NOT NULL,
  enterprise_id text NOT NULL DEFAULT '',
  team_id text NOT NULL,
  slack_user_id text NOT NULL,
  datalayer_principal_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  linked_at timestamptz NOT NULL,
  PRIMARY KEY (app_id, enterprise_id, team_id, slack_user_id),
  FOREIGN KEY (app_id, enterprise_id, team_id)
    REFERENCES slack_installations (app_id, enterprise_id, team_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS slack_app_defaults (
  app_id text NOT NULL,
  enterprise_id text NOT NULL DEFAULT '',
  team_id text NOT NULL,
  application_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, enterprise_id, team_id),
  FOREIGN KEY (app_id, enterprise_id, team_id)
    REFERENCES slack_installations (app_id, enterprise_id, team_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS slack_thread_bindings (
  app_id text NOT NULL,
  enterprise_id text NOT NULL DEFAULT '',
  team_id text NOT NULL,
  channel_id text NOT NULL,
  thread_ts text NOT NULL,
  application_id text NOT NULL,
  opened_by_principal_id text NOT NULL,
  session_id text NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (app_id, enterprise_id, team_id, channel_id, thread_ts),
  FOREIGN KEY (app_id, enterprise_id, team_id)
    REFERENCES slack_installations (app_id, enterprise_id, team_id) ON DELETE CASCADE
);

COMMIT;
