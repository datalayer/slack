BEGIN;

-- The idempotency record of an inbound Slack event (S-004). The host kit's
-- work queue claims an event as `ingress:<event_id>` in slack_event_claims,
-- in the transaction that enqueues its job; that claim is extended here with
-- the hash of the request as normalized at ingress (a retry is the same
-- hash, another request under the same event id is refused), where its turn
-- stands, what answered it (its session, turn and Slack message) and when the
-- record expires and is purged. Other claims (OAuth nonces, deliveries) keep
-- no hash and no expiry.
ALTER TABLE slack_event_claims ADD COLUMN IF NOT EXISTS request_hash text;
ALTER TABLE slack_event_claims ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'claimed'
  CHECK (state IN ('claimed', 'answered', 'refused', 'failed'));
ALTER TABLE slack_event_claims ADD COLUMN IF NOT EXISTS result_ref jsonb;
ALTER TABLE slack_event_claims ADD COLUMN IF NOT EXISTS expires_at timestamptz;
CREATE INDEX IF NOT EXISTS slack_event_claims_expires_at
  ON slack_event_claims (expires_at) WHERE expires_at IS NOT NULL;

COMMIT;
