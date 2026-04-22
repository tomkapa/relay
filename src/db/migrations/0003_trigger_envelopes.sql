-- SPEC §Triggers. Producer side (HTTP ingress, connectors) writes a row here when it
-- enqueues a session_start work item so work_queue.payload_ref stays a small pointer
-- (MAX_PAYLOAD_REF_LEN = 512) instead of carrying the full payload body.
--
-- Read-once per session: the session_start handler loads the envelope, synthesizes the
-- opening context, and never revisits the row. Retention is bounded by the cleanup
-- job (RELAY-<envelope cleanup tech-debt>).
CREATE TABLE trigger_envelopes (
    id           UUID PRIMARY KEY,
    tenant_id    UUID NOT NULL,
    -- 'message' and 'event' are handled by RELAY-26. inbound_message envelopes, if any,
    -- are owned by RELAY-47 and may live in a separate table.
    kind         TEXT NOT NULL CHECK (kind IN ('message', 'event')),
    payload      JSONB NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX trigger_envelopes_tenant_idx ON trigger_envelopes (tenant_id);

-- Idempotent session creation. The work_queue row id is the natural key. If a worker
-- crashes between INSERT sessions and UPDATE work_queue SET completed_at, the next worker
-- re-runs the handler: the INSERT violates this unique index, and the handler reads the
-- existing row via source_work_item_id instead of creating a duplicate.
ALTER TABLE sessions
    ADD COLUMN source_work_item_id UUID;
CREATE UNIQUE INDEX sessions_source_work_item_idx
    ON sessions (source_work_item_id)
    WHERE source_work_item_id IS NOT NULL;

-- Rollback:
-- DROP INDEX IF EXISTS sessions_source_work_item_idx;
-- ALTER TABLE sessions DROP COLUMN IF EXISTS source_work_item_id;
-- DROP INDEX IF EXISTS trigger_envelopes_tenant_idx;
-- DROP TABLE IF EXISTS trigger_envelopes;
