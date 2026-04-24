-- SPEC §Memory. One table holding both raw events (kind = 'event') and distilled facts
-- (kind = 'fact'). Two layers in one store so the consolidator and retrieval path blend
-- both kinds uniformly. See RELAY-129.
--
-- pgvector extension is assumed present (CREATE EXTENSION IF NOT EXISTS vector in 0001_init.sql).
-- The vector similarity index (HNSW / IVFFlat) is deferred to RELAY-131 to keep write-path
-- schema separate from read-path index tunables.

CREATE TABLE memory (
    id                 UUID PRIMARY KEY,
    tenant_id          UUID NOT NULL,
    agent_id           UUID NOT NULL REFERENCES agents (id),
    kind               TEXT NOT NULL CHECK (kind IN ('event', 'fact')),
    text               TEXT NOT NULL,
    embedding          vector(1536) NOT NULL,
    importance         DOUBLE PRECISION NOT NULL
                       CHECK (importance >= 0 AND importance <= 1),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_retrieved_at  TIMESTAMPTZ,
    retrieval_count    INTEGER NOT NULL DEFAULT 0 CHECK (retrieval_count >= 0)
);

-- Tenant-scoped listings (admin, audit).
CREATE INDEX memory_tenant_idx     ON memory (tenant_id);
-- Consolidator reads (agent_id, kind='event'); retrieval candidate-narrowing reads (agent_id, kind).
CREATE INDEX memory_agent_kind_idx ON memory (agent_id, kind);

-- Reversible rollback (CLAUDE.md §14):
-- DROP INDEX IF EXISTS memory_agent_kind_idx;
-- DROP INDEX IF EXISTS memory_tenant_idx;
-- DROP TABLE IF EXISTS memory;
