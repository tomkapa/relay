// Single OpenTelemetry facade for the platform. CLAUDE.md §2 — no console.log, no other logger.
// Traces, metrics, and logs all flow through @opentelemetry/api. SDK bootstrap lives in
// src/telemetry/setup.ts and is loaded only by entrypoints.

import { logs, SeverityNumber, type Logger } from "@opentelemetry/api-logs";
import {
  context,
  metrics,
  SpanStatusCode,
  trace,
  TraceFlags,
  type Attributes,
  type Counter,
  type Histogram,
  type Meter,
  type Span,
  type SpanContext,
  type Tracer,
  type UpDownCounter,
} from "@opentelemetry/api";

export const INSTRUMENTATION_NAME = "relay";
export const INSTRUMENTATION_VERSION = "0.0.0";

export const tracer: Tracer = trace.getTracer(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION);
export const meter: Meter = metrics.getMeter(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION);
export const logger: Logger = logs.getLogger(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION);

let _testTracer: Tracer | undefined;

// Resolve the tracer withSpan uses. Tests install a provider-backed tracer via
// _setTracerForTest so they can read back spans and events; production uses the
// module-const tracer. Mirrors _setMeterForTest.
function resolveTracer(): Tracer {
  return _testTracer ?? tracer;
}

// Install a test tracer so withSpan records to a controllable provider.
// Pass undefined to restore production behavior. Never call in production code.
export function _setTracerForTest(t: Tracer | undefined): void {
  _testTracer = t;
}

export type { Attributes, Counter };

// Stable, low-cardinality span names. Dynamic values go on attributes (CLAUDE.md §2).
// Add new names here; never inline string literals at call sites.
export const SpanName = {
  AgentCreate: "agent.create",
  SessionTurn: "session.turn",
  SessionCreate: "session.create",
  HookEvaluate: "hook.evaluate",
  ToolCall: "tool.call",
  ModelCall: "model.call",
  MemoryRetrieve: "memory.retrieve",
  MemoryWrite: "memory.write",
  MemoryConsolidate: "memory.consolidate",
  ConnectorDispatch: "connector.dispatch",
  TriggerIngest: "trigger.ingest",
  TriggerSynthesize: "trigger.synthesize",
  WorkerHandle: "worker.handle",
  SessionClose: "session.close",
  SessionSyncDispatch: "session.sync.dispatch",
  HttpTriggerPost: "http.trigger.post",
  EmbeddingCall: "embedding.call",
} as const;
export type SpanName = (typeof SpanName)[keyof typeof SpanName];

// Custom attribute keys live under `relay.*` per CLAUDE.md §2.
export const Attr = {
  AgentId: "relay.agent.id",
  SessionId: "relay.session.id",
  TurnId: "relay.turn.id",
  TaskId: "relay.task.id",
  TenantId: "relay.tenant.id",
  ChainId: "relay.chain.id",
  Depth: "relay.depth",
  HookId: "relay.hook.id",
  HookEvent: "relay.hook.event",
  HookLayer: "relay.hook.layer",
  HookDecision: "relay.hook.decision",
  ToolName: "relay.tool.name",
  TriggerKind: "relay.trigger.kind",
  SenderType: "relay.sender.type",
  InboundMessageId: "relay.inbound_message.id",
  QueueOp: "relay.queue.op",
  QueueBatch: "relay.queue.batch",
  QueuePicked: "relay.queue.picked",
  WorkId: "relay.work.id",
  WorkKind: "relay.work.kind",
  WorkerId: "relay.worker.id",
  ProcessPid: "relay.process.pid",
  SessionCloseReason: "relay.session.close_reason",
  HookReason: "relay.hook.reason",
  TurnLoopOutcome: "relay.turn_loop.outcome",
  TurnsCount: "relay.turns.count",
  Outcome: "relay.outcome",
  EnvelopeId: "relay.envelope.id",
  MemoryKind: "relay.memory.kind",
  MemoryK: "relay.memory.k",
  MemoryCandidatePool: "relay.memory.candidate_pool",
  MemoryReturnedCount: "relay.memory.returned_count",
  MemoryAlpha: "relay.memory.alpha",
  MemoryHalfLifeDays: "relay.memory.half_life_days",
  MemoryEfSearch: "relay.memory.ef_search",
  EmbeddingModel: "relay.embedding.model",
  EmbeddingDim: "relay.embedding.dim",
  EmbeddingInputBytes: "relay.embedding.input_bytes",
  MemoryInjectedCount: "relay.memory.injected_count",
  MemoryInjectionSkipped: "relay.memory.injection.skipped_reason",
  SyncWaitMs: "relay.http.trigger.sync_wait_ms",
  SessionDurationMs: "relay.session.duration_ms",
} as const;
export type Attr = (typeof Attr)[keyof typeof Attr];

// OpenTelemetry GenAI semantic-convention attributes. Separate namespace from `relay.*`:
// these are spec-defined keys that Honeycomb (and any other OTel backend) recognizes
// for GenAI workloads. See https://opentelemetry.io/docs/specs/semconv/gen-ai/.
export const GenAiAttr = {
  OperationName: "gen_ai.operation.name", // chat | embeddings | execute_tool | …
  ProviderName: "gen_ai.provider.name", // anthropic | openai | …
  RequestModel: "gen_ai.request.model",
  RequestMaxTokens: "gen_ai.request.max_tokens",
  RequestTemperature: "gen_ai.request.temperature",
  RequestTopP: "gen_ai.request.top_p",
  RequestStopSequences: "gen_ai.request.stop_sequences",
  ResponseModel: "gen_ai.response.model",
  ResponseId: "gen_ai.response.id",
  ResponseFinishReasons: "gen_ai.response.finish_reasons",
  UsageInputTokens: "gen_ai.usage.input_tokens",
  UsageOutputTokens: "gen_ai.usage.output_tokens",
  UsageCacheReadInputTokens: "gen_ai.usage.cache_read.input_tokens",
  UsageCacheCreationInputTokens: "gen_ai.usage.cache_creation.input_tokens",
  UsageThinkingTokens: "gen_ai.usage.thinking_tokens",
  ConversationId: "gen_ai.conversation.id",
  ToolName: "gen_ai.tool.name",
  ToolType: "gen_ai.tool.type",
  ToolCallId: "gen_ai.tool.call.id",
  TokenType: "gen_ai.token.type", // input | output — metric attribute
  EmbeddingsDimensionCount: "gen_ai.embeddings.dimension.count",
  // Event-body attributes (carried on span events, not on the span itself) —
  // named here so we never hand-roll the strings at call sites.
  SystemInstructions: "gen_ai.system_instructions",
  InputMessages: "gen_ai.input.messages",
  OutputMessages: "gen_ai.output.messages",
  ToolDefinitions: "gen_ai.tool.definitions",
  ToolCallArguments: "gen_ai.tool.call.arguments",
  ToolCallResult: "gen_ai.tool.call.result",
  ToolCallIsError: "gen_ai.tool.call.is_error",
  ThinkingIndex: "gen_ai.thinking.index",
  ThinkingText: "gen_ai.thinking.text",
  ThinkingSignature: "gen_ai.thinking.signature",
  ThinkingBlockBytes: "gen_ai.thinking.bytes",
  ThinkingRedacted: "gen_ai.thinking.redacted",
  ThinkingTruncated: "gen_ai.thinking.truncated",
  // Relay-local accounting for thinking blocks — not part of the spec but namespaced
  // so they do not collide with future spec additions.
  ThinkingBlockCount: "relay.genai.thinking.block_count",
  ThinkingBytes: "relay.genai.thinking.bytes",
  ContentTruncated: "relay.genai.content.truncated",
  ErrorType: "error.type",
} as const;
export type GenAiAttr = (typeof GenAiAttr)[keyof typeof GenAiAttr];

// GenAI span-event names. The details event carries the consolidated messages payload
// (system_instructions + input.messages + output.messages + tool.definitions). Thinking
// and tool call args/result are separate events so they can be filtered at the Collector
// or dropped by a tail sampler without losing the structured call summary.
export const GenAiEvent = {
  InferenceDetails: "gen_ai.client.inference.operation.details",
  Thinking: "gen_ai.thinking",
  ToolCallArguments: "gen_ai.tool.call.arguments",
  ToolCallResult: "gen_ai.tool.call.result",
} as const;
export type GenAiEvent = (typeof GenAiEvent)[keyof typeof GenAiEvent];

// Run `fn` inside an active span. On throw: records exception AND sets ERROR status (both —
// one without the other is a bug per CLAUDE.md §2). Span ends on every path via finally.
export async function withSpan<T>(
  name: SpanName,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return resolveTracer().startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (e) {
      span.recordException(e as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
      throw e;
    } finally {
      span.end();
    }
  });
}

// Currently-active span (the one withSpan most recently opened in this async context),
// or undefined if none. Instrumentation helpers that enrich an already-open span (e.g.
// GenAI attribute and event emission inside model.call) read the span via this helper
// rather than import @opentelemetry/api directly — keeps the otel facade the single
// boundary (CLAUDE.md §2).
export function currentSpan(): Span | undefined {
  return trace.getActiveSpan();
}

// ---------------------------------------------------------------------------
// W3C Trace Context propagation (cross-process, via the work queue).
//
// Format: "00-<32 hex traceId>-<16 hex spanId>-<2 hex flags>" (W3C Trace Context §3.2).
// We serialize/parse manually — it's a single line of spec and keeps us free of a
// propagator dep in tests (NodeSDK registers one at boot, but tests skip boot).

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const INVALID_TRACE_ID = "00000000000000000000000000000000";
const INVALID_SPAN_ID = "0000000000000000";

// Serialize the active SpanContext as a W3C traceparent. Returns null when there is no
// valid active context (no span open, or context is the no-op root).
export function captureTraceparent(): string | null {
  const ctx = trace.getSpanContext(context.active());
  if (ctx === undefined) return null;
  if (!trace.isSpanContextValid(ctx)) return null;
  const flags = ctx.traceFlags.toString(16).padStart(2, "0");
  return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
}

// Parse a W3C traceparent into a remote SpanContext. Returns null for any malformed
// value (including the `ff` reserved version and the all-zero id sentinels).
export function parseTraceparent(raw: string): SpanContext | null {
  const m = TRACEPARENT_RE.exec(raw);
  if (m === null) return null;
  const version = m[1];
  const traceId = m[2];
  const spanId = m[3];
  const flagsStr = m[4];
  if (
    version === undefined ||
    traceId === undefined ||
    spanId === undefined ||
    flagsStr === undefined
  ) {
    return null;
  }
  if (version === "ff") return null;
  if (traceId === INVALID_TRACE_ID) return null;
  if (spanId === INVALID_SPAN_ID) return null;
  const traceFlags = parseInt(flagsStr, 16) & TraceFlags.SAMPLED;
  return { traceId, spanId, traceFlags, isRemote: true };
}

// Run `fn` with the parsed parent installed as the active span context. A null or
// malformed traceparent degrades to calling `fn` directly — cross-process correlation
// is best-effort; a broken parent must never block the work.
export function withRemoteParent<T>(traceparent: string | null, fn: () => Promise<T>): Promise<T> {
  if (traceparent === null) return fn();
  const parent = parseTraceparent(traceparent);
  if (parent === null) return fn();
  const ctx = trace.setSpanContext(context.active(), parent);
  return context.with(ctx, fn);
}

// Structured logs. Severity + short event name + flat attribute bag. Never interpolate values
// into the message (CLAUDE.md §2).
export type LogSeverity = "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";

const SEVERITY: Record<LogSeverity, SeverityNumber> = {
  DEBUG: SeverityNumber.DEBUG,
  INFO: SeverityNumber.INFO,
  WARN: SeverityNumber.WARN,
  ERROR: SeverityNumber.ERROR,
  FATAL: SeverityNumber.FATAL,
};

export function emit(severity: LogSeverity, event: string, attributes: Attributes = {}): void {
  logger.emit({
    severityNumber: SEVERITY[severity],
    severityText: severity,
    body: event,
    attributes,
  });
}

// Cached instrument handles. Created lazily on first use; bounded by call-site count.
const counters = new Map<string, Counter>();
const upDownCounters = new Map<string, UpDownCounter>();
const histograms = new Map<string, Histogram>();

let _testMeter: Meter | undefined;

function getInstrumentMeter(): Meter {
  return _testMeter ?? metrics.getMeter(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION);
}

export function counter(name: string, description?: string): Counter {
  let c = counters.get(name);
  if (!c) {
    c = getInstrumentMeter().createCounter(
      name,
      description !== undefined ? { description } : undefined,
    );
    counters.set(name, c);
  }
  return c;
}

export function upDownCounter(name: string, description?: string): UpDownCounter {
  let c = upDownCounters.get(name);
  if (!c) {
    c = getInstrumentMeter().createUpDownCounter(
      name,
      description !== undefined ? { description } : undefined,
    );
    upDownCounters.set(name, c);
  }
  return c;
}

export function histogram(name: string, description?: string, unit?: string): Histogram {
  let h = histograms.get(name);
  if (!h) {
    const options: { description?: string; unit?: string } = {};
    if (description !== undefined) options.description = description;
    if (unit !== undefined) options.unit = unit;
    h = getInstrumentMeter().createHistogram(name, options);
    histograms.set(name, h);
  }
  return h;
}

// Returns the active test meter when one is installed (via _setMeterForTest), otherwise the
// module-level real meter. Observable gauge registrars call this at registration time so they
// land on the same provider as synchronous instruments.
export function getMeterForObservable(): Meter {
  return _testMeter ?? meter;
}

// Install a test meter so instruments are created on a controllable provider.
// Clears all cached handles so the first call after installation creates fresh instruments
// on the test meter. Pass undefined to restore production (global OTel API) behavior.
// Never call in production code.
export function _setMeterForTest(m: Meter | undefined): void {
  _testMeter = m;
  counters.clear();
  upDownCounters.clear();
  histograms.clear();
}
