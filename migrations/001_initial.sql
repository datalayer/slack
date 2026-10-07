BEGIN;

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

CREATE TABLE IF NOT EXISTS slack_event_claims (
  event_id text PRIMARY KEY,
  claimed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS slack_event_claims_claimed_at ON slack_event_claims (claimed_at);

CREATE TABLE IF NOT EXISTS slack_jobs (
  id bigserial PRIMARY KEY,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready', 'processing', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS slack_jobs_ready ON slack_jobs (state, available_at, id);

COMMIT;
