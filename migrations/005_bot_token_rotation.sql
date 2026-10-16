BEGIN;

-- Token rotation (S-102): the bot token's refresh token, encrypted like the
-- bot token, and when the bot token expires (UTC seconds). Both empty for a
-- workspace installed without rotation.
ALTER TABLE slack_installations ADD COLUMN IF NOT EXISTS bot_refresh_token jsonb;
ALTER TABLE slack_installations ADD COLUMN IF NOT EXISTS bot_token_expires_at bigint;

COMMIT;
