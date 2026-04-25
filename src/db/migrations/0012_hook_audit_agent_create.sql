-- Extend hook_audit event CHECK constraint to include agent_create.
-- SPEC §Agent creation: agent_create is the only lifecycle event with no session/turn.
-- agent_create audit rows have session_id IS NULL and turn_id IS NULL.

ALTER TABLE hook_audit DROP CONSTRAINT hook_audit_event_check;
ALTER TABLE hook_audit ADD CONSTRAINT hook_audit_event_check CHECK (
    event IN (
        'session_start', 'session_end',
        'pre_tool_use', 'post_tool_use',
        'pre_message_receive', 'pre_message_send',
        'agent_create'
    )
);

-- Reversible rollback (CLAUDE.md §14):
-- ALTER TABLE hook_audit DROP CONSTRAINT hook_audit_event_check;
-- ALTER TABLE hook_audit ADD CONSTRAINT hook_audit_event_check CHECK (
--     event IN (
--         'session_start', 'session_end',
--         'pre_tool_use', 'post_tool_use',
--         'pre_message_receive', 'pre_message_send'
--     )
-- );
