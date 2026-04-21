-- work_queue
-- SPEC §Architecture — 'Stateless worker pool consumes a Postgres-backed work queue.'
-- Row kinds cover the three MVP trigger shapes (SPEC §Triggers): a session being
-- started from scratch, a scheduled task firing, and an inbound message being delivered.
--
-- Shared across tenants in MVP. Per-tenant fairness (queue partitioning, per-tenant
-- dequeue quotas) is a post-MVP enhancement (SPEC §Tenancy).
--
-- Dequeue uses FOR UPDATE SKIP LOCKED so concurrent workers never compete for the same
-- row. That SQL lives in src/work_queue/queue.ts; this migration owns only the table
-- shape and the indexes that dequeue depends on.

CREATE TABLE work_queue (
    id             UUID PRIMARY KEY,
    tenant_id      UUID NOT NULL,
    kind           TEXT NOT NULL CHECK (kind IN ('session_start', 'task_fire', 'inbound_message')),
    payload_ref    TEXT NOT NULL,
    scheduled_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Lease fields. Both NULL = unleased. Both non-null = owned by the worker whose id
    -- is stamped in leased_by until leased_until. A crashed worker leaves its lease to
    -- expire; the next dequeue reclaims the row.
    leased_by      TEXT,
    leased_until   TIMESTAMPTZ,

    -- Bumped on each dequeue. Bounded at the application boundary rather than the DB
    -- so dead-lettering (post-MVP) can evolve the semantics freely.
    attempts       INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),

    -- Terminal state. NULL while pending or leased; set once when the work completes.
    completed_at   TIMESTAMPTZ,

    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Lease pair is all-or-nothing. A leased_until without a leased_by is meaningless.
    CONSTRAINT work_queue_lease_paired CHECK (
        (leased_by IS NULL AND leased_until IS NULL)
     OR (leased_by IS NOT NULL AND leased_until IS NOT NULL)
    )
);

-- Dequeue hot path: earliest-ready-first ordering, gated by 'not completed'. Partial
-- index because the completed set dominates over time and never participates in dequeue.
-- Sort columns match the dequeue ORDER BY (scheduled_at, id) to support an index scan
-- under FOR UPDATE SKIP LOCKED.
CREATE INDEX work_queue_ready_idx
    ON work_queue (scheduled_at, id)
    WHERE completed_at IS NULL;

-- Tenant-scoped scans (observability, per-tenant cancellation).
CREATE INDEX work_queue_tenant_idx
    ON work_queue (tenant_id);
