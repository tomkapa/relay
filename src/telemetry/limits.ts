// Telemetry subsystem bounds. CLAUDE.md §5 — every value here is named with "why this number."

import { assert } from "../core/assert.ts";

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

// GenAI content-event caps. Honeycomb's per-attribute ceiling is ~64 KiB and a span
// carries many attributes plus events; we cap each *content part* (one message piece,
// one tool argument, one tool result, one thinking block) so the aggregated span
// payload stays within the exporter's OTLP budget on long multi-turn, multi-tool calls.
// 16 KiB covers real system prompts and assistant messages while leaving headroom for
// many of them in the same turn.
export const MAX_GENAI_CONTENT_BYTES_PER_PART = 16 * 1024;

// Same cap as content. Thinking blocks can be long; exceeding this captures the head
// and flags truncation on the span.
export const MAX_GENAI_THINKING_BYTES_PER_BLOCK = 16 * 1024;

// Upper bound on historical messages serialized into the
// gen_ai.client.inference.operation.details event. The event is recent context for
// debugging, not a full transcript — turn rows in Postgres are the system of record.
export const MAX_GENAI_MESSAGES_PER_EVENT = 50;

// Upper bound on tool definitions serialized into the event. Agents with wildly more
// tools than this signal a design issue.
export const MAX_GENAI_TOOL_DEFINITIONS = 100;

// Truncate a string to at most `maxBytes` UTF-8 bytes without splitting a multi-byte
// codepoint. Pulls back to the nearest codepoint boundary using UTF-8's continuation-byte
// pattern (leading bits 10xxxxxx). Returns `bytes` = the byte length of the ORIGINAL
// string, so callers that also need to record "bytes seen" don't have to recompute it.
export function truncateUtf8(
  s: string,
  maxBytes: number,
): { text: string; truncated: boolean; bytes: number } {
  assert(maxBytes > 0, "truncateUtf8: maxBytes must be positive", { maxBytes });
  if (s.length === 0) return { text: "", truncated: false, bytes: 0 };
  const buf = Buffer.from(s, "utf8");
  const bytes = buf.byteLength;
  if (bytes <= maxBytes) return { text: s, truncated: false, bytes };
  let cut = maxBytes;
  while (cut > 0) {
    const b = buf[cut];
    if (b === undefined) break;
    if ((b & 0b1100_0000) !== 0b1000_0000) break;
    cut--;
  }
  return { text: buf.subarray(0, cut).toString("utf8"), truncated: true, bytes };
}
