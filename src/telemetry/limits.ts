// Telemetry subsystem bounds. CLAUDE.md §5 — every value here is named with "why this number."

// Max time shutdownTelemetry() blocks flushing buffered signals. Long enough for a slow
// BatchSpanProcessor drain over OTLP; short enough to stay inside the worker drain window
// (DRAIN_TIMEOUT_MS = 30s) and a typical Kubernetes terminationGracePeriod (30s).
export const TELEMETRY_SHUTDOWN_MS = 5_000;

// BatchSpanProcessor export interval. SDK default is 5s; pin it here so it's tunable
// without editing setup.ts. 5s trades a few seconds of debugging latency for reduced
// backend write amplification.
export const TRACE_EXPORT_INTERVAL_MS = 5_000;

// Log BatchLogRecordProcessor interval. Matches TRACE_EXPORT_INTERVAL_MS so trace↔log
// correlation in the debugging workflow is tight.
export const LOG_EXPORT_INTERVAL_MS = 5_000;

// PeriodicExportingMetricReader interval. 10s matches the OTel SDK default and gives
// Honeycomb enough time-resolution for rate/gauge queries without flooding the OTLP path
// the way a 1s interval would. Delta temporality on counters means each export is a
// self-contained window.
export const METRIC_EXPORT_INTERVAL_MS = 10_000;
