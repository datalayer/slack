BEGIN;

-- The Slack-side records besides installations, links and
-- thread bindings. Datalayer stays the authority: an allowance is what
-- `GET /apps/hosts/self` answered, kept to show and choose from.

CREATE TABLE IF NOT EXISTS slack_app_allowances (
  app_id text NOT NULL,
  enterprise_id text NOT NULL DEFAULT '',
  team_id text NOT NULL,
  application_id text NOT NULL,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  channel_policy text NOT NULL DEFAULT 'channels' CHECK (channel_policy IN ('channels', 'direct-only')),
  configured_by text NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (app_id, enterprise_id, team_id, application_id),
  FOREIGN KEY (app_id, enterprise_id, team_id)
    REFERENCES slack_installations (app_id, enterprise_id, team_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS slack_channel_bindings (
  app_id text NOT NULL,
  enterprise_id text NOT NULL DEFAULT '',
  team_id text NOT NULL,
  channel_id text NOT NULL,
  application_id text,
  state text NOT NULL CHECK (state IN ('allow', 'deny')),
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (app_id, enterprise_id, team_id, channel_id),
  FOREIGN KEY (app_id, enterprise_id, team_id)
    REFERENCES slack_installations (app_id, enterprise_id, team_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS slack_deliveries (
  app_id text NOT NULL,
  enterprise_id text NOT NULL DEFAULT '',
  team_id text NOT NULL,
  delivery_id text NOT NULL,
  target jsonb NOT NULL,
  payload_version integer NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'dropped')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  slack_ts text,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (app_id, enterprise_id, team_id, delivery_id),
  FOREIGN KEY (app_id, enterprise_id, team_id)
    REFERENCES slack_installations (app_id, enterprise_id, team_id) ON DELETE CASCADE
);

-- The thread's cursors and where it is (S-207).
ALTER TABLE slack_thread_bindings ADD COLUMN IF NOT EXISTS last_event_id text;
ALTER TABLE slack_thread_bindings ADD COLUMN IF NOT EXISTS last_run_id text;
ALTER TABLE slack_thread_bindings ADD COLUMN IF NOT EXISTS visibility text
  CHECK (visibility IS NULL OR visibility IN ('channel', 'direct'));

-- A thread's binding before an explicit switch or start over (S-208): kept.
CREATE TABLE IF NOT EXISTS slack_thread_binding_history (
  id bigserial PRIMARY KEY,
  app_id text NOT NULL,
  enterprise_id text NOT NULL DEFAULT '',
  team_id text NOT NULL,
  channel_id text NOT NULL,
  thread_ts text NOT NULL,
  binding jsonb NOT NULL,
  reason text NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (app_id, enterprise_id, team_id)
    REFERENCES slack_installations (app_id, enterprise_id, team_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS slack_thread_binding_history_thread
  ON slack_thread_binding_history (app_id, enterprise_id, team_id, channel_id, thread_ts);

-- One turn at a time per thread (S-207), and the events already answered.
CREATE TABLE IF NOT EXISTS slack_thread_turns (
  app_id text NOT NULL,
  enterprise_id text NOT NULL DEFAULT '',
  team_id text NOT NULL,
  channel_id text NOT NULL,
  thread_ts text NOT NULL,
  event_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('running', 'done')),
  started_at timestamptz NOT NULL,
  run_id text,
  message_ts text,
  session_id text,
  PRIMARY KEY (app_id, enterprise_id, team_id, channel_id, thread_ts),
  FOREIGN KEY (app_id, enterprise_id, team_id)
    REFERENCES slack_installations (app_id, enterprise_id, team_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS slack_finished_events (
  app_id text NOT NULL,
  enterprise_id text NOT NULL DEFAULT '',
  team_id text NOT NULL,
  channel_id text NOT NULL,
  thread_ts text NOT NULL,
  event_id text NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, enterprise_id, team_id, channel_id, thread_ts, event_id),
  FOREIGN KEY (app_id, enterprise_id, team_id)
    REFERENCES slack_installations (app_id, enterprise_id, team_id) ON DELETE CASCADE
);

-- A prompt waiting for its person to choose the application (S-208): an hour at most.
CREATE TABLE IF NOT EXISTS slack_held_prompts (
  app_id text NOT NULL,
  enterprise_id text NOT NULL DEFAULT '',
  team_id text NOT NULL,
  event_id text NOT NULL,
  slack_user_id text NOT NULL,
  prompt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, enterprise_id, team_id, event_id),
  FOREIGN KEY (app_id, enterprise_id, team_id)
    REFERENCES slack_installations (app_id, enterprise_id, team_id) ON DELETE CASCADE
);

-- The application a thread's next session opens with, chosen explicitly (S-208).
CREATE TABLE IF NOT EXISTS slack_thread_next_application (
  app_id text NOT NULL,
  enterprise_id text NOT NULL DEFAULT '',
  team_id text NOT NULL,
  channel_id text NOT NULL,
  thread_ts text NOT NULL,
  application_id text NOT NULL,
  chosen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, enterprise_id, team_id, channel_id, thread_ts),
  FOREIGN KEY (app_id, enterprise_id, team_id)
    REFERENCES slack_installations (app_id, enterprise_id, team_id) ON DELETE CASCADE
);

COMMIT;
