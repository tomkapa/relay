-- Core entity schema. SPEC §Data Model — agents, sessions, tasks. tenant_id lives on every
-- row from the start (SPEC §Tenancy). RLS policies land in a later migration once the
-- session GUC contract is in place; this migration is column + index + FK only.

-- pgvector is required for the memory store (SPEC §Memory). Create it here so later
-- migrations that add vector columns can assume it exists.
CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- agents
-- ---------------------------------------------------------------------------
-- SPEC: system prompt, tool set, memory store ref, hook rules ref, tenant_id.
--
-- `tool_set` is a JSON array of tool descriptors; the shape is owned by the tool registry
-- and validated at the API boundary (not the DB). Same for `hook_rules` — stored as JSON
-- so the hook evaluator is the single source of truth for shape.
--
-- `*_ref` columns are intentionally nullable for now: the memory store and hook rule set
-- are written through their own insertion paths (SPEC §Agent creation) and may be linked
-- after the row is inserted within the same transaction.
CREATE TABLE agents (
    id                UUID PRIMARY KEY,
    tenant_id         UUID NOT NULL,
    system_prompt     TEXT NOT NULL,
    tool_set          JSONB NOT NULL DEFAULT '[]'::jsonb,
    hook_rules        JSONB NOT NULL DEFAULT '[]'::jsonb,
    memory_store_ref  TEXT,
    hook_rules_ref    TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agents_tenant_idx ON agents (tenant_id);

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------
-- SPEC: agent_id, originating trigger, parent_session_id, chain_id, depth, turn transcript,
-- closed_at (nullable), tenant_id.
--
-- 'Active' and 'suspended' are NOT columns — they are derived from lease state (SPEC
-- §Execution Model). Do not add them here.
--
-- `depth` check matches DEPTH_CAP in src/ids.ts / src/hook/limits.ts. A row that would
-- violate the check should never be inserted because the hook evaluator denies first,
-- but the DB check is defense-in-depth.
--
-- `parent_session_id` is a self-reference; NULL for fresh triggers.
CREATE TABLE sessions (
    id                   UUID PRIMARY KEY,
    agent_id             UUID NOT NULL REFERENCES agents (id),
    tenant_id            UUID NOT NULL,
    originating_trigger  JSONB NOT NULL,
    parent_session_id    UUID REFERENCES sessions (id),
    chain_id             UUID NOT NULL,
    depth                INTEGER NOT NULL CHECK (depth >= 0 AND depth <= 32),
    turn_transcript      JSONB NOT NULL DEFAULT '[]'::jsonb,
    closed_at            TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Required indexes per the task:
--   (agent_id, closed_at) — used by per-agent session lookups that scope by open/closed.
--   (chain_id)            — loop-safety traversal and budgeting (SPEC §Loop safety).
-- tenant_id gets its own index for scoped listings.
CREATE INDEX sessions_agent_closed_idx ON sessions (agent_id, closed_at);
CREATE INDEX sessions_chain_id_idx    ON sessions (chain_id);
CREATE INDEX sessions_tenant_idx      ON sessions (tenant_id);

-- ---------------------------------------------------------------------------
-- tasks
-- ---------------------------------------------------------------------------
-- SPEC: trigger condition (cron schedule or event filter), intent string, agent_id, tenant_id.
--
-- `trigger_condition` JSON carries both shapes:
--   { "kind": "cron",  "expr": "0 * * * *", "tz": "UTC" }
--   { "kind": "event", "source": "…",       "filter": { … } }
-- The dispatcher enforces the shape at fire time.
CREATE TABLE tasks (
    id                 UUID PRIMARY KEY,
    agent_id           UUID NOT NULL REFERENCES agents (id),
    tenant_id          UUID NOT NULL,
    trigger_condition  JSONB NOT NULL,
    intent             TEXT NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tasks_tenant_idx ON tasks (tenant_id);
CREATE INDEX tasks_agent_idx  ON tasks (agent_id);
