// Hook subsystem bounds. See SPEC.md §Hooks and §Loop safety.

// Depth cap for causal chains. Exceeded → SessionStart system hook denies. Catches agent-to-agent
// ping-pong. Must match DEPTH_CAP in src/ids.ts — keep in sync or the brand parse and the hook
// disagree about what "in range" means.
export const DEPTH_CAP = 32;

// Per-agent rate cap for session creations within the rolling window. Catches loops that pass
// through external systems and lose chain_id along the way (SPEC.md §Loop safety).
export const RATE_CAP_SESSIONS_PER_WINDOW = 200;
export const RATE_CAP_WINDOW_MS = 60 * 1000;

// Max hooks evaluated per lifecycle event across all three layers (system + org + agent).
// Composition is all-matching (SPEC.md §Composition), so we still need a ceiling.
export const MAX_HOOKS_PER_EVENT = 64;

// Per-hook evaluation budget. CEL predicates are fast; this guards against pathological inputs.
export const HOOK_EVAL_TIMEOUT_MS = 50;

// Max length of the `reason` string surfaced back to the agent on a deny (SPEC.md §Audit).
export const MAX_DENY_REASON_CHARS = 512;

// Max pending_system_messages drained per turn. Agents accumulating more than this between
// turns have a structural problem that RELAY-141 (config pinning) should surface.
export const MAX_PENDING_MESSAGES_PER_TURN = 16;
