BEGIN;

-- S-405. Idempotent; re-applied every time after 001 to 009.

-- Which database role read a payload or replayed a job: the credential that
-- authenticated the operator, beside the operator IAM named. Rows from
-- before this migration have none. Once the roles are split
-- (migrations/roles/), it is slack_dead_letters on every row.
ALTER TABLE slack_payload_access ADD COLUMN IF NOT EXISTS database_role text;
ALTER TABLE slack_payload_access ALTER COLUMN database_role SET DEFAULT session_user;
ALTER TABLE slack_job_replays ADD COLUMN IF NOT EXISTS database_role text;
ALTER TABLE slack_job_replays ALTER COLUMN database_role SET DEFAULT session_user;

COMMIT;
