-- turns
-- SPEC §Execution Model: one row per turn. `started_at` is stamped before the model call;
-- `completed_at` plus `response` / `tool_results` / `usage` land when the turn finishes.
-- The base loop writes the row once on completion (single INSERT); RELAY-73 two-phase
-- persistence evolves this into an INSERT-then-UPDATE sequence without a schema change.
--
-- `turn_transcript` on `sessions` is dropped here: the row-per-turn shape is strictly
-- more useful and nothing in production reads it. Both changes are in one migration so the
-- forward and rollback paths stay symmetric.

CREATE TABLE turns (
    id              UUID PRIMARY KEY,
    session_id      UUID NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    tenant_id       UUID NOT NULL,
    agent_id        UUID NOT NULL REFERENCES agents (id),
    turn_index      INTEGER NOT NULL CHECK (turn_index >= 0),
    started_at      TIMESTAMPTZ NOT NULL,
    completed_at    TIMESTAMPTZ,              -- NULL while the turn is in flight (RELAY-73)
    response        JSONB,                    -- NULL until the model call returns
    tool_results    JSONB NOT NULL DEFAULT '[]'::jsonb,
    usage           JSONB,                    -- { inputTokens, outputTokens, cache... } or NULL
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Prevents duplicate indexes under concurrent workers (defense-in-depth under RELAY-29).
-- Also the unique key RELAY-73 will use when upserting on retry.
CREATE UNIQUE INDEX turns_session_turn_idx ON turns (session_id, turn_index);

-- Per-tenant analytics ("cost in the last hour", "tokens by tenant per day").
CREATE INDEX turns_tenant_started_idx ON turns (tenant_id, started_at);

-- Remove the JSONB array column from sessions; no consumer exists.
ALTER TABLE sessions DROP COLUMN turn_transcript;

-- Rollback:
-- ALTER TABLE sessions ADD COLUMN turn_transcript JSONB NOT NULL DEFAULT '[]'::jsonb;
-- UPDATE sessions
--     SET turn_transcript = COALESCE(
--         (SELECT jsonb_agg(response ORDER BY turn_index)
--          FROM turns
--          WHERE session_id = sessions.id AND response IS NOT NULL),
--         '[]'::jsonb
--     );
-- DROP TABLE IF EXISTS turns;
