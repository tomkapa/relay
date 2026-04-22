// Trigger handlers: session_start, task_fire, and an inbound_message stub (RELAY-47).
// Each handler owns its full chain: resolve payload_ref → load agent → create session
// → emit telemetry. Prompt synthesis is the only kind-specific step.
// SPEC §Triggers, CLAUDE.md §6 (AssertionErrors crash the worker; operating errors return err).

import type { Sql } from "postgres";
import { assert } from "../core/assert.ts";
import type { Clock } from "../core/clock.ts";
import { err, ok, type Result, unreachable } from "../core/result.ts";
import { firstRow } from "../db/utils.ts";
import { ChainId, Depth, EnvelopeId, TaskId, TenantId, mintId } from "../ids.ts";
import type {
  ChainId as ChainIdBrand,
  Depth as DepthBrand,
  SessionId as SessionIdBrand,
  TenantId as TenantIdBrand,
} from "../ids.ts";
import { Attr, SpanName, counter, emit, histogram, withSpan } from "../telemetry/otel.ts";
import type { Dispatcher, HandlerError } from "../worker/dispatcher.ts";
import type { WorkItem } from "../work_queue/queue.ts";
import { loadAgent } from "../agent/load.ts";
import type { AgentLoadError } from "../agent/load.ts";
import { readEnvelope } from "./envelope-ops.ts";
import type { EnvelopeError } from "./envelope-ops.ts";
import { parseEnvelopePayload, parseTaskRow } from "./payload.ts";
import type { TaskRow, TriggerPayload, TriggerPayloadError } from "./payload.ts";
import { synthesizeOpeningContext } from "./synthesize.ts";
import { createSession } from "../session/create.ts";
import type { SessionCreateError } from "../session/create.ts";

export type HandlerDeps = {
  readonly sql: Sql;
  readonly clock: Clock;
};

type HookResult = { decision: "approve" } | { decision: "deny"; reason: string };

// Pass-through hook seam for session creation. Replaced by RELAY-36 evaluator; named params
// are omitted here — the real evaluator uses them.
// NOTE: Session row is already committed before this check. If the real evaluator can deny,
// the deny path must either run before createSession or handle the orphaned row (RELAY-36).
const hookStub: (sessionId: SessionIdBrand, payload: TriggerPayload) => Promise<HookResult> = () =>
  Promise.resolve({ decision: "approve" });

function mapPayloadError(e: TriggerPayloadError): HandlerError {
  switch (e.kind) {
    case "validation_failed":
      return { kind: "handler_failed", reason: "payload validation failed" };
    case "content_too_long":
      return {
        kind: "handler_failed",
        reason: `content too long: ${e.length.toString()} > ${e.max.toString()}`,
      };
    case "unknown_kind":
      return { kind: "handler_failed", reason: `unknown payload kind: ${e.value}` };
    case "agent_id_invalid":
      return { kind: "handler_failed", reason: `invalid agent_id: ${e.reason}` };
    case "task_id_invalid":
      return { kind: "handler_failed", reason: `invalid task_id: ${e.reason}` };
    case "envelope_too_large":
      return {
        kind: "handler_failed",
        reason: `envelope too large: ${e.bytes.toString()} > ${e.max.toString()}`,
      };
    default:
      throw unreachable(e);
  }
}

function mapEnvelopeError(e: EnvelopeError): HandlerError {
  switch (e.kind) {
    case "envelope_not_found":
      return { kind: "handler_failed", reason: `envelope not found: ${e.id as string}` };
    case "envelope_too_large":
      return {
        kind: "handler_failed",
        reason: `envelope too large: ${e.bytes.toString()} > ${e.max.toString()}`,
      };
    case "id_invalid":
      return { kind: "handler_failed", reason: `invalid envelope id: ${e.reason}` };
    case "tenant_id_invalid":
      return { kind: "handler_failed", reason: `invalid tenant_id in envelope: ${e.reason}` };
    default:
      throw unreachable(e);
  }
}

function mapAgentError(e: AgentLoadError): HandlerError {
  return { kind: "handler_failed", reason: `agent not found: ${e.agentId as string}` };
}

function mapSessionError(e: SessionCreateError): HandlerError {
  switch (e.kind) {
    case "agent_not_found":
      return { kind: "handler_failed", reason: `agent not found: ${e.agentId as string}` };
    case "tenant_mismatch":
      return { kind: "handler_failed", reason: "tenant mismatch" };
    case "transcript_too_large":
      return {
        kind: "handler_failed",
        reason: `transcript too large: ${e.bytes.toString()} > ${e.max.toString()}`,
      };
    default:
      throw unreachable(e);
  }
}

function mintChainAndDepth(): { chainId: ChainIdBrand; depth: DepthBrand } {
  const chainId = mintId(ChainId.parse, "mintChainAndDepth");
  const depthResult = Depth.parse(0);
  assert(depthResult.ok, "mintChainAndDepth: depth 0 out of range");
  return { chainId, depth: depthResult.value };
}

async function finalizeSession(
  deps: HandlerDeps,
  item: WorkItem,
  sessionResult: { id: SessionIdBrand; isDuplicate: boolean },
  payload: TriggerPayload,
  start: number,
): Promise<Result<void, HandlerError>> {
  const hook = await hookStub(sessionResult.id, payload);
  if (hook.decision === "deny") {
    return err<HandlerError>({ kind: "handler_failed", reason: `hook denied: ${hook.reason}` });
  }

  if (sessionResult.isDuplicate) {
    counter("trigger.duplicate_session_avoided_total").add(1, { [Attr.TriggerKind]: item.kind });
  } else {
    counter("trigger.session_created_total").add(1, { [Attr.TriggerKind]: item.kind });
  }
  emit("INFO", `trigger.${item.kind}.ready`, {
    [Attr.TenantId]: item.tenantId,
    [Attr.SessionId]: sessionResult.id,
    [Attr.WorkId]: item.id,
  });
  histogram("trigger.handler_duration_ms").record(deps.clock.monotonic() - start, {
    [Attr.TriggerKind]: item.kind,
  });

  return ok(undefined);
}

async function handleSessionStart(
  deps: HandlerDeps,
  item: WorkItem,
): Promise<Result<void, HandlerError>> {
  return withSpan(
    SpanName.TriggerIngest,
    { [Attr.TriggerKind]: item.kind, [Attr.TenantId]: item.tenantId },
    async () => {
      const start = deps.clock.monotonic();

      const envelopeIdResult = EnvelopeId.parse(item.payloadRef);
      if (!envelopeIdResult.ok) {
        return err<HandlerError>({
          kind: "handler_failed",
          reason: `invalid envelope id in payload_ref: ${envelopeIdResult.error.kind}`,
        });
      }

      const envelopeResult = await readEnvelope(deps.sql, envelopeIdResult.value);
      if (!envelopeResult.ok) return err(mapEnvelopeError(envelopeResult.error));
      const envelope = envelopeResult.value;

      if (envelope.tenantId !== item.tenantId) {
        return err<HandlerError>({
          kind: "handler_failed",
          reason: "envelope tenant_id does not match work item tenant_id",
        });
      }

      const payloadResult = parseEnvelopePayload(envelope.payload);
      if (!payloadResult.ok) return err(mapPayloadError(payloadResult.error));
      const payload = payloadResult.value;

      const agentResult = await loadAgent(deps.sql, payload.targetAgentId);
      if (!agentResult.ok) return err(mapAgentError(agentResult.error));

      const { chainId, depth } = mintChainAndDepth();
      const context = synthesizeOpeningContext(payload, agentResult.value);

      const sessionResult = await createSession(deps.sql, deps.clock, {
        agentId: payload.targetAgentId,
        tenantId: item.tenantId,
        originatingTrigger: { kind: payload.kind, envelopeId: envelope.id as string },
        parentSessionId: null,
        chainId,
        depth,
        openingContext: context,
        sourceWorkItemId: item.id,
      });
      if (!sessionResult.ok) return err(mapSessionError(sessionResult.error));

      return finalizeSession(deps, item, sessionResult.value, payload, start);
    },
  );
}

async function readTaskRow(
  sql: Sql,
  taskIdStr: string,
  itemTenantId: TenantIdBrand,
): Promise<Result<TaskRow, HandlerError>> {
  const taskIdResult = TaskId.parse(taskIdStr);
  if (!taskIdResult.ok) {
    return err({
      kind: "handler_failed",
      reason: `invalid task_id in payload_ref: ${taskIdResult.error.kind}`,
    });
  }

  const rows = await sql<TaskRow[]>`
    SELECT id, agent_id, tenant_id, intent FROM tasks WHERE id = ${taskIdResult.value}
  `;
  if (rows.length === 0) {
    return err({ kind: "handler_failed", reason: `task not found: ${taskIdStr}` });
  }
  const row = firstRow(rows, "readTaskRow");

  const tenantResult = TenantId.parse(row.tenant_id);
  assert(tenantResult.ok, "readTaskRow: invalid tenant_id from DB", { tenant_id: row.tenant_id });
  if (tenantResult.value !== itemTenantId) {
    return err({
      kind: "handler_failed",
      reason: "task tenant_id does not match work item tenant_id",
    });
  }

  return ok(row);
}

async function handleTaskFire(
  deps: HandlerDeps,
  item: WorkItem,
): Promise<Result<void, HandlerError>> {
  return withSpan(
    SpanName.TriggerIngest,
    { [Attr.TriggerKind]: item.kind, [Attr.TenantId]: item.tenantId },
    async () => {
      const start = deps.clock.monotonic();

      const taskRowResult = await readTaskRow(deps.sql, item.payloadRef, item.tenantId);
      if (!taskRowResult.ok) return taskRowResult;
      const taskRow = taskRowResult.value;

      const firedAt = new Date(deps.clock.now());
      const payloadResult = parseTaskRow(taskRow, firedAt);
      if (!payloadResult.ok) return err(mapPayloadError(payloadResult.error));
      const payload = payloadResult.value;

      const agentResult = await loadAgent(deps.sql, payload.agentId);
      if (!agentResult.ok) return err(mapAgentError(agentResult.error));

      const { chainId, depth } = mintChainAndDepth();
      const context = synthesizeOpeningContext(payload, agentResult.value);

      const sessionResult = await createSession(deps.sql, deps.clock, {
        agentId: payload.agentId,
        tenantId: item.tenantId,
        originatingTrigger: {
          kind: "task_fire",
          taskId: payload.taskId as string,
          firedAt: firedAt.toISOString(),
          intent: payload.intent,
        },
        parentSessionId: null,
        chainId,
        depth,
        openingContext: context,
        sourceWorkItemId: item.id,
      });
      if (!sessionResult.ok) return err(mapSessionError(sessionResult.error));

      return finalizeSession(deps, item, sessionResult.value, payload, start);
    },
  );
}

export function triggerHandlers(deps: HandlerDeps): Dispatcher {
  return {
    session_start: (item) => handleSessionStart(deps, item),
    task_fire: (item) => handleTaskFire(deps, item),
    inbound_message: () =>
      Promise.resolve(
        err<HandlerError>({
          kind: "handler_failed",
          reason: "not implemented: inbound_message (owned by RELAY-47)",
        }),
      ),
  };
}
