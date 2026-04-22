// Agentic loop: model call + tool call alternation. RELAY-27.
// One bounded for-loop — no recursion (CLAUDE.md §4). Seams (ModelClient, ToolRegistry)
// are interfaces so RELAY-28/29/73 slot in without rewriting this file.

import type { Sql } from "postgres";
import { assert } from "../core/assert.ts";
import type { Clock } from "../core/clock.ts";
import { err, ok, type Result } from "../core/result.ts";
import type { AgentId, SessionId, TenantId } from "../ids.ts";
import { TurnId, mintId } from "../ids.ts";
import { Attr, SpanName, withSpan } from "../telemetry/otel.ts";
import type { ModelClient, ToolSchema } from "./model.ts";
import { MODEL_CALL_TIMEOUT_MS, MAX_TURNS_PER_SESSION, TOOL_CALL_TIMEOUT_MS } from "./limits.ts";
import type { ToolRegistry, ToolResult } from "./tools.ts";
import { insertTurn } from "./turn-persistence.ts";
import type {
  ContentBlock,
  Message,
  ModelResponse,
  ToolResultBlock,
  Turn,
  TurnLoopError,
} from "./turn.ts";

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

async function dispatchTools(
  tools: ToolRegistry,
  content: readonly ContentBlock[],
  toolSchemas: readonly ToolSchema[],
  ctx: TurnCtx,
  timeoutMs: number,
): Promise<Result<readonly ToolResultBlock[], TurnLoopError>> {
  const available = new Set(toolSchemas.map((s) => s.name));
  const results: ToolResultBlock[] = [];

  for (const block of content) {
    if (block.type !== "tool_use") continue;
    if (!available.has(block.name)) {
      return err({ kind: "tool_unknown", toolName: block.name });
    }

    let toolResult: ToolResult;
    try {
      toolResult = await invokeOneTool(tools, block, ctx, timeoutMs);
    } catch (e) {
      if (isAbortTimeout(e)) return err({ kind: "timeout", stage: "tool" });
      throw e; // programmer error from tool invoker — propagate, lease expires
    }

    results.push({
      type: "tool_result",
      toolUseId: block.id,
      content: toolResult.ok ? toolResult.content : toolResult.errorMessage,
      ...(toolResult.ok ? {} : { isError: true as const }),
    });
  }

  return ok(results);
}

async function runOneTurn(
  deps: { model: ModelClient; tools: ToolRegistry; clock: Clock },
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

  for (let i = 0; i < cap; i++) {
    const turnResult = await runOneTurn(
      { model: deps.model, tools: deps.tools, clock: deps.clock },
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
    if (!turnResult.ok) return turnResult;

    const turn = turnResult.value;
    turns.push(turn);

    const saved = await insertTurn(deps.sql, {
      turn,
      sessionId: input.sessionId,
      tenantId: input.tenantId,
      agentId: input.agentId,
    });
    if (!saved.ok) return saved;

    messages.push({ role: "assistant", content: turn.response.content });
    if (turn.toolResults.length > 0) {
      messages.push({ role: "user", content: turn.toolResults });
    }

    if (turn.response.stopReason === "end_turn") {
      return ok({ turns, finalResponse: turn.response });
    }
  }

  return err({ kind: "turn_cap_exceeded", max: cap });
}
