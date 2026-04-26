-- Chain-scoped session reuse, lifecycle dichotomy, pending-ask ledger, cascade_close work kind.
-- RELAY-146.

-- Partial unique index: at most one open child per (parent_session_id, agent_id).
CREATE UNIQUE INDEX sessions_open_child_uniq
    ON sessions (parent_session_id, agent_id)
    WHERE closed_at IS NULL AND parent_session_id IS NOT NULL;

-- Pending-ask ledger: one row per ask dispatched from parent to child.
CREATE TABLE session_pending_asks (
    id                  UUID PRIMARY KEY,
    tenant_id           UUID NOT NULL,
    parent_session_id   UUID NOT NULL REFERENCES sessions (id),
    child_session_id    UUID NOT NULL REFERENCES sessions (id),
    parent_tool_use_id  TEXT NOT NULL CHECK (length(parent_tool_use_id) BETWEEN 1 AND 128),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at         TIMESTAMPTZ,
    resolved_kind       TEXT CHECK (resolved_kind IN ('reply_routed', 'timeout', 'late_reply_dropped', 'cascade_orphan'))
);
CREATE INDEX session_pending_asks_child_unresolved_idx
    ON session_pending_asks (child_session_id, created_at DESC)
    WHERE resolved_at IS NULL;
CREATE INDEX session_pending_asks_parent_idx
    ON session_pending_asks (parent_session_id);
CREATE UNIQUE INDEX session_pending_asks_parent_tool_use_idx
    ON session_pending_asks (parent_session_id, parent_tool_use_id);

-- Extend work_queue kind to include cascade_close.
ALTER TABLE work_queue
    DROP CONSTRAINT IF EXISTS work_queue_kind_check;
ALTER TABLE work_queue
    ADD CONSTRAINT work_queue_kind_check
    CHECK (kind IN ('session_start', 'task_fire', 'inbound_message', 'cascade_close'));

-- Rollback:
-- ALTER TABLE work_queue DROP CONSTRAINT IF EXISTS work_queue_kind_check;
-- ALTER TABLE work_queue ADD CONSTRAINT work_queue_kind_check CHECK (kind IN ('session_start', 'task_fire', 'inbound_message'));
-- DROP TABLE IF EXISTS session_pending_asks;
-- DROP INDEX IF EXISTS sessions_open_child_uniq;
