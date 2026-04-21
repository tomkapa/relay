// Database subsystem bounds. See CLAUDE.md §5 and §9 — static allocation at boundaries,
// explicit caps on everything that crosses a trust line.

// Connection pool size. Sized at startup; workers never grow the pool on demand.
// Default tuned for a single worker; multi-worker deployments multiply.
export const DEFAULT_POOL_MAX = 10;

// Default statement timeout — every query is bounded (CLAUDE.md §5). Overridable per-call
// via postgres.js transaction options when a specific query legitimately needs longer.
export const DEFAULT_STATEMENT_TIMEOUT_MS = 5_000;

// Connect timeout — abandon if the server is unreachable in this window rather than
// hanging the worker.
export const CONNECT_TIMEOUT_MS = 5_000;

// Migration-apply timeout per file. Individual migrations must be short; long online
// migrations are planned separately per CLAUDE.md §14.
export const MIGRATION_STATEMENT_TIMEOUT_MS = 60_000;

// Max length of a migration file name. Guards against pathologically long inputs at the
// filesystem boundary (CLAUDE.md §5 — cap strings crossing trust boundaries).
export const MAX_MIGRATION_FILENAME_LEN = 128;
