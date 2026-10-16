BEGIN;

-- Questions an hour per person, workspace, organization and application (S-404).
CREATE TABLE IF NOT EXISTS slack_usage (
  usage_key text NOT NULL,
  usage_window text NOT NULL,
  used integer NOT NULL DEFAULT 0,
  PRIMARY KEY (usage_key, usage_window)
);

-- Who read a dead job's payload, when and why (S-405): privileged, audited.
CREATE TABLE IF NOT EXISTS slack_payload_access (
  id bigserial PRIMARY KEY,
  job_id bigint NOT NULL,
  operator text NOT NULL,
  reason text NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
