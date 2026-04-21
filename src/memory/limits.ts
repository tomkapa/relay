// Memory subsystem bounds. See SPEC.md §Memory.

// Max entries returned by a single retrieval call. Higher → better recall, worse latency.
export const MAX_RETRIEVAL = 32;

// Max length of a single memory entry's text. Longer entries are truncated at the write boundary
// so the embedding step has a bounded input (CLAUDE.md §5 — cap strings crossing trust boundaries).
export const MAX_ENTRY_TEXT_BYTES = 8 * 1024;

// Default importance when the agent does not pass a value to `remember(...)` (SPEC.md §Memory).
export const DEFAULT_IMPORTANCE = 0.5;

// Retrieval-score tunables. Replaceable with a learned scorer later; the schema does not change.
export const DEFAULT_HALF_LIFE_DAYS = 90;
export const DEFAULT_ALPHA = 1.0;

// Usage-adjustment coefficients (SPEC.md §Memory — Usage-adjusted). Tuned, not theoretical.
export const USAGE_BOOST_PER_RETRIEVAL = 0.05;
export const USAGE_DECAY_PER_MONTH = 0.02;

// Max entries the consolidation pass processes in one run. Keeps the pass bounded.
export const MAX_EVENTS_PER_CONSOLIDATION = 500;
