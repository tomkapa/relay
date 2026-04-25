// Agent subsystem bounds. CLAUDE.md §5 — named caps with *why this number* comments.
// Pessimistic defaults; adjust when a real workload exists. See SPEC §Agent creation.

// Max system prompt length. Large enough for a realistic prompt, small enough to reject
// a 10 MB PUT accident. Anthropic's practical context window for prompts.
export const MAX_SYSTEM_PROMPT_LEN = 32_768;

// Max tool descriptors per agent. Matches Anthropic's practical tool-use limit.
export const MAX_TOOL_SET_SIZE = 256;

// Max hook rules per agent. Hooks run on every event; a giant list hurts turn latency
// before it hurts the DB.
export const MAX_HOOK_RULES_PER_AGENT = 256;

// Per-entry byte caps on serialized tool descriptor / hook rule JSON. Guards against a
// single large entry that stays under the array count cap but inflates the DB row.
export const MAX_TOOL_DESCRIPTOR_BYTES = 4_096;
export const MAX_HOOK_RULE_BYTES = 4_096;

// Name field caps within each tool descriptor / hook rule entry (characters).
export const MAX_TOOL_NAME_LEN = 128;
export const MAX_HOOK_RULE_NAME_LEN = 128;

// Max seed memories injected at agent creation. Pessimistic — agents needing > 16 bootstrap
// facts should use a separate batch import path rather than blocking the creation transaction.
export const MAX_SEED_MEMORIES = 16;
