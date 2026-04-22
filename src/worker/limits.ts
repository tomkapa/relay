// Worker subsystem bounds. CLAUDE.md §5 — every value here is named, exported, and
// commented with why this number. Magic numbers in logic are banned.

// How long to sleep when queue returned no ready items. Keeps idle workers from
// hammering DB with tight poll loops while adding minimal latency when work arrives.
export const EMPTY_QUEUE_IDLE_MS = 100;

// How long to wait before retrying after an unexpected infra error (DB flapping,
// network blip). Short enough to recover quickly; long enough to avoid flooding
// error logs in a sustained outage.
export const LOOP_ERROR_BACKOFF_MS = 1_000;

// Renew lease at 1/3 of DEFAULT_LEASE_MS (30 s). At this interval, two consecutive
// missed renewals still leave time before the lease expires, so another worker won't
// race to reclaim the item mid-execution.
export const LEASE_RENEW_INTERVAL_MS = 10_000;

// Grace period after SIGTERM before hard-exit if the running handler ignores abort.
// Long enough for typical AI/DB calls to drain; short enough for Kubernetes rolling
// deploys not to stall.
export const DRAIN_TIMEOUT_MS = 30_000;

// Cap on the idle sleep to prevent unbounded back-off after many consecutive empty
// polls. 2 s is still low-latency for newly enqueued work.
export const IDLE_BACKOFF_CAP_MS = 2_000;
