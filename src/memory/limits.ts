// Memory subsystem bounds. See SPEC.md §Memory.

// Max entries returned by a single retrieval call. Higher → better recall, worse latency.
export const MAX_RETRIEVAL = 32;

// Pre-rerank candidate pool. Larger → re-rank has more headroom to demote similarity-leaders
// that lose on importance/recency. Tuning is RELAY-219's concern.
// MAX is a hard ceiling so a buggy caller cannot fan-out unboundedly (CLAUDE §5).
export const DEFAULT_RETRIEVAL_CANDIDATES = 32;
export const MAX_RETRIEVAL_CANDIDATES = 128;

// pgvector's HNSW dynamic candidate list size. Set per-transaction via SET LOCAL.
// pgvector default is 40; we use max(candidatePool, 40) so the index always offers
// at least as many candidates as we want to re-rank.
export const HNSW_EF_SEARCH_FLOOR = 40;

// Embedding vector dimension. Commits to OpenAI text-embedding-3-small (experimentation phase).
// Qwen3-Embed-8B (4096-dim) migration is owned by RELAY-214 — do not parametrize.
export const EMBEDDING_DIM = 1536;

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

// Upper bound on a single embed() HTTP call. Detects hung connections before the caller's
// per-tool / per-turn budget expires (CLAUDE §5 — every async op has a timeout).
export const EMBEDDING_CALL_TIMEOUT_MS = 10_000;

// UTF-8 byte cap for embed() input. Mirrors MAX_ENTRY_TEXT_BYTES so the embedder truncates
// on the same boundary as the writer — vector space stays consistent with stored text.
// OpenAI's hard limit is ~8192 tokens (~30 KB); 8 KB leaves generous headroom.
export const MAX_EMBED_INPUT_BYTES = MAX_ENTRY_TEXT_BYTES;
