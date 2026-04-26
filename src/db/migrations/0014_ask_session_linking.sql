-- Parent-linkage propagation for ask-spawned child sessions (SPEC §Communication, §Loop safety).
-- RELAY-144.

ALTER TABLE sessions
    ADD COLUMN parent_tool_use_id TEXT
    CHECK (parent_tool_use_id IS NULL OR length(parent_tool_use_id) BETWEEN 1 AND 128);

ALTER TABLE inbound_messages
    ADD COLUMN source_tool_use_id TEXT
    CHECK (source_tool_use_id IS NULL OR length(source_tool_use_id) BETWEEN 1 AND 128);

-- 128 matches TOOL_USE_ID_MAX_LEN in src/ids.ts.

-- Rollback:
-- ALTER TABLE inbound_messages DROP COLUMN IF EXISTS source_tool_use_id;
-- ALTER TABLE sessions          DROP COLUMN IF EXISTS parent_tool_use_id;
