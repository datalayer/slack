BEGIN;

-- S-405. The role split, applied after migrations/ by `migrate --roles` as
-- slack_owner, every time; idempotent. Not part of the ordinary sequence:
-- it needs the roles, the two schemas and the tables' ownership moved once
-- by a superuser (docs/operations.md).
--
-- slack_owner owns every table and function and runs the migrations.
-- The service's role (`slack.service_role`, set by the migrate script)
-- reaches its tables, and the queue through the view <service role>.slack_jobs,
-- which has no dead job; the default search_path ("$user", public) puts that
-- view before the table, which it may not read. slack_dead_letters reaches
-- dead jobs only, through slack_dead_letters.slack_jobs, and writes the
-- audit (slack_payload_access, slack_job_replays), which it may not read
-- or change. The service's role does not reach the audit at all.

DO $roles$
DECLARE
  service text := current_setting('slack.service_role');
  stray text;
  who text;
  one record;
BEGIN
  IF current_user <> 'slack_owner' THEN
    RAISE EXCEPTION 'The roles step runs as slack_owner, not %.', current_user;
  END IF;
  IF service IN ('slack_owner', 'slack_dead_letters') OR service !~ '^[a-z_][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'The service''s role cannot be %.', service;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = service)
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'slack_dead_letters') THEN
    RAISE EXCEPTION 'The roles % and slack_dead_letters must exist.', service;
  END IF;

  SELECT string_agg(name, ', ' ORDER BY name) INTO stray FROM (
    SELECT n.nspname || '.' || c.relname AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname LIKE 'slack\_%'
       AND c.relkind IN ('r', 'S', 'v', 'p')
       AND pg_get_userbyid(c.relowner) <> 'slack_owner'
    UNION ALL
    SELECT n.nspname || '.' || p.proname || '()'
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname LIKE 'slack\_%'
       AND pg_get_userbyid(p.proowner) <> 'slack_owner'
    UNION ALL
    SELECT 'schema ' || wanted
      FROM unnest(ARRAY[service, 'slack_dead_letters']) AS wanted
     WHERE NOT EXISTS (
       SELECT 1 FROM pg_namespace
        WHERE nspname = wanted AND pg_get_userbyid(nspowner) = 'slack_owner')
  ) AS missing;
  IF stray IS NOT NULL THEN
    RAISE EXCEPTION 'Not owned by slack_owner: %. A superuser moves them once (docs/operations.md, Database roles).', stray;
  END IF;

  -- Whatever was granted before (the one-time step keeps the service
  -- running meanwhile) is taken back, then granted again here.
  FOREACH who IN ARRAY ARRAY[service, 'slack_dead_letters'] LOOP
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', who);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', who);
    EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', who);
  END LOOP;

  -- The service: its tables, never the queue's table or the audit.
  FOR one IN
    SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname LIKE 'slack\_%' AND c.relkind IN ('r', 'p', 'S')
       AND c.relname NOT IN ('slack_jobs', 'slack_payload_access', 'slack_job_replays',
                             'slack_payload_access_id_seq', 'slack_job_replays_id_seq')
  LOOP
    IF one.relkind = 'S' THEN
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO %I', one.relname, service);
    ELSE
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO %I', one.relname, service);
    END IF;
  END LOOP;

  -- The queue without its dead jobs. security_barrier: no function of the
  -- service's sees a row the view leaves out.
  EXECUTE format(
    'CREATE OR REPLACE VIEW %I.slack_jobs WITH (security_barrier) AS
       SELECT * FROM public.slack_jobs WHERE state <> ''dead''', service);
  EXECUTE format('REVOKE ALL ON %I.slack_jobs FROM PUBLIC', service);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.slack_jobs TO %I', service, service);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', service, service);

  -- The dead letters: dead jobs only; a replay changes a job's state, its
  -- attempts and when it is available, nothing else (never a payload).
  CREATE OR REPLACE VIEW slack_dead_letters.slack_jobs WITH (security_barrier) AS
    SELECT * FROM public.slack_jobs WHERE state = 'dead';
  REVOKE ALL ON slack_dead_letters.slack_jobs FROM PUBLIC;
  GRANT SELECT, UPDATE (state, attempts, available_at, last_error)
    ON slack_dead_letters.slack_jobs TO slack_dead_letters;
  GRANT USAGE ON SCHEMA slack_dead_letters TO slack_dead_letters;
  GRANT INSERT ON public.slack_payload_access, public.slack_job_replays TO slack_dead_letters;
  GRANT USAGE ON SEQUENCE public.slack_payload_access_id_seq, public.slack_job_replays_id_seq
    TO slack_dead_letters;
END
$roles$;

COMMIT;
