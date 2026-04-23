// Trigger handlers: session_start, task_fire, inbound_message.
// Each handler owns its full chain: resolve payload_ref → validate → emit telemetry.
// SPEC §Triggers, CLAUDE.md §6 (AssertionErrors crash the worker; operating errors return err).

import type { Sql } from "postgres";
import { assert } from "../core/assert.ts";
import type { Clock } from "../core/clock.ts";
import { err, ok, type Result, unreachable } from "../core/result.ts";
import { firstRow } from "../db/utils.ts";
import { ChainId, Depth, EnvelopeId, InboundMessageId, TaskId, TenantId, mintId } from "../ids.ts";
import type {
  AgentId as AgentIdBrand,
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
import { readInboundMessage } from "./inbound/inbound-ops.ts";
import type { InboundOpsError } from "./inbound/inbound-ops.ts";
import { parseInboundMessageRow } from "./inbound/payload.ts";
import type { InboundPayloadError } from "./inbound/payload.ts";
import { loadOpenTargetSession } from "../session/load-open.ts";
import type { TargetSessionError } from "../session/load-open.ts";
import type { ModelClient } from "../session/model.ts";
import type { ToolRegistry } from "../session/tools.ts";
import { runTurnLoop } from "../session/turn-loop.ts";
import type { Message } from "../session/turn.ts";
import { closeSession } from "../session/close.ts";
import type { SessionCloseError, SessionEndReason } from "../session/close.ts";
import type { TranscriptEntry } from "../session/transcript.ts";

export type HandlerDeps = {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly model: ModelClient;
  readonly tools: ToolRegistry;
};

type HookResult = { decision: "approve" } | { decision: "deny"; reason: string };

// Pass-through hook seam for session creation. Replaced by RELAY-36 evaluator; named params
// are omitted here — the real evaluator uses them.
// NOTE: Session row is already committed before this check. If the real evaluator can deny,
// the deny path must either run before createSession or handle the orphaned row (RELAY-36).
const hookStub: (sessionId: SessionIdBrand, payload: TriggerPayload) => Promise<HookResult> = () =>
  Promise.resolve({ decision: "approve" });

// Pass-through stub for RELAY-36/37 evaluator.
const preMessageReceiveStub: () => Promise<HookResult> = () =>
  Promise.resolve({ decision: "approve" });

export function openingContextToLoopInput(
  context: readonly TranscriptEntry[],
  systemPrompt: string,
): { systemPrompt: string; initialMessages: readonly Message[] } {
  assert(context.length >= 2, "openingContextToLoopInput: expected system + user entries");
  const first = context[0];
  assert(first !== undefined, "openingContextToLoopInput: first entry must exist");
  assert(first.role === "system", "openingContextToLoopInput: first entry must be system");

  const initialMessages: Message[] = [];
  for (let i = 1; i < context.length; i++) {
    const entry = context[i];
    assert(entry !== undefined, "openingContextToLoopInput: undefined entry at index");
    assert(entry.role === "user", "openingContextToLoopInput: expected user entries after system");
    initialMessages.push({ role: "user", content: [{ type: "text", text: entry.content }] });
  }
  return { systemPrompt, initialMessages };
}

type LoopTermination =
  | { kind: "close"; reason: SessionEndReason }
  | { kind: "retry"; handlerError: HandlerError };

function classifyLoopResult(result: Awaited<ReturnType<typeof runTurnLoop>>): LoopTermination {
  if (result.ok) return { kind: "close", reason: { kind: "end_turn" } };
  const e = result.error;
  switch (e.kind) {
    case "turn_cap_exceeded":
      return { kind: "close", reason: { kind: "turn_cap_exceeded", max: e.max } };
    case "model_call_failed":
      return {
        kind: "retry",
        handlerError: { kind: "handler_failed", reason: `model_call_failed: ${e.detail}` },
      };
    case "tool_invocation_failed":
      return {
        kind: "retry",
        handlerError: {
          kind: "handler_failed",
          reason: `tool_invocation_failed: ${e.toolName} — ${e.detail}`,
        },
      };
    case "tool_unknown":
      return {
        kind: "retry",
        handlerError: { kind: "handler_failed", reason: `tool_unknown: ${e.toolName}` },
      };
    case "timeout":
      return { kind: "retry", handlerError: { kind: "handler_timeout" } };
    case "persist_turn_failed":
      return {
        kind: "retry",
        handlerError: { kind: "handler_failed", reason: `persist_turn_failed: ${e.detail}` },
      };
    default:
      throw unreachable(e);
  }
}

function mapCloseError(e: SessionCloseError): HandlerError {
  switch (e.kind) {
    case "session_not_found":
      return {
        kind: "handler_failed",
        reason: `session not found at close: ${e.sessionId as string}`,
      };
    case "tenant_mismatch":
      return { kind: "handler_failed", reason: "session tenant mismatch at close" };
    default:
      throw unreachable(e);
  }
}

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

async function runLoopAndClose(
  deps: HandlerDeps,
  item: WorkItem,
  session: { readonly id: SessionIdBrand },
  agentId: AgentIdBrand,
  systemPrompt: string,
  context: readonly TranscriptEntry[],
): Promise<Result<void, HandlerError>> {
  const loopInput = openingContextToLoopInput(context, systemPrompt);
  const loopResult = await runTurnLoop(
    { sql: deps.sql, clock: deps.clock, model: deps.model, tools: deps.tools },
    { sessionId: session.id, agentId, tenantId: item.tenantId, ...loopInput },
  );
  const termination = classifyLoopResult(loopResult);
  if (termination.kind === "retry") {
    counter("session.turn_loop_outcome_total").add(1, {
      [Attr.TenantId]: item.tenantId,
      [Attr.TriggerKind]: item.kind,
      [Attr.TurnLoopOutcome]: "retryable_error",
    });
    return err(termination.handlerError);
  }
  const closeResult = await closeSession(deps.sql, deps.clock, {
    sessionId: session.id,
    tenantId: item.tenantId,
    agentId,
    reason: termination.reason,
  });
  if (!closeResult.ok) return err(mapCloseError(closeResult.error));
  counter("session.turn_loop_outcome_total").add(1, {
    [Attr.TenantId]: item.tenantId,
    [Attr.TriggerKind]: item.kind,
    [Attr.TurnLoopOutcome]: termination.reason.kind,
  });
  const turnCount = loopResult.ok ? loopResult.value.turns.length : 0;
  emit("INFO", "trigger.session_start.turn_complete", {
    [Attr.TenantId]: item.tenantId,
    [Attr.SessionId]: session.id,
    [Attr.WorkId]: item.id,
    [Attr.TurnsCount]: turnCount,
  });
  return ok(undefined);
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

      const session = sessionResult.value;
      if (session.isDuplicate) {
        return finalizeSession(deps, item, session, payload, start);
      }

      const loopResult = await runLoopAndClose(
        deps,
        item,
        session,
        payload.targetAgentId,
        agentResult.value.systemPrompt,
        context,
      );
      if (!loopResult.ok) return loopResult;

      return finalizeSession(deps, item, session, payload, start);
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

function mapInboundOpsError(e: InboundOpsError): HandlerError {
  switch (e.kind) {
    case "inbound_not_found":
      return { kind: "handler_failed", reason: `inbound message not found: ${e.id as string}` };
    case "content_too_long":
      return {
        kind: "handler_failed",
        reason: `inbound content too long: ${e.length.toString()} > ${e.max.toString()}`,
      };
    case "sender_id_too_long":
      return {
        kind: "handler_failed",
        reason: `inbound sender_id too long: ${e.length.toString()} > ${e.max.toString()}`,
      };
    default:
      throw unreachable(e);
  }
}

function mapInboundPayloadError(e: InboundPayloadError): HandlerError {
  switch (e.kind) {
    case "validation_failed":
      return { kind: "handler_failed", reason: "inbound payload validation failed" };
    case "content_too_long":
      return {
        kind: "handler_failed",
        reason: `inbound content too long: ${e.length.toString()} > ${e.max.toString()}`,
      };
    case "unknown_kind":
      return { kind: "handler_failed", reason: `unknown inbound kind: ${e.value}` };
    case "session_id_invalid":
      return { kind: "handler_failed", reason: `invalid target_session_id: ${e.reason}` };
    case "sender_id_too_long":
      return {
        kind: "handler_failed",
        reason: `inbound sender_id too long: ${e.length.toString()} > ${e.max.toString()}`,
      };
    default:
      throw unreachable(e);
  }
}

function mapTargetSessionError(e: TargetSessionError): HandlerError {
  switch (e.kind) {
    case "target_session_not_found":
      return { kind: "handler_failed", reason: `target session not found: ${e.id as string}` };
    case "target_session_closed":
      return {
        kind: "handler_failed",
        reason: `target session is closed: ${e.id as string}`,
      };
    case "target_session_tenant_mismatch":
      return {
        kind: "handler_failed",
        reason: `target session tenant mismatch: expected ${e.expected as string}, got ${e.got as string}`,
      };
    case "agent_not_found":
      return { kind: "handler_failed", reason: `agent not found: ${e.id as string}` };
    default:
      throw unreachable(e);
  }
}

async function handleInboundMessage(
  deps: HandlerDeps,
  item: WorkItem,
): Promise<Result<void, HandlerError>> {
  return withSpan(
    SpanName.TriggerIngest,
    { [Attr.TriggerKind]: item.kind, [Attr.TenantId]: item.tenantId },
    async () => {
      const start = deps.clock.monotonic();

      const inboundIdResult = InboundMessageId.parse(item.payloadRef);
      if (!inboundIdResult.ok) {
        return err<HandlerError>({
          kind: "handler_failed",
          reason: `invalid inbound_message id in payload_ref: ${inboundIdResult.error.kind}`,
        });
      }

      const rowResult = await readInboundMessage(deps.sql, inboundIdResult.value);
      if (!rowResult.ok) return err(mapInboundOpsError(rowResult.error));
      const row = rowResult.value;

      const rowTenantResult = TenantId.parse(row.tenant_id);
      assert(rowTenantResult.ok, "handleInboundMessage: invalid tenant_id from DB", {
        tenant_id: row.tenant_id,
      });
      if (rowTenantResult.value !== item.tenantId) {
        return err<HandlerError>({
          kind: "handler_failed",
          reason: "inbound tenant_id does not match work item tenant_id",
        });
      }

      const payloadResult = parseInboundMessageRow(row);
      if (!payloadResult.ok) return err(mapInboundPayloadError(payloadResult.error));
      const payload = payloadResult.value;

      const targetResult = await loadOpenTargetSession(
        deps.sql,
        payload.targetSessionId,
        item.tenantId,
      );
      if (!targetResult.ok) return err(mapTargetSessionError(targetResult.error));

      const hook = await preMessageReceiveStub();
      if (hook.decision === "deny") {
        return err<HandlerError>({ kind: "handler_failed", reason: `hook denied: ${hook.reason}` });
      }

      counter("trigger.inbound_message_delivered_total").add(1, {
        [Attr.TriggerKind]: item.kind,
        [Attr.SenderType]: payload.sender.type,
      });
      emit("INFO", "trigger.inbound_message.ready", {
        [Attr.TenantId]: item.tenantId,
        [Attr.SessionId]: payload.targetSessionId,
        [Attr.InboundMessageId]: inboundIdResult.value,
        [Attr.WorkId]: item.id,
      });
      histogram("trigger.handler_duration_ms").record(deps.clock.monotonic() - start, {
        [Attr.TriggerKind]: item.kind,
      });

      return ok(undefined);
    },
  );
}

export function triggerHandlers(deps: HandlerDeps): Dispatcher {
  return {
    session_start: (item) => handleSessionStart(deps, item),
    task_fire: (item) => handleTaskFire(deps, item),
    inbound_message: (item) => handleInboundMessage(deps, item),
  };
}
