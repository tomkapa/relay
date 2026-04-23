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

// Per-tenant cap on uncompleted work_queue rows. Safety backstop — not a plan-tiered
// quota (that is future tech-debt). 10_000 is generous enough that a well-behaved
// tenant will never hit it, tight enough that a runaway producer stops within one
// screen of logs. Revisit when a real tenant approaches this number — the metric
// added in RELAY-127 is the trigger.
export const MAX_WORK_QUEUE_ROWS_PER_TENANT = 10_000;

// Cap on tenants emitted by the observer per metric tick. Defends the backend
// time-series store from a tenant-creation bug explosion. Not an operational limit
// on tenants per cluster — that is a product decision elsewhere.
export const MAX_TENANTS_OBSERVED_PER_TICK = 1_000;
