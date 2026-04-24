-- RELAY-133: Idempotency key for memory writes (SPEC §Retry and idempotency).
-- Every platform-internal side effect carries a deterministic idempotency key;
-- writers dedup by this key. This migration delivers the machinery on the one
-- side-effect writer that exists today — memory.
--
-- The key is sha256(writer | session_id | turn_id | tool_call_id), derived in
-- application code via src/core/idempotency.ts. The DB only sees the opaque
-- 64-hex-char digest; the formula is validated in unit tests.
--
-- RELAY-168 (two-phase turn persistence) makes turn_id / tool_call_id stable across
-- worker-crash retries. Until that lands, this column still protects same-transaction
-- double-writes and within-turn replays; cross-crash dedup activates once RELAY-168 ships.
--
-- The column is NOT NULL. `memory` is a fresh table (migration 0007, RELAY-129), no
-- rows exist in any environment, so the NOT NULL add is trivial — no backfill is needed.
-- If that ever stops being true, split into three steps (ADD COLUMN NULL, backfill,
-- SET NOT NULL) per CLAUDE.md §14.

ALTER TABLE memory ADD COLUMN idempotency_key TEXT NOT NULL;

-- Unique across the whole memory table. Writer namespacing happens inside the hash
-- input (see src/core/idempotency.ts) so a single column-level UNIQUE is sufficient.
CREATE UNIQUE INDEX memory_idempotency_key_idx ON memory (idempotency_key);

-- Reversible rollback (CLAUDE.md §14):
-- DROP INDEX IF EXISTS memory_idempotency_key_idx;
-- ALTER TABLE memory DROP COLUMN IF EXISTS idempotency_key;
