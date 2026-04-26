// Agentic loop: model call + tool call alternation. RELAY-27.
// One bounded for-loop — no recursion (CLAUDE.md §4). Seams (ModelClient, ToolRegistry)
// are interfaces so RELAY-28/29/73 slot in without rewriting this file.

import type { Sql } from "postgres";
import { assert } from "../core/assert.ts";
import type { Clock } from "../core/clock.ts";
import { err, ok, type Result } from "../core/result.ts";
import {
  idempotencyKey,
  idempotencyKeyForChildSession,
  idempotencyKeyToUuid,
} from "../core/idempotency.ts";
import {
  AgentId,
  Depth,
  EnvelopeId,
  SessionId as SessionIdParser,
  TurnId,
  mintId,
  type AgentId as AgentIdBrand,
  type ChainId as ChainIdBrand,
  type Depth as DepthBrand,
  type PendingSystemMessageId,
  type SessionId,
  type TenantId,
  type ToolUseId,
} from "../ids.ts";
import {
  Attr,
  GenAiAttr,
  GenAiEvent,
  SpanName,
  counter,
  emit,
  histogram,
  withSpan,
  type Attributes,
  type Counter,
} from "../telemetry/otel.ts";
import { MAX_GENAI_CONTENT_BYTES_PER_PART, truncateUtf8 } from "../telemetry/limits.ts";
import type { ModelClient, ToolSchema } from "./model.ts";
import { assertNever } from "../core/assert.ts";
import { MODEL_CALL_TIMEOUT_MS, MAX_TURNS_PER_SESSION, TOOL_CALL_TIMEOUT_MS } from "./limits.ts";
import type { ToolRegistry, ToolResult } from "./tools.ts";
import { insertTurn } from "./turn-persistence.ts";
import type {
  ContentBlock,
  Message,
  ModelResponse,
  ToolResultBlock,
  ToolUseBlock,
  Turn,
  TurnLoopError,
} from "./turn.ts";
import type {
  PostToolUsePayload,
  PreMessageSendPayload,
  PreToolUsePayload,
} from "../hook/payloads.ts";
import { HOOK_EVENT } from "../hook/types.ts";
import { runHooks } from "../hook/run.ts";
import { snapshotHookConfig, type HookConfigSnapshot } from "../hook/snapshot.ts";
import { drainPendingSystemMessages } from "../hook/pending.ts";
import { MAX_PENDING_MESSAGES_PER_TURN } from "../hook/limits.ts";
import {
  ASK_TOOL_NAME,
  NOTIFY_TOOL_NAME,
  parseAskInput,
  parseNotifyInput,
  builtinInlineError,
  builtinInlineToolResult,
  askToolSchema,
  notifyToolSchema,
} from "./builtin-tools.ts";
import { writeEnvelope } from "../trigger/envelope-ops.ts";
import { enqueue } from "../work_queue/queue-ops.ts";
import type { TriggerPayload } from "../trigger/payload.ts";
import { findOpenChildSession } from "./find-open-child.ts";
import { writePendingAsk } from "./pending-asks.ts";
import { MAX_MESSAGE_CONTENT_BYTES } from "../trigger/limits.ts";

export type PendingAsk = {
  readonly toolUseId: ToolUseId;
  readonly targetAgentId: AgentIdBrand;
  readonly content: string;
};

export type NotifyDispatch = {
  readonly toolUseId: ToolUseId;
  readonly targetAgentId: AgentIdBrand;
  readonly content: string;
};

export type TurnDispatchOutcome = {
  readonly toolResults: readonly ToolResultBlock[];
  readonly pendingAsks: readonly PendingAsk[];
  readonly notifies: readonly NotifyDispatch[];
};

// Tagged union return from runTurnLoop. Callers branch on `kind`.
export type LoopOutcome =
  | {
      readonly kind: "completed";
      readonly turns: readonly Turn[];
      readonly finalResponse: ModelResponse;
    }
  | {
      readonly kind: "suspended";
      readonly turns: readonly Turn[];
      readonly pendingAsks: readonly PendingAsk[];
    };

type LoopDeps = {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly model: ModelClient;
  readonly tools: ToolRegistry;
  readonly maxTurns?: number;
  readonly modelTimeoutMs?: number;
  readonly toolTimeoutMs?: number;
};

type LoopInput = {
  readonly sessionId: SessionId;
  readonly agentId: AgentIdBrand;
  readonly tenantId: TenantId;
  // Required when the session may call ask() — asserted in dispatchBoundarySends.
  readonly chainId?: ChainIdBrand;
  readonly depth?: DepthBrand;
  readonly systemPrompt: string;
  readonly initialMessages: readonly Message[];
  readonly startTurnIndex?: number; // first turn_index to write; defaults to 0 for fresh sessions
};

type OneTurnInput = {
  readonly index: number;
  readonly sessionId: SessionId;
  readonly agentId: AgentIdBrand;
  readonly tenantId: TenantId;
  readonly systemPrompt: string;
  readonly messages: readonly Message[];
  readonly toolSchemas: readonly ToolSchema[];
  readonly modelTimeoutMs: number;
  readonly toolTimeoutMs: number;
};

type TurnCtx = { sessionId: SessionId; agentId: AgentIdBrand; tenantId: TenantId; turnId: TurnId };

function isAbortTimeout(e: unknown): boolean {
  return e instanceof DOMException && e.name === "TimeoutError";
}

async function callModel(
  model: ModelClient,
  params: {
    readonly systemPrompt: string;
    readonly messages: readonly Message[];
    readonly toolSchemas: readonly ToolSchema[];
    readonly ctx: TurnCtx;
    readonly timeoutMs: number;
  },
): Promise<Result<ModelResponse, TurnLoopError>> {
  try {
    const signal = AbortSignal.timeout(params.timeoutMs);
    const response = await withSpan(
      SpanName.ModelCall,
      {
        [Attr.SessionId]: params.ctx.sessionId,
        [Attr.AgentId]: params.ctx.agentId,
        [Attr.TenantId]: params.ctx.tenantId,
        [Attr.TurnId]: params.ctx.turnId,
        [GenAiAttr.ConversationId]: params.ctx.sessionId,
      },
      () =>
        model.complete({
          systemPrompt: params.systemPrompt,
          messages: params.messages,
          tools: params.toolSchemas,
          signal,
        }),
    );
    return ok(response);
  } catch (e) {
    if (isAbortTimeout(e)) return err({ kind: "timeout", stage: "model" });
    return err({ kind: "model_call_failed", detail: (e as Error).message });
  }
}

async function invokeOneTool(
  tools: ToolRegistry,
  block: ToolUseBlock,
  ctx: TurnCtx,
  timeoutMs: number,
): Promise<ToolResult> {
  const signal = AbortSignal.timeout(timeoutMs);
  return withSpan(
    SpanName.ToolCall,
    {
      [Attr.ToolName]: block.name,
      [Attr.SessionId]: ctx.sessionId,
      [Attr.AgentId]: ctx.agentId,
      [Attr.TenantId]: ctx.tenantId,
      [Attr.TurnId]: ctx.turnId,
      [GenAiAttr.OperationName]: "execute_tool",
      [GenAiAttr.ToolName]: block.name,
      [GenAiAttr.ToolType]: "function",
      [GenAiAttr.ToolCallId]: block.id,
    },
    async (span) => {
      const argsT = truncateUtf8(JSON.stringify(block.input), MAX_GENAI_CONTENT_BYTES_PER_PART);
      span.addEvent(GenAiEvent.ToolCallArguments, {
        [GenAiAttr.ToolCallArguments]: argsT.text,
        ...(argsT.truncated ? { [GenAiAttr.ContentTruncated]: true } : {}),
      });
      const result = await tools.invoke({
        name: block.name,
        input: block.input,
        ctx: { ...ctx, toolUseId: block.id },
        signal,
      });
      const body = result.ok ? result.content : result.errorMessage;
      const bodyT = truncateUtf8(body, MAX_GENAI_CONTENT_BYTES_PER_PART);
      span.addEvent(GenAiEvent.ToolCallResult, {
        [GenAiAttr.ToolCallResult]: bodyT.text,
        [GenAiAttr.ToolCallIsError]: !result.ok,
        ...(bodyT.truncated ? { [GenAiAttr.ContentTruncated]: true } : {}),
      });
      return result;
    },
  );
}

async function dispatchOneBlock(
  tools: ToolRegistry,
  block: ToolUseBlock,
  ctx: TurnCtx,
  timeoutMs: number,
  toolAttrs: Attributes,
  toolCompletions: Counter,
  sql: Sql,
  clock: Clock,
  hookConfig: HookConfigSnapshot,
): Promise<Result<ToolResultBlock, TurnLoopError>> {
  const prePayload: PreToolUsePayload = {
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    tenantId: ctx.tenantId,
    turnId: ctx.turnId,
    toolUseId: block.id,
    toolName: block.name,
    toolInput: block.input,
  };
  const preDecision = await runHooks(
    sql,
    clock,
    hookConfig,
    {
      tenantId: ctx.tenantId,
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      toolName: block.name,
      event: HOOK_EVENT.PreToolUse,
    },
    prePayload,
  );

  if (preDecision.decision === "deny") {
    // Inline error tool_result per RELAY-135 design; pending message already enqueued.
    return ok({
      type: "tool_result",
      toolUseId: block.id,
      content: preDecision.reason,
      isError: true as const,
    });
  }

  const toolDurationHist = histogram(
    "relay.tool.invocation.duration",
    "Per-tool invocation wall time. Outcome ∈ {invoked, tool_error, timeout}.",
    "s",
  );
  const histAttrs = { ...toolAttrs, [GenAiAttr.ToolName]: block.name };

  const startedAt = performance.now();
  let toolResult: ToolResult;
  try {
    toolResult = await invokeOneTool(tools, block, ctx, timeoutMs);
  } catch (e) {
    const elapsedSec = (performance.now() - startedAt) / 1000;
    if (isAbortTimeout(e)) {
      toolDurationHist.record(elapsedSec, { ...histAttrs, [Attr.Outcome]: "timeout" });
      toolCompletions.add(1, { ...toolAttrs, [Attr.Outcome]: "timeout" });
      return err({ kind: "timeout", stage: "tool" });
    }
    throw e; // programmer error from tool invoker — propagate, lease expires
  }
  const elapsedSec = (performance.now() - startedAt) / 1000;
  toolDurationHist.record(elapsedSec, {
    ...histAttrs,
    [Attr.Outcome]: toolResult.ok ? "invoked" : "tool_error",
  });

  const postPayload: PostToolUsePayload = {
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    tenantId: ctx.tenantId,
    turnId: ctx.turnId,
    toolUseId: block.id,
    toolName: block.name,
    outcome: toolResult.ok ? "invoked" : "tool_error",
    toolResult: toolResult.ok
      ? { kind: "ok", content: toolResult.content }
      : { kind: "error", errorMessage: toolResult.errorMessage },
  };
  const postDecision = await runHooks(
    sql,
    clock,
    hookConfig,
    {
      tenantId: ctx.tenantId,
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      toolName: block.name,
      event: HOOK_EVENT.PostToolUse,
    },
    postPayload,
  );

  if (postDecision.decision === "deny") {
    // Post-tool-use deny: replace tool result with error. Pending message already enqueued.
    return ok({
      type: "tool_result",
      toolUseId: block.id,
      content: postDecision.reason,
      isError: true as const,
    });
  }

  toolCompletions.add(1, { ...toolAttrs, [Attr.Outcome]: "invoked" });
  return ok({
    type: "tool_result",
    toolUseId: block.id,
    content: toolResult.ok ? toolResult.content : toolResult.errorMessage,
    ...(toolResult.ok ? {} : { isError: true as const }),
  });
}

// Classify each tool_use block into regular, ask, or notify. Run PreMessageSend hook on
// ask/notify entries; deny → inline error (no suspend); modify → content rewritten.
// Returns a TurnDispatchOutcome with all three bucket lists populated.
async function dispatchTurn(
  tools: ToolRegistry,
  content: readonly ContentBlock[],
  toolSchemas: readonly ToolSchema[],
  ctx: TurnCtx,
  timeoutMs: number,
  sql: Sql,
  clock: Clock,
  hookConfig: HookConfigSnapshot,
): Promise<Result<TurnDispatchOutcome, TurnLoopError>> {
  const toolIterations = counter(
    "relay.tool.dispatch_iteration_total",
    "tool_use blocks dispatched within a turn.",
  );
  const toolCompletions = counter(
    "relay.tool.dispatch_completion_total",
    "Per tool_use outcome. relay.outcome ∈ {invoked, tool_unknown, timeout}.",
  );
  const sendDispatch = counter(
    "relay.send.dispatch_total",
    "Boundary sends dispatched. Attrs: relay.send.kind, relay.outcome.",
  );

  const available = new Set(toolSchemas.map((s) => s.name));
  const toolResults: ToolResultBlock[] = [];
  const pendingAsks: PendingAsk[] = [];
  const notifies: NotifyDispatch[] = [];

  for (const block of content) {
    if (block.type !== "tool_use") continue;

    const toolAttrs = {
      [Attr.SessionId]: ctx.sessionId,
      [Attr.AgentId]: ctx.agentId,
      [Attr.TenantId]: ctx.tenantId,
      [Attr.TurnId]: ctx.turnId,
      [Attr.ToolName]: block.name,
    };
    toolIterations.add(1, toolAttrs);

    if (block.name === ASK_TOOL_NAME || block.name === NOTIFY_TOOL_NAME) {
      const kind = block.name === ASK_TOOL_NAME ? "ask" : "notify";
      const parseResult =
        kind === "ask" ? parseAskInput(block.input) : parseNotifyInput(block.input);

      if (!parseResult.ok) {
        sendDispatch.add(1, { [Attr.SendKind]: kind, [Attr.Outcome]: "validation_failed" });
        toolResults.push(builtinInlineError(block.id, parseResult.error.reason));
        continue;
      }

      const parsed = parseResult.value;

      // Run PreMessageSend hook for this send.
      const iKey = idempotencyKey({
        writer: kind,
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        toolCallId: block.id,
      });

      const sendPayload: PreMessageSendPayload = {
        tenantId: ctx.tenantId,
        senderAgentId: ctx.agentId,
        senderSessionId: ctx.sessionId,
        turnId: ctx.turnId,
        target: { type: "agent", agentId: parsed.targetAgentId },
        kind,
        content: parsed.content,
        idempotencyKey: iKey,
      };

      const hookResult = await runHooks(
        sql,
        clock,
        hookConfig,
        {
          tenantId: ctx.tenantId,
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          toolName: block.name,
          event: HOOK_EVENT.PreMessageSend,
        },
        sendPayload,
      );

      if (hookResult.decision === "deny") {
        sendDispatch.add(1, { [Attr.SendKind]: kind, [Attr.Outcome]: "hook_denied" });
        toolResults.push(builtinInlineError(block.id, hookResult.reason));
        continue;
      }

      // Apply modify (content rewrite only in MVP).
      const finalContent =
        hookResult.decision === "modify" ? hookResult.payload.content : parsed.content;

      if (kind === "ask") {
        pendingAsks.push({
          toolUseId: block.id,
          targetAgentId: parsed.targetAgentId,
          content: finalContent,
        });
        sendDispatch.add(1, { [Attr.SendKind]: "ask", [Attr.Outcome]: "dispatched" });
      } else {
        notifies.push({
          toolUseId: block.id,
          targetAgentId: parsed.targetAgentId,
          content: finalContent,
        });
        // Synthetic tool_result so the assistant message's tool_use is paired immediately.
        toolResults.push({
          type: "tool_result",
          toolUseId: block.id,
          content: "<dispatched>",
        });
        sendDispatch.add(1, { [Attr.SendKind]: "notify", [Attr.Outcome]: "dispatched" });
      }
      continue;
    }

    if (!available.has(block.name)) {
      toolCompletions.add(1, { ...toolAttrs, [Attr.Outcome]: "tool_unknown" });
      return err({ kind: "tool_unknown", toolName: block.name });
    }

    const r = await dispatchOneBlock(
      tools,
      block,
      ctx,
      timeoutMs,
      toolAttrs,
      toolCompletions,
      sql,
      clock,
      hookConfig,
    );
    if (!r.ok) return r;
    toolResults.push(r.value);
  }

  return ok({ toolResults, pendingAsks, notifies });
}

// Derive a deterministic child session id from (parentSessionId, targetAgentId).
// Pure — no DB call. Caller is responsible for the prior findOpenChildSession lookup.
function deriveChildSessionId(ctx: TurnCtx, targetAgentId: AgentIdBrand): SessionId {
  const childKey = idempotencyKeyForChildSession({
    parentSessionId: ctx.sessionId,
    targetAgentId,
  });
  const childIdStr = idempotencyKeyToUuid(childKey);
  const childIdResult = SessionIdParser.parse(childIdStr);
  assert(childIdResult.ok, "deriveChildSessionId: invalid derived child session UUID");
  return childIdResult.value;
}

// Emit envelope + session_start work item for a single ask or notify dispatch.
// For asks: also writes the pending-ask ledger row.
// For child reuse (open child found): sends inbound_message instead of session_start.
async function dispatchOneAskOrNotify(
  sql: Sql,
  ctx: TurnCtx,
  chainId: ChainIdBrand,
  depth: DepthBrand,
  dispatch: (PendingAsk & { isAsk: true }) | (NotifyDispatch & { isAsk: false }),
  childSessionId: SessionId,
  now: Date,
  isExistingChild: boolean,
): Promise<Result<void, TurnLoopError>> {
  const envelopeIKey = idempotencyKey({
    writer: dispatch.isAsk ? "ask" : "notify",
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    toolCallId: dispatch.toolUseId,
  });
  const envelopeIdStr = idempotencyKeyToUuid(envelopeIKey);
  const envelopeIdResult = EnvelopeId.parse(envelopeIdStr);
  assert(envelopeIdResult.ok, "dispatchOneAskOrNotify: invalid envelope UUID");

  const payload: TriggerPayload = {
    kind: "message",
    sender: { type: "agent", id: ctx.agentId },
    targetAgentId: dispatch.targetAgentId,
    content: dispatch.content,
    receivedAt: now,
    parentSessionId: ctx.sessionId,
    parentChainId: chainId,
    parentDepth: depth,
    childSessionId,
    ...(dispatch.isAsk ? { parentToolUseId: dispatch.toolUseId } : {}),
  };

  const envelopeResult = await writeEnvelope(sql, ctx.tenantId, "message", payload, {
    explicitId: envelopeIdResult.value,
  });
  if (!envelopeResult.ok) {
    return err({
      kind: "dispatch_failed",
      detail: `writeEnvelope failed: ${envelopeResult.error.kind}`,
    });
  }

  // Ledger write before enqueue: if the process crashes between the two, the retry
  // re-enqueues; if it crashed after enqueue with no ledger row there is no safe recovery.
  if (dispatch.isAsk) {
    await writePendingAsk(sql, {
      tenantId: ctx.tenantId,
      parentSessionId: ctx.sessionId,
      childSessionId,
      parentToolUseId: dispatch.toolUseId,
    });
  }

  const workKind = isExistingChild ? "inbound_message" : "session_start";
  const workResult = await enqueue(sql, {
    tenantId: ctx.tenantId,
    kind: workKind,
    payloadRef: envelopeResult.value,
    scheduledAt: now,
  });
  if (!workResult.ok) {
    return err({ kind: "dispatch_failed", detail: `enqueue failed: ${workResult.error.kind}` });
  }

  return ok(undefined);
}

// Anthropic API contract: every tool_use block must be paired with a tool_result.
// Folding N>1 asks into one carrier requires synthetic tool_results for asks 2..N.
type ConcentratedAsks = {
  readonly asks: readonly PendingAsk[];
  readonly syntheticToolResults: readonly ToolResultBlock[];
};

function concentrateDuplicateAsks(
  asks: readonly PendingAsk[],
): Result<ConcentratedAsks, TurnLoopError> {
  const groups = new Map<AgentIdBrand, PendingAsk[]>();
  const order: AgentIdBrand[] = [];
  for (const a of asks) {
    const existing = groups.get(a.targetAgentId);
    if (existing !== undefined) {
      existing.push(a);
    } else {
      groups.set(a.targetAgentId, [a]);
      order.push(a.targetAgentId);
    }
  }

  const out: PendingAsk[] = [];
  const synthetics: ToolResultBlock[] = [];

  for (const target of order) {
    const group = groups.get(target);
    assert(group !== undefined && group.length > 0, "concentrateDuplicateAsks: missing group");
    if (group.length === 1) {
      const only = group[0];
      assert(only !== undefined, "concentrateDuplicateAsks: group[0] must exist");
      out.push(only);
      continue;
    }

    counter(
      "relay.session.duplicate_ask_concentrated_total",
      "Bumped once per concentrated ask group.",
    ).add(1);

    const first = group[0];
    assert(first !== undefined, "concentrateDuplicateAsks: first must exist");
    const merged = group.map((a, i) => `${(i + 1).toString()}. ${a.content}`).join("\n\n");
    if (Buffer.byteLength(merged, "utf8") > MAX_MESSAGE_CONTENT_BYTES) {
      return err({ kind: "dispatch_failed", detail: "concentrated_content_too_large" });
    }
    out.push({ toolUseId: first.toolUseId, targetAgentId: first.targetAgentId, content: merged });
    for (let i = 1; i < group.length; i++) {
      const dup = group[i];
      assert(dup !== undefined, "concentrateDuplicateAsks: dup must exist");
      synthetics.push(
        builtinInlineToolResult(dup.toolUseId, `<merged into ${first.toolUseId as string}>`),
      );
    }
  }

  return ok({ asks: out, syntheticToolResults: synthetics });
}

type DispatchBoundaryOutcome = {
  readonly syntheticToolResults: readonly ToolResultBlock[];
};

// Resolve the child session for one dispatch slot, reusing when possible. Updates
// `seenTargets` so subsequent same-target sends in this batch route via inbound_message.
// Bumps reuse/create counters with low-cardinality attributes.
async function resolveChildForDispatch(
  sql: Sql,
  ctx: TurnCtx,
  targetAgentId: AgentIdBrand,
  kind: "ask" | "notify",
  seenTargets: Map<AgentIdBrand, SessionId>,
): Promise<{ childSessionId: SessionId; isExistingChild: boolean }> {
  const inBatch = seenTargets.get(targetAgentId);
  if (inBatch !== undefined) {
    counter(
      "relay.session.child_reused_total",
      "Bumped when a dispatch routes via inbound_message because of an existing-or-just-derived child.",
    ).add(1, { [Attr.SendKind]: kind, [Attr.ReuseScope]: "in_batch" });
    return { childSessionId: inBatch, isExistingChild: true };
  }

  const existing = await findOpenChildSession(sql, {
    parentSessionId: ctx.sessionId,
    targetAgentId,
    tenantId: ctx.tenantId,
  });
  if (existing !== null) {
    counter("relay.session.child_reused_total").add(1, {
      [Attr.SendKind]: kind,
      [Attr.ReuseScope]: "cross_turn",
    });
    seenTargets.set(targetAgentId, existing.childSessionId);
    return { childSessionId: existing.childSessionId, isExistingChild: true };
  }

  const derived = deriveChildSessionId(ctx, targetAgentId);
  counter(
    "relay.session.child_created_total",
    "Bumped when a dispatch creates a fresh child via session_start.",
  ).add(1, { [Attr.SendKind]: kind });
  seenTargets.set(targetAgentId, derived);
  return { childSessionId: derived, isExistingChild: false };
}

// Dispatch all boundary sends (asks + notifies) for a turn. Two phases:
//  1. concentrateDuplicateAsks: merge per-target ask duplicates into one envelope each
//     and emit synthetic immediate tool_results for the merged-away asks.
//  2. in-batch dedup: across both kinds, the first send to a target creates/finds the
//     child; subsequent same-target sends route via inbound_message.
// Returns the synthetic tool_results so the caller can append them to the persisted turn.
async function dispatchBoundarySends(
  sql: Sql,
  clock: Clock,
  ctx: TurnCtx,
  chainId: ChainIdBrand,
  depth: DepthBrand,
  asks: readonly PendingAsk[],
  notifies: readonly NotifyDispatch[],
): Promise<Result<DispatchBoundaryOutcome, TurnLoopError>> {
  assert(
    (depth as number) >= 0,
    "dispatchBoundarySends: depth must be provided when asks are present",
  );
  if (!Depth.parse((depth as number) + 1).ok) {
    return err({ kind: "dispatch_failed", detail: "depth cap exceeded on child session" });
  }

  const agentIdCheck = AgentId.parse(ctx.agentId);
  assert(agentIdCheck.ok, "dispatchBoundarySends: ctx.agentId is invalid");

  const concentrated = concentrateDuplicateAsks(asks);
  if (!concentrated.ok) return concentrated;

  const now = new Date(clock.now());

  type AnyDispatch = (PendingAsk & { isAsk: true }) | (NotifyDispatch & { isAsk: false });
  const all: AnyDispatch[] = [
    ...concentrated.value.asks.map((a) => ({ ...a, isAsk: true as const })),
    ...notifies.map((n) => ({ ...n, isAsk: false as const })),
  ];

  const seenTargets = new Map<AgentIdBrand, SessionId>();

  for (const dispatch of all) {
    const { childSessionId, isExistingChild } = await resolveChildForDispatch(
      sql,
      ctx,
      dispatch.targetAgentId,
      dispatch.isAsk ? "ask" : "notify",
      seenTargets,
    );
    const r = await dispatchOneAskOrNotify(
      sql,
      ctx,
      chainId,
      depth,
      dispatch,
      childSessionId,
      now,
      isExistingChild,
    );
    if (!r.ok) return r;
  }

  return ok({ syntheticToolResults: concentrated.value.syntheticToolResults });
}

type OneTurnResult = { readonly turn: Turn; readonly dispatchOutcome: TurnDispatchOutcome };

async function runOneTurn(
  deps: { model: ModelClient; tools: ToolRegistry; clock: Clock; sql: Sql },
  input: OneTurnInput,
): Promise<Result<OneTurnResult, TurnLoopError>> {
  const turnId = mintId(TurnId.parse, "runOneTurn");
  const ctx: TurnCtx = {
    sessionId: input.sessionId,
    agentId: input.agentId,
    tenantId: input.tenantId,
    turnId,
  };

  return withSpan(
    SpanName.SessionTurn,
    {
      [Attr.SessionId]: ctx.sessionId,
      [Attr.AgentId]: ctx.agentId,
      [Attr.TenantId]: ctx.tenantId,
      [Attr.TurnId]: ctx.turnId,
    },
    async () => {
      const startedAt = new Date(deps.clock.now());
      // Snapshot hook config once per turn. All runHooks calls within this turn read from this
      // snapshot — mid-turn registry mutations are invisible. SPEC §Hooks: "Hook config pins at
      // turn start." runTurnLoop does NOT snapshot; each runOneTurn iteration takes its own.
      const hookConfig = snapshotHookConfig(deps.clock);

      const modelResult = await callModel(deps.model, {
        systemPrompt: input.systemPrompt,
        messages: input.messages,
        toolSchemas: input.toolSchemas,
        ctx,
        timeoutMs: input.modelTimeoutMs,
      });
      if (!modelResult.ok) return modelResult;

      const response = modelResult.value;

      const dispatchResult = await dispatchTurn(
        deps.tools,
        response.content,
        input.toolSchemas,
        ctx,
        input.toolTimeoutMs,
        deps.sql,
        deps.clock,
        hookConfig,
      );
      if (!dispatchResult.ok) return dispatchResult;

      const completedAt = new Date(deps.clock.now());
      const turn: Turn = {
        id: turnId,
        index: input.index,
        startedAt,
        completedAt,
        response,
        // toolResults: regular + notify-synthetic + inline-error; NOT ask slots (filled on resume).
        toolResults: dispatchResult.value.toolResults,
      };
      return ok({ turn, dispatchOutcome: dispatchResult.value });
    },
  );
}

export async function runTurnLoop(
  deps: LoopDeps,
  input: LoopInput,
): Promise<Result<LoopOutcome, TurnLoopError>> {
  assert(input.systemPrompt.length > 0, "runTurnLoop: systemPrompt must be non-empty");
  assert(input.initialMessages.length > 0, "runTurnLoop: initialMessages must be non-empty");

  const startTurnIndex = input.startTurnIndex ?? 0;
  assert(startTurnIndex >= 0, "runTurnLoop: startTurnIndex must be non-negative", {
    startTurnIndex,
  });
  const rawCap = deps.maxTurns ?? MAX_TURNS_PER_SESSION;
  assert(rawCap > 0 && rawCap <= MAX_TURNS_PER_SESSION, "runTurnLoop: cap out of valid range", {
    rawCap,
  });
  const cap = Math.max(0, rawCap - startTurnIndex);

  const modelTimeoutMs = deps.modelTimeoutMs ?? MODEL_CALL_TIMEOUT_MS;
  const toolTimeoutMs = deps.toolTimeoutMs ?? TOOL_CALL_TIMEOUT_MS;
  const messages: Message[] = [...input.initialMessages];
  const turns: Turn[] = [];
  const toolSchemas = [...deps.tools.list(), askToolSchema, notifyToolSchema];

  const turnIterations = counter(
    "relay.turn_loop.iteration_total",
    "Turn-loop body executions. Rate = per-session model-call frequency.",
  );
  const turnCompletions = counter(
    "relay.turn_loop.completion_total",
    "Turn-loop exits. Attribute relay.outcome ∈ {end_turn, cap_exceeded, model_error, tool_error, persist_error, suspended}.",
  );
  const baseAttrs = {
    [Attr.SessionId]: input.sessionId,
    [Attr.AgentId]: input.agentId,
    [Attr.TenantId]: input.tenantId,
  };

  for (let i = 0; i < cap; i++) {
    turnIterations.add(1, baseAttrs);

    // Drain undrained pending system messages and prepend them to this turn's input.
    const drainResult = await drainPendingSystemMessages(deps.sql, {
      targetSessionId: input.sessionId,
      tenantId: input.tenantId,
    });
    assert(drainResult.ok, "runTurnLoop: drain pending messages failed");
    const drained = drainResult.value;
    assert(drained.length <= MAX_PENDING_MESSAGES_PER_TURN, "runTurnLoop: drained more than cap", {
      count: drained.length,
    });

    const drainedIds: PendingSystemMessageId[] = drained.map((row) => row.id);
    if (drained.length > 0) {
      // drained is ordered by created_at; unshift preserves that order in messages.
      messages.unshift(
        ...drained.map((row) => ({
          role: "system_synthetic" as const,
          content: [{ type: "text" as const, text: row.content }],
        })),
      );
    }

    if (drained.length > 0) {
      counter("relay.hook.pending_message_drained_total").add(drained.length, {
        [Attr.TenantId]: input.tenantId,
      });
      emit("INFO", "hook.pending_drained", {
        [Attr.SessionId]: input.sessionId,
        count: drained.length,
      });
    }

    const turnResult = await runOneTurn(
      { model: deps.model, tools: deps.tools, clock: deps.clock, sql: deps.sql },
      {
        index: startTurnIndex + i,
        sessionId: input.sessionId,
        agentId: input.agentId,
        tenantId: input.tenantId,
        systemPrompt: input.systemPrompt,
        messages,
        toolSchemas,
        modelTimeoutMs,
        toolTimeoutMs,
      },
    );
    if (!turnResult.ok) {
      turnCompletions.add(1, {
        ...baseAttrs,
        [Attr.Outcome]: outcomeFromTurnLoopError(turnResult.error),
      });
      return turnResult;
    }

    const { turn: rawTurn, dispatchOutcome } = turnResult.value;

    // Boundary dispatch runs BEFORE persistence so that any synthetic tool_results
    // produced by ask-concentration land on the persisted turn. External
    // writes (envelopes, work items, pending_asks) are idempotent: on persistence
    // failure the worker's retry replays the model call and rewriters short-circuit
    // on existing rows, so the "persist after send" reordering does not double-fan-out.
    let synthetics: readonly ToolResultBlock[] = [];
    if (dispatchOutcome.pendingAsks.length > 0 || dispatchOutcome.notifies.length > 0) {
      const dispatchErr = await withSpan(
        SpanName.BoundaryDispatch,
        {
          [Attr.SessionId]: input.sessionId,
          [Attr.TurnId]: rawTurn.id,
          [Attr.SendCount]: dispatchOutcome.pendingAsks.length + dispatchOutcome.notifies.length,
        },
        async () => {
          const ctx: TurnCtx = {
            sessionId: input.sessionId,
            agentId: input.agentId,
            tenantId: input.tenantId,
            turnId: rawTurn.id,
          };
          assert(
            input.chainId !== undefined && input.depth !== undefined,
            "runTurnLoop: chainId and depth required when boundary dispatch occurs",
          );
          return dispatchBoundarySends(
            deps.sql,
            deps.clock,
            ctx,
            input.chainId,
            input.depth,
            dispatchOutcome.pendingAsks,
            dispatchOutcome.notifies,
          );
        },
      );
      if (!dispatchErr.ok) {
        turnCompletions.add(1, { ...baseAttrs, [Attr.Outcome]: "dispatch_error" });
        return dispatchErr;
      }
      synthetics = dispatchErr.value.syntheticToolResults;
    }

    const turn: Turn =
      synthetics.length === 0
        ? rawTurn
        : { ...rawTurn, toolResults: [...rawTurn.toolResults, ...synthetics] };
    turns.push(turn);

    const saved = await insertTurn(deps.sql, {
      turn,
      sessionId: input.sessionId,
      tenantId: input.tenantId,
      agentId: input.agentId,
      drainedPendingIds: drainedIds,
    });
    if (!saved.ok) {
      turnCompletions.add(1, { ...baseAttrs, [Attr.Outcome]: "persist_error" });
      return saved;
    }

    // Suspend if any asks are pending — skip pushing tool_results into messages.
    if (dispatchOutcome.pendingAsks.length > 0) {
      turnCompletions.add(1, { ...baseAttrs, [Attr.Outcome]: "suspended" });
      return ok({ kind: "suspended", turns, pendingAsks: dispatchOutcome.pendingAsks });
    }

    messages.push({ role: "assistant", content: turn.response.content });
    if (turn.toolResults.length > 0) {
      messages.push({ role: "user", content: turn.toolResults });
    }

    switch (turn.response.stopReason) {
      case "end_turn":
        turnCompletions.add(1, { ...baseAttrs, [Attr.Outcome]: "end_turn" });
        return ok({ kind: "completed", turns, finalResponse: turn.response });
      case "tool_use":
      case "max_tokens":
      case "stop_sequence":
      // intentional fallthrough: continue loop
      case "pause_turn":
      case "refusal":
        break;
      default:
        assertNever(turn.response.stopReason, "runTurnLoop: unhandled StopReason");
    }
  }

  turnCompletions.add(1, { ...baseAttrs, [Attr.Outcome]: "cap_exceeded" });
  return err({ kind: "turn_cap_exceeded", max: cap });
}

function outcomeFromTurnLoopError(e: TurnLoopError): string {
  switch (e.kind) {
    case "model_call_failed":
      return "model_error";
    case "tool_invocation_failed":
    case "tool_unknown":
      return "tool_error";
    case "timeout":
      return e.stage === "model" ? "model_error" : "tool_error";
    case "turn_cap_exceeded":
      return "cap_exceeded";
    case "persist_turn_failed":
      return "persist_error";
    case "dispatch_failed":
      return "dispatch_error";
  }
}
