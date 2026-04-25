// GenAI-specific instrumentation tests for the turn loop: tool.call span attrs,
// tool args/result events, per-tool duration histogram, and gen_ai.conversation.id
// on the model.call span. The broader turn-loop behavior is covered by turn-loop.test.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { FakeClock } from "../../../src/core/clock.ts";
import { assert } from "../../../src/core/assert.ts";
import {
  AgentId as AgentIdParser,
  SessionId as SessionIdParser,
  TenantId as TenantIdParser,
  ToolUseId,
} from "../../../src/ids.ts";
import type { AgentId, SessionId, TenantId } from "../../../src/ids.ts";
import type { ModelClient } from "../../../src/session/model.ts";
import type { Message, ModelResponse, ToolUseBlock } from "../../../src/session/turn.ts";
import { InMemoryToolRegistry, echoTool } from "../../../src/session/tools-inmemory.ts";
import { runTurnLoop } from "../../../src/session/turn-loop.ts";
import { GenAiAttr, GenAiEvent, SpanName } from "../../../src/telemetry/otel.ts";
import { installSpanFixture, uninstallSpanFixture, type SpanFixture } from "../../helpers/spans.ts";
import {
  histogramCount,
  installMetricFixture,
  uninstallMetricFixture,
  type MetricFixture,
} from "../../helpers/metrics.ts";
import { makeFakeSql } from "../../helpers/fake-sql.ts";

function makeIds(): { sessionId: SessionId; agentId: AgentId; tenantId: TenantId } {
  const s = SessionIdParser.parse(randomUUID());
  const a = AgentIdParser.parse(randomUUID());
  const t = TenantIdParser.parse(randomUUID());
  assert(s.ok && a.ok && t.ok, "makeIds: invalid ids");
  return { sessionId: s.value, agentId: a.value, tenantId: t.value };
}

function textResponse(text: string): ModelResponse {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

function toolUseBlock(id: string, name: string, input: Record<string, unknown>): ToolUseBlock {
  const p = ToolUseId.parse(id);
  assert(p.ok, "toolUseBlock: invalid id");
  return { type: "tool_use", id: p.value, name, input };
}

function toolUseResponse(id: string, name: string, input: Record<string, unknown>): ModelResponse {
  return {
    content: [toolUseBlock(id, name, input)],
    stopReason: "tool_use",
    usage: { inputTokens: 5, outputTokens: 2 },
  };
}

const baseInput: Message[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }];

describe("turn-loop GenAI instrumentation", () => {
  let spans: SpanFixture;
  let metrics: MetricFixture;
  let clock: FakeClock;
  let sql: Sql;
  let ids: ReturnType<typeof makeIds>;

  beforeEach(() => {
    spans = installSpanFixture();
    metrics = installMetricFixture();
    clock = new FakeClock(1_000_000);
    ids = makeIds();
    sql = makeFakeSql(ids.tenantId);
  });

  afterEach(async () => {
    await uninstallSpanFixture();
    await uninstallMetricFixture();
  });

  test("model.call span carries gen_ai.conversation.id = sessionId", async () => {
    const model: ModelClient = { complete: () => Promise.resolve(textResponse("hi")) };
    const tools = new InMemoryToolRegistry([]);

    await runTurnLoop(
      { sql, clock, model, tools, maxTurns: 5 },
      { ...ids, systemPrompt: "sys", initialMessages: baseInput },
    );

    const modelSpans = spans.spansByName(SpanName.ModelCall);
    expect(modelSpans).toHaveLength(1);
    expect(modelSpans[0]?.attributes[GenAiAttr.ConversationId]).toBe(ids.sessionId);
  });

  test("tool.call span carries gen_ai.* tool attributes", async () => {
    let call = 0;
    const model: ModelClient = {
      complete: () => {
        call++;
        if (call === 1) return Promise.resolve(toolUseResponse("tc_1", "echo", { text: "ping" }));
        return Promise.resolve(textResponse("done"));
      },
    };
    const tools = new InMemoryToolRegistry([echoTool]);

    await runTurnLoop(
      { sql, clock, model, tools, maxTurns: 5 },
      { ...ids, systemPrompt: "sys", initialMessages: baseInput },
    );

    const toolSpans = spans.spansByName(SpanName.ToolCall);
    expect(toolSpans).toHaveLength(1);
    const s = toolSpans[0];
    expect(s?.attributes[GenAiAttr.OperationName]).toBe("execute_tool");
    expect(s?.attributes[GenAiAttr.ToolName]).toBe("echo");
    expect(s?.attributes[GenAiAttr.ToolType]).toBe("function");
    expect(s?.attributes[GenAiAttr.ToolCallId]).toBe("tc_1");
  });

  test("tool.call span emits arguments event pre-invoke and result event post-invoke", async () => {
    let call = 0;
    const model: ModelClient = {
      complete: () => {
        call++;
        if (call === 1) return Promise.resolve(toolUseResponse("tc_2", "echo", { text: "world" }));
        return Promise.resolve(textResponse("done"));
      },
    };
    const tools = new InMemoryToolRegistry([echoTool]);

    await runTurnLoop(
      { sql, clock, model, tools, maxTurns: 5 },
      { ...ids, systemPrompt: "sys", initialMessages: baseInput },
    );

    const s = spans.spansByName(SpanName.ToolCall)[0];
    expect(s).toBeDefined();
    const argsEv = s?.events.find((e) => e.name === GenAiEvent.ToolCallArguments);
    const resultEv = s?.events.find((e) => e.name === GenAiEvent.ToolCallResult);
    expect(argsEv).toBeDefined();
    expect(resultEv).toBeDefined();
    const argsStr = argsEv?.attributes?.["gen_ai.tool.call.arguments"] as string;
    expect(JSON.parse(argsStr)).toEqual({ text: "world" });
    // Ordering: arguments event before result event.
    const argsTime = argsEv?.time as [number, number];
    const resultTime = resultEv?.time as [number, number];
    expect(argsTime[0]).toBeLessThanOrEqual(resultTime[0]);
  });

  test("relay.tool.invocation.duration histogram records one observation per tool call", async () => {
    let call = 0;
    const model: ModelClient = {
      complete: () => {
        call++;
        if (call === 1) return Promise.resolve(toolUseResponse("tc_3", "echo", { text: "x" }));
        return Promise.resolve(textResponse("done"));
      },
    };
    const tools = new InMemoryToolRegistry([echoTool]);

    await runTurnLoop(
      { sql, clock, model, tools, maxTurns: 5 },
      { ...ids, systemPrompt: "sys", initialMessages: baseInput },
    );

    const rm = await metrics.collect();
    expect(
      histogramCount(rm, "relay.tool.invocation.duration", {
        [GenAiAttr.ToolName]: "echo",
        "relay.outcome": "invoked",
      }),
    ).toBe(1);
  });

  test("tool error path emits result event with isError=true and outcome=tool_error", async () => {
    const failingRegistry = {
      list: () => [{ name: "boom", inputSchema: { type: "object" } }] as const,
      invoke: () => Promise.resolve({ ok: false as const, errorMessage: "boom failed" }),
    };
    let call = 0;
    const model: ModelClient = {
      complete: () => {
        call++;
        if (call === 1)
          return Promise.resolve({
            content: [toolUseBlock("tc_b", "boom", {})],
            stopReason: "tool_use" as const,
            usage: { inputTokens: 5, outputTokens: 2 },
          });
        return Promise.resolve(textResponse("recovered"));
      },
    };

    await runTurnLoop(
      { sql, clock, model, tools: failingRegistry, maxTurns: 5 },
      { ...ids, systemPrompt: "sys", initialMessages: baseInput },
    );

    const s = spans.spansByName(SpanName.ToolCall)[0];
    const resultEv = s?.events.find((e) => e.name === GenAiEvent.ToolCallResult);
    expect(resultEv).toBeDefined();
    expect(resultEv?.attributes?.["gen_ai.tool.call.is_error"]).toBe(true);

    const rm = await metrics.collect();
    expect(
      histogramCount(rm, "relay.tool.invocation.duration", {
        [GenAiAttr.ToolName]: "boom",
        "relay.outcome": "tool_error",
      }),
    ).toBe(1);
  });
});
