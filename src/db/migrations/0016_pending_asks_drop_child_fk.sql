-- Drop the FK on session_pending_asks.child_session_id.
-- RELAY-146 follow-up: the producer writes the pending-ask ledger row at dispatch
-- time, BEFORE the child session row exists (the session is created by the worker
-- that processes the session_start work item we enqueue moments later). The FK is
-- incompatible with this producer-writes-first ordering — INSERT fails immediately
-- at the producer; DEFERRABLE doesn't help because the child is created in a
-- separate transaction.
--
-- Integrity is preserved by:
--   (a) the producer's deterministic child id derivation from (parent, target),
--   (b) the cascade-orphan mechanism that resolves all unresolved rows when a
--       child terminates,
--   (c) the unique constraint on (parent_session_id, parent_tool_use_id) which
--       prevents duplicate ledger writes on retry.
--
-- The FK on parent_session_id is preserved — parents always exist at producer time.

ALTER TABLE session_pending_asks
    DROP CONSTRAINT session_pending_asks_child_session_id_fkey;

-- Rollback:
-- ALTER TABLE session_pending_asks
--     ADD CONSTRAINT session_pending_asks_child_session_id_fkey
--     FOREIGN KEY (child_session_id) REFERENCES sessions (id);
