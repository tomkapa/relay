-- SPEC §Audit. Two tables:
-- 1. hook_audit — one row per hook evaluation (approve/deny/modify).
-- 2. pending_system_messages — durable queue of deny reasons waiting to surface on the next turn.
--
-- hook_id is TEXT (stable stub names e.g. "system/session-start/stub") until hook_rules
-- ships in a future migration (RELAY-138+) that converts it to a UUID FK.

CREATE TABLE hook_audit (
    id               UUID PRIMARY KEY,
    tenant_id        UUID NOT NULL,
    -- Nullable: SessionStart evaluated before the session row exists has no session yet.
    session_id       UUID REFERENCES sessions (id) ON DELETE CASCADE,
    agent_id         UUID NOT NULL REFERENCES agents (id),
    -- Nullable: some events fire outside a turn (e.g. session_start, pre_message_receive).
    turn_id          UUID,
    hook_id          TEXT NOT NULL,
    layer            TEXT NOT NULL CHECK (layer IN ('system', 'organization', 'agent')),
    event            TEXT NOT NULL CHECK (event IN (
        'session_start', 'session_end',
        'pre_tool_use', 'post_tool_use',
        'pre_message_receive', 'pre_message_send'
    )),
    -- Identity matcher for MVP stubs (always true). Column ships now so RELAY-138 evaluator
    -- needs no schema change.
    matcher_result   BOOLEAN NOT NULL,
    decision         TEXT NOT NULL CHECK (decision IN ('approve', 'deny', 'modify')),
    -- Deny reason capped at MAX_DENY_REASON_CHARS. NULL for approve/modify rows.
    -- PII risk: reason may contain payload snippets. Accepted as audit exposure at MVP (RELAY-136 risk).
    reason           TEXT,
    latency_ms       INTEGER NOT NULL CHECK (latency_ms >= 0),
    -- Non-null only for pre_tool_use / post_tool_use events.
    tool_name        TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Operational reads: all denies for session S, pivot from transcript to deny.
CREATE INDEX hook_audit_session_created_idx
    ON hook_audit (session_id, created_at) WHERE session_id IS NOT NULL;

-- Tenant-scoped audit listings and exports.
CREATE INDEX hook_audit_tenant_created_idx
    ON hook_audit (tenant_id, created_at);

-- Hook-level analysis: how often is this stub/rule denying?
CREATE INDEX hook_audit_hook_event_idx
    ON hook_audit (hook_id, event);

-- Durable queue of synthetic system messages waiting to surface on the target session's next turn.
CREATE TABLE pending_system_messages (
    id                UUID PRIMARY KEY,
    tenant_id         UUID NOT NULL,
    target_session_id UUID NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    -- Currently only 'hook_deny'. Extend the CHECK in a later migration for new kinds.
    kind              TEXT NOT NULL CHECK (kind IN ('hook_deny')),
    -- Back-reference: pivot from transcript entry → what hook denied → at what layer/payload.
    hook_audit_id     UUID NOT NULL REFERENCES hook_audit (id) ON DELETE CASCADE,
    content           TEXT NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- NULL until consumed by the turn loop; set in the same transaction as insertTurn.
    -- Rows are never deleted — the trail is kept for audit.
    consumed_at       TIMESTAMPTZ,
    consumed_by_turn  UUID
);

-- Primary read path: undrained messages for session S, ordered by creation time.
CREATE INDEX pending_system_messages_session_unconsumed_idx
    ON pending_system_messages (target_session_id, created_at)
    WHERE consumed_at IS NULL;

CREATE INDEX pending_system_messages_tenant_idx
    ON pending_system_messages (tenant_id);

-- Reversible rollback (CLAUDE.md §14):
-- DROP INDEX IF EXISTS pending_system_messages_tenant_idx;
-- DROP INDEX IF EXISTS pending_system_messages_session_unconsumed_idx;
-- DROP TABLE IF EXISTS pending_system_messages;
-- DROP INDEX IF EXISTS hook_audit_hook_event_idx;
-- DROP INDEX IF EXISTS hook_audit_tenant_created_idx;
-- DROP INDEX IF EXISTS hook_audit_session_created_idx;
-- DROP TABLE IF EXISTS hook_audit;
