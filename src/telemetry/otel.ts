// Single OpenTelemetry facade for the platform. CLAUDE.md §2 — no console.log, no other logger.
// Traces, metrics, and logs all flow through @opentelemetry/api. SDK bootstrap lives in
// src/telemetry/setup.ts and is loaded only by entrypoints.

import { logs, SeverityNumber, type Logger } from "@opentelemetry/api-logs";
import {
  metrics,
  SpanStatusCode,
  trace,
  type Attributes,
  type Counter,
  type Histogram,
  type Meter,
  type Span,
  type Tracer,
  type UpDownCounter,
} from "@opentelemetry/api";

export const INSTRUMENTATION_NAME = "relay";
export const INSTRUMENTATION_VERSION = "0.0.0";

export const tracer: Tracer = trace.getTracer(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION);
export const meter: Meter = metrics.getMeter(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION);
export const logger: Logger = logs.getLogger(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION);

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
  WorkerPick: "worker.pick",
  WorkerTick: "worker.tick",
  WorkerHandle: "worker.handle",
  SessionClose: "session.close",
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
} as const;
export type Attr = (typeof Attr)[keyof typeof Attr];

// Run `fn` inside an active span. On throw: records exception AND sets ERROR status (both —
// one without the other is a bug per CLAUDE.md §2). Span ends on every path via finally.
export async function withSpan<T>(
  name: SpanName,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
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
