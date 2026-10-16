BEGIN;

-- A running turn's heartbeat (S-207): the worker answering it writes this
-- every minute, so a long turn is told apart from a crashed one. A turn is
-- stale (another prompt may take the thread) and resumable (its redelivery
-- answers into the same message) by its last heartbeat, not by its start.
ALTER TABLE slack_thread_turns ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;

COMMIT;
