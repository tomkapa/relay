-- RELAY-131: Memory retrieval read path — HNSW index + per-agent tunables.
-- The HNSW index enables ANN candidate fetch for two-stage retrieval (candidate pool → app-side
-- re-rank with the scoring formula). Per-agent tunables allow different time horizons per agent.
-- See SPEC §Memory and RELAY-131 technical notes.

-- HNSW index on memory.embedding for ANN search. Defaults from pgvector (m=16, ef_construction=64).
-- vector_cosine_ops because the score formula uses cosine similarity (1 - cosine_distance).
-- Tuning (m, ef_construction, per-query ef_search) is RELAY-219's concern.
-- Rollback: DROP INDEX IF EXISTS memory_embedding_hnsw_idx;
CREATE INDEX memory_embedding_hnsw_idx
    ON memory USING hnsw (embedding vector_cosine_ops);

-- Per-agent retrieval tunables (SPEC §Memory). Defaults match src/memory/limits.ts constants:
-- DEFAULT_IMPORTANCE = 0.5, DEFAULT_HALF_LIFE_DAYS = 90, DEFAULT_ALPHA = 1.0.
-- Existing rows backfill via column defaults; no separate UPDATE needed.
-- RELAY-142 (agent creation API) will accept overrides in the create payload.
-- Rollback:
--   ALTER TABLE agents DROP COLUMN memory_alpha;
--   ALTER TABLE agents DROP COLUMN memory_half_life_days;
--   ALTER TABLE agents DROP COLUMN memory_default_importance;
ALTER TABLE agents
    ADD COLUMN memory_default_importance DOUBLE PRECISION NOT NULL DEFAULT 0.5
        CHECK (memory_default_importance >= 0 AND memory_default_importance <= 1),
    ADD COLUMN memory_half_life_days     INTEGER          NOT NULL DEFAULT 90
        CHECK (memory_half_life_days > 0),
    ADD COLUMN memory_alpha              DOUBLE PRECISION NOT NULL DEFAULT 1.0
        CHECK (memory_alpha >= 0);
