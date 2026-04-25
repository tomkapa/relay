// Agentic loop: model call + tool call alternation. RELAY-27.
// One bounded for-loop — no recursion (CLAUDE.md §4). Seams (ModelClient, ToolRegistry)
// are interfaces so RELAY-28/29/73 slot in without rewriting this file.

import type { Sql } from "postgres";
import { assert } from "../core/assert.ts";
import type { Clock } from "../core/clock.ts";
import { err, ok, type Result } from "../core/result.ts";
import type { AgentId, PendingSystemMessageId, SessionId, TenantId } from "../ids.ts";
import { TurnId, mintId } from "../ids.ts";
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
import type { PostToolUsePayload, PreToolUsePayload } from "../hook/types.ts";
import { HOOK_EVENT } from "../hook/types.ts";
import { runHooks } from "../hook/run.ts";
import { drainPendingSystemMessages } from "../hook/pending.ts";
import { MAX_PENDING_MESSAGES_PER_TURN } from "../hook/limits.ts";

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
  readonly agentId: AgentId;
  readonly tenantId: TenantId;
  readonly systemPrompt: string;
  readonly initialMessages: readonly Message[];
};

type OneTurnInput = {
  readonly index: number;
  readonly sessionId: SessionId;
  readonly agentId: AgentId;
  readonly tenantId: TenantId;
  readonly systemPrompt: string;
  readonly messages: readonly Message[];
  readonly toolSchemas: readonly ToolSchema[];
  readonly modelTimeoutMs: number;
  readonly toolTimeoutMs: number;
};

type TurnCtx = { sessionId: SessionId; agentId: AgentId; tenantId: TenantId; turnId: TurnId };

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
  const preDecision = await runHooks<PreToolUsePayload>(
    sql,
    clock,
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
  };
  const postDecision = await runHooks<PostToolUsePayload>(
    sql,
    clock,
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

async function dispatchTools(
  tools: ToolRegistry,
  content: readonly ContentBlock[],
  toolSchemas: readonly ToolSchema[],
  ctx: TurnCtx,
  timeoutMs: number,
  sql: Sql,
  clock: Clock,
): Promise<Result<readonly ToolResultBlock[], TurnLoopError>> {
  const toolIterations = counter(
    "relay.tool.dispatch_iteration_total",
    "tool_use blocks dispatched within a turn.",
  );
  const toolCompletions = counter(
    "relay.tool.dispatch_completion_total",
    "Per tool_use outcome. relay.outcome ∈ {invoked, tool_unknown, timeout}.",
  );

  const available = new Set(toolSchemas.map((s) => s.name));
  const results: ToolResultBlock[] = [];

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
    );
    if (!r.ok) return r;
    results.push(r.value);
  }

  return ok(results);
}

async function runOneTurn(
  deps: { model: ModelClient; tools: ToolRegistry; clock: Clock; sql: Sql },
  input: OneTurnInput,
): Promise<Result<Turn, TurnLoopError>> {
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

      const modelResult = await callModel(deps.model, {
        systemPrompt: input.systemPrompt,
        messages: input.messages,
        toolSchemas: input.toolSchemas,
        ctx,
        timeoutMs: input.modelTimeoutMs,
      });
      if (!modelResult.ok) return modelResult;

      const response = modelResult.value;

      const toolsResult = await dispatchTools(
        deps.tools,
        response.content,
        input.toolSchemas,
        ctx,
        input.toolTimeoutMs,
        deps.sql,
        deps.clock,
      );
      if (!toolsResult.ok) return toolsResult;

      const completedAt = new Date(deps.clock.now());

      return ok({
        id: turnId,
        index: input.index,
        startedAt,
        completedAt,
        response,
        toolResults: toolsResult.value,
      });
    },
  );
}

export async function runTurnLoop(
  deps: LoopDeps,
  input: LoopInput,
): Promise<Result<{ turns: readonly Turn[]; finalResponse: ModelResponse }, TurnLoopError>> {
  assert(input.systemPrompt.length > 0, "runTurnLoop: systemPrompt must be non-empty");
  assert(input.initialMessages.length > 0, "runTurnLoop: initialMessages must be non-empty");

  const cap = deps.maxTurns ?? MAX_TURNS_PER_SESSION;
  assert(cap > 0 && cap <= MAX_TURNS_PER_SESSION, "runTurnLoop: cap out of valid range", { cap });

  const modelTimeoutMs = deps.modelTimeoutMs ?? MODEL_CALL_TIMEOUT_MS;
  const toolTimeoutMs = deps.toolTimeoutMs ?? TOOL_CALL_TIMEOUT_MS;
  const messages: Message[] = [...input.initialMessages];
  const turns: Turn[] = [];
  const toolSchemas = deps.tools.list();

  const turnIterations = counter(
    "relay.turn_loop.iteration_total",
    "Turn-loop body executions. Rate = per-session model-call frequency.",
  );
  const turnCompletions = counter(
    "relay.turn_loop.completion_total",
    "Turn-loop exits. Attribute relay.outcome ∈ {end_turn, cap_exceeded, model_error, tool_error, persist_error}.",
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
        index: i,
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

    const turn = turnResult.value;
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

    messages.push({ role: "assistant", content: turn.response.content });
    if (turn.toolResults.length > 0) {
      messages.push({ role: "user", content: turn.toolResults });
    }

    switch (turn.response.stopReason) {
      case "end_turn":
        turnCompletions.add(1, { ...baseAttrs, [Attr.Outcome]: "end_turn" });
        return ok({ turns, finalResponse: turn.response });
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
  }
}
