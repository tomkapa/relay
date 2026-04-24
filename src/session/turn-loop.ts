// Agentic loop: model call + tool call alternation. RELAY-27.
// One bounded for-loop — no recursion (CLAUDE.md §4). Seams (ModelClient, ToolRegistry)
// are interfaces so RELAY-28/29/73 slot in without rewriting this file.

import type { Sql } from "postgres";
import { assert } from "../core/assert.ts";
import type { Clock } from "../core/clock.ts";
import { err, ok, type Result } from "../core/result.ts";
import type { AgentId, SessionId, TenantId } from "../ids.ts";
import { TurnId, mintId } from "../ids.ts";
import {
  Attr,
  SpanName,
  counter,
  withSpan,
  type Attributes,
  type Counter,
} from "../telemetry/otel.ts";
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
import type { HookResult, HookSeams } from "../hook/types.ts";
import { preToolUseStub, postToolUseStub } from "../hook/stubs.ts";

type LoopDeps = {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly model: ModelClient;
  readonly tools: ToolRegistry;
  readonly hooks?: HookSeams;
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
  block: { id: string; name: string; input: Readonly<Record<string, unknown>> },
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
    },
    () =>
      tools.invoke({
        name: block.name,
        input: block.input,
        ctx: { ...ctx, toolUseId: block.id },
        signal,
      }),
  );
}

async function callHookSeam(
  hookAttrs: Attributes,
  hookFn: () => Promise<HookResult>,
  evals: Counter,
  assertMsg: string,
): Promise<void> {
  const result = await withSpan(SpanName.HookEvaluate, hookAttrs, hookFn);
  evals.add(1, {
    ...hookAttrs,
    [Attr.HookDecision]: result.decision,
    [Attr.HookLayer]: "system",
  });
  assert(result.decision === "approve", assertMsg);
}

async function dispatchOneBlock(
  tools: ToolRegistry,
  block: ToolUseBlock,
  ctx: TurnCtx,
  timeoutMs: number,
  hooks: HookSeams,
  toolAttrs: Attributes,
  toolCompletions: Counter,
  hookEvaluations: Counter,
): Promise<Result<ToolResultBlock, TurnLoopError>> {
  await callHookSeam(
    { ...toolAttrs, [Attr.HookEvent]: "pre_tool_use" },
    () =>
      hooks.preToolUse({
        ...ctx,
        toolUseId: block.id,
        toolName: block.name,
        toolInput: block.input,
      }),
    hookEvaluations,
    "dispatchTools: pre-tool-use stub must approve — deny arrives with RELAY-138",
  );

  let toolResult: ToolResult;
  try {
    toolResult = await invokeOneTool(tools, block, ctx, timeoutMs);
  } catch (e) {
    if (isAbortTimeout(e)) {
      toolCompletions.add(1, { ...toolAttrs, [Attr.Outcome]: "timeout" });
      return err({ kind: "timeout", stage: "tool" });
    }
    throw e; // programmer error from tool invoker — propagate, lease expires
  }

  await callHookSeam(
    { ...toolAttrs, [Attr.HookEvent]: "post_tool_use" },
    () =>
      hooks.postToolUse({
        ...ctx,
        toolUseId: block.id,
        toolName: block.name,
        outcome: toolResult.ok ? "invoked" : "tool_error",
      }),
    hookEvaluations,
    "dispatchTools: post-tool-use stub must approve — deny arrives with RELAY-138",
  );

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
  hooks: HookSeams,
): Promise<Result<readonly ToolResultBlock[], TurnLoopError>> {
  const toolIterations = counter(
    "relay.tool.dispatch_iteration_total",
    "tool_use blocks dispatched within a turn.",
  );
  const toolCompletions = counter(
    "relay.tool.dispatch_completion_total",
    "Per tool_use outcome. relay.outcome ∈ {invoked, tool_unknown, timeout}.",
  );
  const hookEvaluations = counter(
    "relay.hook.evaluation_total",
    "Hook evaluations per lifecycle event. relay.hook.event ∈ {pre_tool_use, post_tool_use}.",
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
      hooks,
      toolAttrs,
      toolCompletions,
      hookEvaluations,
    );
    if (!r.ok) return r;
    results.push(r.value);
  }

  return ok(results);
}

async function runOneTurn(
  deps: { model: ModelClient; tools: ToolRegistry; clock: Clock; hooks: HookSeams },
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
        deps.hooks,
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
  const hooks: HookSeams = deps.hooks ?? {
    preToolUse: preToolUseStub,
    postToolUse: postToolUseStub,
  };
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

    const turnResult = await runOneTurn(
      { model: deps.model, tools: deps.tools, clock: deps.clock, hooks },
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
