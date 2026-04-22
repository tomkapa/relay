-- SPEC §Communication. Inbound messages (human/agent/system senders) delivered to an
-- already-open target session. Written by producers (ask/notify tool, HTTP ingress
-- follow-ups, future ask-timeout injector) *before* enqueueing an `inbound_message`
-- work item whose payload_ref = inbound_messages.id.
--
-- The row is durable. Unlike trigger_envelopes (read-once, disposable), inbound_messages
-- is the source of truth for what the target session was told at a given moment and
-- is read by the resume plumbing when composing the next turn's input.

CREATE TABLE inbound_messages (
    id                   UUID PRIMARY KEY,
    tenant_id            UUID NOT NULL,
    target_session_id    UUID NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    -- Sender metadata is SPEC-metadata only; routing is producer-side. Stored as three
    -- columns (not one JSONB blob) so hooks and analytics can query them directly.
    -- SPEC §Communication: "sender type (human, agent, system) is metadata on the message".
    sender_type          TEXT NOT NULL CHECK (sender_type IN ('human', 'agent', 'system')),
    sender_id            TEXT NOT NULL,
    sender_display_name  TEXT,
    -- `kind` is the discriminator for the InboundMessagePayload tagged union. Only
    -- 'message' is accepted in RELAY-47. Future variants (e.g. 'timeout' from RELAY-9's
    -- ask-timeout injector) extend this CHECK clause in a later migration.
    kind                 TEXT NOT NULL CHECK (kind IN ('message')),
    content              TEXT NOT NULL,
    received_at          TIMESTAMPTZ NOT NULL,
    source_work_item_id  UUID,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Primary read path: "give me all inbound_messages for session S since turn T".
-- target_session_id + received_at matches both the resume-plumbing scan and analytics.
CREATE INDEX inbound_messages_target_received_idx
    ON inbound_messages (target_session_id, received_at);

-- Tenant-scoped listings (admin UI, audit).
CREATE INDEX inbound_messages_tenant_idx ON inbound_messages (tenant_id);

-- Idempotent producer path. One inbound_messages row per work_queue row.
CREATE UNIQUE INDEX inbound_messages_source_work_item_idx
    ON inbound_messages (source_work_item_id)
    WHERE source_work_item_id IS NOT NULL;

-- Reversible rollback (CLAUDE.md §14):
-- DROP INDEX IF EXISTS inbound_messages_source_work_item_idx;
-- DROP INDEX IF EXISTS inbound_messages_tenant_idx;
-- DROP INDEX IF EXISTS inbound_messages_target_received_idx;
-- DROP TABLE IF EXISTS inbound_messages;
