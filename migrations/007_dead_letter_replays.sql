BEGIN;

-- Every replay of a dead job, kept (S-405): who asked, and whether a dead job
-- was there to replay. Payload reads are kept in slack_payload_access (004).
CREATE TABLE IF NOT EXISTS slack_job_replays (
  id bigserial PRIMARY KEY,
  job_id bigint NOT NULL,
  operator text NOT NULL,
  replayed boolean NOT NULL,
  replayed_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
