// Work queue subsystem bounds. CLAUDE.md §5, §9 — every value here has a named cap and
// is either static at startup or enforced on entry. SPEC §Architecture drives the queue's
// existence; this file drives the numbers.

// Default lease duration stamped on dequeue. Matches LEASE_TTL_MS in session/limits.ts
// so both halves of the chain of custody (queue row and per-agent execution slot) expire
// in the same window — a crashed worker frees both together.
export const DEFAULT_LEASE_MS = 30_000;

// payload_ref is a pointer (session id, task id, object-store key), never the payload
// body. Capped so a malformed input can't balloon a queue row (CLAUDE.md §5 — cap strings
// crossing trust boundaries).
export const MAX_PAYLOAD_REF_LEN = 512;

// Workers pick their own identifier (hostname+pid, k8s pod name, etc.). Capped so the
// value used in WHERE clauses and span attributes can't grow unbounded.
export const MAX_WORKER_ID_LEN = 128;

// Maximum batch requested from a single dequeue call. The baseline worker pulls one at
// a time; batch support is a natural generalization, but a hard cap prevents a caller
// from hogging the dequeue round (CLAUDE.md §5 — every batch has a size cap).
export const MAX_DEQUEUE_BATCH = 32;
