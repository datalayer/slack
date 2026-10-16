BEGIN;

-- Who stopped a running turn (S-205): the Stop handler writes it before
-- Datalayer is asked to stop the run, and the worker answering the turn
-- (possibly another process) reads it when the stream ends without an
-- ending, to say "Stopped by @person". A new event's turn starts unmarked.
ALTER TABLE slack_thread_turns ADD COLUMN IF NOT EXISTS stopped_by text;

COMMIT;
