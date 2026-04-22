// HTTP server bounds. CLAUDE.md §5 — named caps with *why this number* comments.

// Max request body size. Belt-and-braces over the per-field caps in src/agent/limits.ts.
// Rejects a 10 MB PUT accident before body parsing even starts.
export const MAX_REQUEST_BYTES = 1_048_576; // 1 MiB

// Valid port range for the HTTP server. Ports below 1024 require root on most systems;
// 65535 is the TCP maximum.
export const PORT_MIN = 1024;
export const PORT_MAX = 65_535;

// Default port used when PORT env var is absent.
export const DEFAULT_PORT = 8080;
