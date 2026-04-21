// Session subsystem bounds. Every value here exists because SPEC.md or CLAUDE.md demands a
// named, explicit cap — no magic numbers in logic (CLAUDE.md §5).

// Max turns a single session may execute before forced compaction (SPEC.md §Compaction).
// Chosen high enough that normal conversations never hit it; low enough that runaway loops do.
export const MAX_TURNS_PER_SESSION = 500;

// Bytes of transcript after which compaction is triggered at the next turn boundary.
// Tuned to the model's effective attention window, not the raw context limit.
export const COMPACTION_THRESHOLD_BYTES = 256 * 1024;

// Max turns the compactor rewrites in one pass. A compaction takes the per-agent slot
// (SPEC.md §Compaction) so runtime must stay bounded.
export const MAX_TURNS_PER_COMPACTION = 50;

// Per-agent execution lease lifetime. Renewed during long model calls. Expires on worker crash
// so another worker can resume from the last persisted yield point (SPEC.md §Execution Model).
export const LEASE_TTL_MS = 30_000;
export const LEASE_RENEW_INTERVAL_MS = 10_000;

// Default `ask` timeout. Per-call override via tool args (SPEC.md §Timeouts).
export const ASK_DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

// Max simultaneous open sessions per agent. Prevents unbounded fan-out of suspended waiters.
export const MAX_OPEN_SESSIONS_PER_AGENT = 1_000;
