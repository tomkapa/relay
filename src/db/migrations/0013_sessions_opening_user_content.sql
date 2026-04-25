-- Add opening_user_content to sessions so resume (RELAY-143) can reload the
-- original user message without depending on trigger_envelopes retention.
-- Pre-launch: no rows exist, so NOT NULL with no default is safe.
-- 32768 matches MAX_OPENING_USER_CONTENT in src/trigger/limits.ts.

ALTER TABLE sessions
    ADD COLUMN opening_user_content TEXT NOT NULL
    CHECK (length(opening_user_content) <= 32768);

-- Rollback:
-- ALTER TABLE sessions DROP COLUMN IF EXISTS opening_user_content;
