// Unit tests for the agentic turn loop. Uses fake ModelClient, ToolRegistry, Clock, and Sql.
// Anthropic is a paid external service — CLAUDE.md §3 explicitly permits mocking it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { FakeClock } from "../../../src/core/clock.ts";
import type { AgentId, SessionId, TenantId } from "../../../src/ids.ts";
import {
  AgentId as AgentIdParser,
  SessionId as SessionIdParser,
  TenantId as TenantIdParser,
} from "../../../src/ids.ts";
import { assert } from "../../../src/core/assert.ts";
import type { ModelClient, ToolSchema } from "../../../src/session/model.ts";
import type { ToolRegistry, ToolResult } from "../../../src/session/tools.ts";
import { runTurnLoop } from "../../../src/session/turn-loop.ts";
import type { Message, ModelResponse, TextBlock, ToolUseBlock } from "../../../src/session/turn.ts";
import { InMemoryToolRegistry, echoTool } from "../../../src/session/tools-inmemory.ts";
import {
  installMetricFixture,
  uninstallMetricFixture,
  sumCounter,
  type MetricFixture,
} from "../../helpers/metrics.ts";

// Minimal fake Sql: INSERT returns no rows; sql.json passes value through.
function makeFakeSql(): Sql {
  const tag = (): Promise<never[]> => Promise.resolve([]);
  // postgres.js sql.json is used as a serializer; identity is fine for unit tests
  Object.assign(tag, { json: (v: unknown) => v });
  return tag as unknown as Sql;
}

function makeIds(): { sessionId: SessionId; agentId: AgentId; tenantId: TenantId } {
  const s = SessionIdParser.parse(randomUUID());
  const a = AgentIdParser.parse(randomUUID());
  const t = TenantIdParser.parse(randomUUID());
  assert(s.ok && a.ok && t.ok, "makeIds: randomUUID produced invalid ids");
  return { sessionId: s.value, agentId: a.value, tenantId: t.value };
}

function textResponse(text: string): ModelResponse {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

function toolUseResponse(id: string, name: string, input: Record<string, unknown>): ModelResponse {
  const toolBlock: ToolUseBlock = { type: "tool_use", id, name, input };
  return {
    content: [toolBlock],
    stopReason: "tool_use",
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

const baseInput: Message[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }];

let clock: FakeClock;
let sql: Sql;
let ids: ReturnType<typeof makeIds>;

beforeEach(() => {
  clock = new FakeClock(1_000_000);
  sql = makeFakeSql();
  ids = makeIds();
});

describe("runTurnLoop", () => {
  test("happy path: end_turn on first model call → one turn, no tool results", async () => {
    const model: ModelClient = {
      complete: () => Promise.resolve(textResponse("Hello world")),
    };
    const tools = new InMemoryToolRegistry([]);

    const result = await runTurnLoop(
      { sql, clock, model, tools, maxTurns: 10 },
      { ...ids, systemPrompt: "You are helpful.", initialMessages: baseInput },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.turns).toHaveLength(1);
    expect(result.value.turns[0]?.toolResults).toHaveLength(0);
    const textBlock = result.value.finalResponse.content[0] as TextBlock;
    expect(textBlock.text).toBe("Hello world");
  });

  test("one tool round-trip: tool_use on turn 1, end_turn on turn 2", async () => {
    let callCount = 0;
    const model: ModelClient = {
      complete: () => {
        callCount++;
        if (callCount === 1)
          return Promise.resolve(toolUseResponse("tc_1", "echo", { text: "ping" }));
        return Promise.resolve(textResponse("pong"));
      },
    };
    const tools = new InMemoryToolRegistry([echoTool]);

    const result = await runTurnLoop(
      { sql, clock, model, tools, maxTurns: 10 },
      { ...ids, systemPrompt: "You are helpful.", initialMessages: baseInput },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.turns).toHaveLength(2);
    expect(result.value.turns[0]?.toolResults).toHaveLength(1);
    expect(result.value.turns[0]?.toolResults[0]?.content).toBe("ping");
    expect(result.value.turns[1]?.toolResults).toHaveLength(0);
  });

  test("tool error surfaces to model as tool_result with isError", async () => {
    const failingRegistry: ToolRegistry = {
      list: (): readonly ToolSchema[] => [{ name: "boom", inputSchema: { type: "object" } }],
      invoke: (): Promise<ToolResult> =>
        Promise.resolve({ ok: false, errorMessage: "boom failed" }),
    };

    let secondCallMessages: readonly Message[] = [];
    let callCount = 0;
    const model: ModelClient = {
      complete: ({ messages }) => {
        callCount++;
        if (callCount === 1) {
          const toolBlock: ToolUseBlock = { type: "tool_use", id: "tc_2", name: "boom", input: {} };
          return Promise.resolve({
            content: [toolBlock],
            stopReason: "tool_use",
            usage: { inputTokens: 5, outputTokens: 3 },
          });
        }
        secondCallMessages = [...messages]; // snapshot before the loop mutates further
        return Promise.resolve(textResponse("ok"));
      },
    };

    const result = await runTurnLoop(
      { sql, clock, model, tools: failingRegistry, maxTurns: 10 },
      { ...ids, systemPrompt: "sys", initialMessages: baseInput },
    );

    expect(result.ok).toBe(true);
    // The second model call receives a tool_result with isError
    const lastMsg = secondCallMessages[secondCallMessages.length - 1];
    expect(lastMsg?.role).toBe("user");
    const toolResultBlock = lastMsg?.content[0];
    expect(toolResultBlock?.type).toBe("tool_result");
    if (toolResultBlock?.type === "tool_result") {
      expect(toolResultBlock.isError).toBe(true);
      expect(toolResultBlock.content).toBe("boom failed");
    }
  });

  test("unknown tool name returns {kind:'tool_unknown'}", async () => {
    const model: ModelClient = {
      complete: () =>
        Promise.resolve({
          content: [{ type: "tool_use" as const, id: "tc_3", name: "ghost", input: {} }],
          stopReason: "tool_use",
          usage: { inputTokens: 5, outputTokens: 3 },
        }),
    };
    const tools = new InMemoryToolRegistry([]); // no tools registered

    const result = await runTurnLoop(
      { sql, clock, model, tools, maxTurns: 10 },
      { ...ids, systemPrompt: "sys", initialMessages: baseInput },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("tool_unknown");
    if (result.error.kind === "tool_unknown") expect(result.error.toolName).toBe("ghost");
  });

  test("turn cap exceeded when model never returns end_turn", async () => {
    const alwaysContinuing: ModelClient = {
      complete: () =>
        Promise.resolve({
          content: [{ type: "text", text: "still going" }],
          stopReason: "max_tokens",
          usage: { inputTokens: 5, outputTokens: 3 },
        }),
    };
    const tools = new InMemoryToolRegistry([]);

    const result = await runTurnLoop(
      { sql, clock, model: alwaysContinuing, tools, maxTurns: 3 },
      { ...ids, systemPrompt: "sys", initialMessages: baseInput },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("turn_cap_exceeded");
    if (result.error.kind === "turn_cap_exceeded") expect(result.error.max).toBe(3);
  });

  test("model timeout returns {kind:'timeout', stage:'model'}", async () => {
    const model: ModelClient = {
      complete: () => Promise.reject(new DOMException("The operation timed out", "TimeoutError")),
    };
    const tools = new InMemoryToolRegistry([]);

    const result = await runTurnLoop(
      { sql, clock, model, tools, maxTurns: 10 },
      { ...ids, systemPrompt: "sys", initialMessages: baseInput },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("timeout");
    if (result.error.kind === "timeout") expect(result.error.stage).toBe("model");
  });

  test("tool timeout returns {kind:'timeout', stage:'tool'}", async () => {
    const model: ModelClient = {
      complete: () =>
        Promise.resolve({
          content: [{ type: "tool_use" as const, id: "tc_4", name: "echo", input: { text: "hi" } }],
          stopReason: "tool_use",
          usage: { inputTokens: 5, outputTokens: 3 },
        }),
    };
    const timeoutRegistry: ToolRegistry = {
      list: (): readonly ToolSchema[] => [echoTool.schema],
      invoke: (): Promise<ToolResult> =>
        Promise.reject(new DOMException("The operation timed out", "TimeoutError")),
    };

    const result = await runTurnLoop(
      { sql, clock, model, tools: timeoutRegistry, maxTurns: 10 },
      { ...ids, systemPrompt: "sys", initialMessages: baseInput },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("timeout");
    if (result.error.kind === "timeout") expect(result.error.stage).toBe("tool");
  });

  test("model call failure returns {kind:'model_call_failed'}", async () => {
    const model: ModelClient = {
      complete: () => Promise.reject(new Error("connection refused")),
    };
    const tools = new InMemoryToolRegistry([]);

    const result = await runTurnLoop(
      { sql, clock, model, tools, maxTurns: 10 },
      { ...ids, systemPrompt: "sys", initialMessages: baseInput },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("model_call_failed");
    if (result.error.kind === "model_call_failed") {
      expect(result.error.detail).toContain("connection refused");
    }
  });

  test("turn records have contiguous index values", async () => {
    let callCount = 0;
    const model: ModelClient = {
      complete: () => {
        callCount++;
        if (callCount <= 2)
          return Promise.resolve(
            toolUseResponse(`tc_${callCount.toString()}`, "echo", { text: "x" }),
          );
        return Promise.resolve(textResponse("done"));
      },
    };
    const tools = new InMemoryToolRegistry([echoTool]);

    const result = await runTurnLoop(
      { sql, clock, model, tools, maxTurns: 10 },
      { ...ids, systemPrompt: "sys", initialMessages: baseInput },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.turns).toHaveLength(3);
    result.value.turns.forEach((turn, i) => {
      expect(turn.index).toBe(i);
    });
  });

  test("assertions fire on empty systemPrompt", () => {
    const model: ModelClient = { complete: () => Promise.resolve(textResponse("x")) };
    const tools = new InMemoryToolRegistry([]);

    expect(
      runTurnLoop(
        { sql, clock, model, tools },
        { ...ids, systemPrompt: "", initialMessages: baseInput },
      ),
    ).rejects.toThrow();
  });

  test("assertions fire on empty initialMessages", () => {
    const model: ModelClient = { complete: () => Promise.resolve(textResponse("x")) };
    const tools = new InMemoryToolRegistry([]);

    expect(
      runTurnLoop(
        { sql, clock, model, tools },
        { ...ids, systemPrompt: "sys", initialMessages: [] },
      ),
    ).rejects.toThrow();
  });
});

describe("saturation counters — turn loop", () => {
  let fixture: MetricFixture;

  beforeEach(() => {
    fixture = installMetricFixture();
    clock = new FakeClock(1_000_000);
    sql = makeFakeSql();
    ids = makeIds();
  });

  afterEach(() => {
    uninstallMetricFixture();
  });

  test("2-turn happy path: iteration_total=2, completion_total=1 {outcome=end_turn}", async () => {
    let callCount = 0;
    const model: ModelClient = {
      complete: () => {
        callCount++;
        if (callCount === 1)
          return Promise.resolve(toolUseResponse("tc_1", "echo", { text: "ping" }));
        return Promise.resolve(textResponse("done"));
      },
    };
    const tools = new InMemoryToolRegistry([echoTool]);

    const result = await runTurnLoop(
      { sql, clock, model, tools, maxTurns: 10 },
      { ...ids, systemPrompt: "sys", initialMessages: baseInput },
    );
    expect(result.ok).toBe(true);

    const rm = await fixture.collect();
    expect(sumCounter(rm, "relay.turn_loop.iteration_total")).toBe(2);
    expect(
      sumCounter(rm, "relay.turn_loop.completion_total", { "relay.outcome": "end_turn" }),
    ).toBe(1);
  });

  test("cap exceeded: iteration_total=2, completion_total=1 {outcome=cap_exceeded}", async () => {
    const model: ModelClient = {
      complete: () =>
        Promise.resolve({
          content: [{ type: "text" as const, text: "going" }],
          stopReason: "max_tokens" as const,
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
    };
    const tools = new InMemoryToolRegistry([]);

    await runTurnLoop(
      { sql, clock, model, tools, maxTurns: 2 },
      { ...ids, systemPrompt: "sys", initialMessages: baseInput },
    );

    const rm = await fixture.collect();
    expect(sumCounter(rm, "relay.turn_loop.iteration_total")).toBe(2);
    expect(
      sumCounter(rm, "relay.turn_loop.completion_total", { "relay.outcome": "cap_exceeded" }),
    ).toBe(1);
  });

  test("model error: iteration_total=1, completion_total=1 {outcome=model_error}", async () => {
    const model: ModelClient = {
      complete: () => Promise.reject(new Error("api down")),
    };
    const tools = new InMemoryToolRegistry([]);

    await runTurnLoop(
      { sql, clock, model, tools, maxTurns: 10 },
      { ...ids, systemPrompt: "sys", initialMessages: baseInput },
    );

    const rm = await fixture.collect();
    expect(sumCounter(rm, "relay.turn_loop.iteration_total")).toBe(1);
    expect(
      sumCounter(rm, "relay.turn_loop.completion_total", { "relay.outcome": "model_error" }),
    ).toBe(1);
  });
});

describe("saturation counters — tool dispatch", () => {
  let fixture: MetricFixture;

  beforeEach(() => {
    fixture = installMetricFixture();
    clock = new FakeClock(1_000_000);
    sql = makeFakeSql();
    ids = makeIds();
  });

  afterEach(() => {
    uninstallMetricFixture();
  });

  test("two tool_use blocks: dispatch_iteration_total=2, two {outcome=invoked}", async () => {
    let callCount = 0;
    const model: ModelClient = {
      complete: () => {
        callCount++;
        if (callCount === 1)
          return Promise.resolve({
            content: [
              { type: "tool_use" as const, id: "tc_a", name: "echo", input: { text: "a" } },
              { type: "tool_use" as const, id: "tc_b", name: "echo", input: { text: "b" } },
            ],
            stopReason: "tool_use" as const,
            usage: { inputTokens: 5, outputTokens: 3 },
          });
        return Promise.resolve(textResponse("done"));
      },
    };
    const tools = new InMemoryToolRegistry([echoTool]);

    const result = await runTurnLoop(
      { sql, clock, model, tools, maxTurns: 10 },
      { ...ids, systemPrompt: "sys", initialMessages: baseInput },
    );
    expect(result.ok).toBe(true);

    const rm = await fixture.collect();
    expect(sumCounter(rm, "relay.tool.dispatch_iteration_total")).toBe(2);
    expect(
      sumCounter(rm, "relay.tool.dispatch_completion_total", { "relay.outcome": "invoked" }),
    ).toBe(2);
  });

  test("unknown tool: dispatch_iteration_total=1, {outcome=tool_unknown}", async () => {
    const model: ModelClient = {
      complete: () =>
        Promise.resolve({
          content: [{ type: "tool_use" as const, id: "tc_x", name: "ghost", input: {} }],
          stopReason: "tool_use" as const,
          usage: { inputTokens: 5, outputTokens: 3 },
        }),
    };
    const tools = new InMemoryToolRegistry([]);

    const result = await runTurnLoop(
      { sql, clock, model, tools, maxTurns: 10 },
      { ...ids, systemPrompt: "sys", initialMessages: baseInput },
    );
    expect(result.ok).toBe(false);

    const rm = await fixture.collect();
    expect(sumCounter(rm, "relay.tool.dispatch_iteration_total")).toBe(1);
    expect(
      sumCounter(rm, "relay.tool.dispatch_completion_total", {
        "relay.outcome": "tool_unknown",
        "relay.tool.name": "ghost",
      }),
    ).toBe(1);
  });
});
