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
  ToolUseId,
} from "../../../src/ids.ts";
import { assert } from "../../../src/core/assert.ts";
import type { ModelClient, ToolSchema } from "../../../src/session/model.ts";
import type { ToolRegistry, ToolResult } from "../../../src/session/tools.ts";
import { runTurnLoop } from "../../../src/session/turn-loop.ts";
import type { Message, ModelResponse, TextBlock, ToolUseBlock } from "../../../src/session/turn.ts";
import { InMemoryToolRegistry, echoTool } from "../../../src/session/tools-inmemory.ts";
import type { PostToolUsePayload, PreToolUsePayload } from "../../../src/hook/payloads.ts";
import { HOOK_EVENT } from "../../../src/hook/types.ts";
import { __clearRegistryForTesting, registerHook } from "../../../src/hook/registry.ts";
import { HookRecordId } from "../../../src/ids.ts";
import {
  installMetricFixture,
  uninstallMetricFixture,
  sumCounter,
  type MetricFixture,
} from "../../helpers/metrics.ts";
import { makeFakeSql } from "../../helpers/fake-sql.ts";

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

function makeToolUseBlock(id: string, name: string, input: Record<string, unknown>): ToolUseBlock {
  const parsed = ToolUseId.parse(id);
  assert(parsed.ok, "makeToolUseBlock: invalid id");
  return { type: "tool_use", id: parsed.value, name, input };
}

function toolUseResponse(id: string, name: string, input: Record<string, unknown>): ModelResponse {
  return {
    content: [makeToolUseBlock(id, name, input)],
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
  ids = makeIds();
  sql = makeFakeSql(ids.tenantId);
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
    expect(result.value.kind).toBe("completed");
    if (result.value.kind !== "completed") return;
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
          const toolBlock = makeToolUseBlock("tc_2", "boom", {});
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
          content: [makeToolUseBlock("tc_3", "ghost", {})],
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
          content: [makeToolUseBlock("tc_4", "echo", { text: "hi" })],
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
    ids = makeIds();
    sql = makeFakeSql(ids.tenantId);
  });

  afterEach(async () => {
    await uninstallMetricFixture();
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
    ids = makeIds();
    sql = makeFakeSql(ids.tenantId);
  });

  afterEach(async () => {
    await uninstallMetricFixture();
  });

  test("two tool_use blocks: dispatch_iteration_total=2, two {outcome=invoked}", async () => {
    let callCount = 0;
    const model: ModelClient = {
      complete: () => {
        callCount++;
        if (callCount === 1)
          return Promise.resolve({
            content: [
              makeToolUseBlock("tc_a", "echo", { text: "a" }),
              makeToolUseBlock("tc_b", "echo", { text: "b" }),
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
          content: [makeToolUseBlock("tc_x", "ghost", {})],
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

function makeHookId(tag: string) {
  const r = HookRecordId.parse(tag);
  assert(r.ok, `turn-loop.test: invalid HookRecordId: ${tag}`);
  return r.value;
}

describe("hook registry — call order and payloads", () => {
  beforeEach(() => {
    __clearRegistryForTesting();
    clock = new FakeClock(1_000_000);
    ids = makeIds();
    sql = makeFakeSql(ids.tenantId);
  });

  afterEach(() => {
    __clearRegistryForTesting();
  });

  test("pre hook fires before tool invoke, post hook fires after (ordered log)", async () => {
    const log: string[] = [];

    registerHook({
      id: makeHookId("system/pre_tool_use/test-order"),
      layer: "system",
      event: HOOK_EVENT.PreToolUse,
      matcher: () => true,
      decision: () => {
        log.push("pre");
        return Promise.resolve({ decision: "approve" });
      },
    });
    registerHook({
      id: makeHookId("system/post_tool_use/test-order"),
      layer: "system",
      event: HOOK_EVENT.PostToolUse,
      matcher: () => true,
      decision: () => {
        log.push("post");
        return Promise.resolve({ decision: "approve" });
      },
    });

    let callCount = 0;
    const model: ModelClient = {
      complete: () => {
        callCount++;
        if (callCount === 1)
          return Promise.resolve(toolUseResponse("tc_1", "echo", { text: "ping" }));
        return Promise.resolve(textResponse("done"));
      },
    };
    const spyRegistry: ToolRegistry = {
      list: (): readonly ToolSchema[] => [echoTool.schema],
      invoke: (req) => {
        log.push("invoke");
        return echoTool.invoke(req.input, req.ctx, req.signal);
      },
    };

    const result = await runTurnLoop(
      { sql, clock, model, tools: spyRegistry, maxTurns: 10 },
      { ...ids, systemPrompt: "sys", initialMessages: baseInput },
    );

    expect(result.ok).toBe(true);
    expect(log).toEqual(["pre", "invoke", "post"]);
  });

  test("pre_tool_use hook receives correct payload fields", async () => {
    const captured: PreToolUsePayload[] = [];

    registerHook({
      id: makeHookId("system/pre_tool_use/capture-payload"),
      layer: "system",
      event: HOOK_EVENT.PreToolUse,
      matcher: () => true,
      decision: (p) => {
        captured.push(p);
        return Promise.resolve({ decision: "approve" });
      },
    });

    let callCount = 0;
    const model: ModelClient = {
      complete: () => {
        callCount++;
        if (callCount === 1)
          return Promise.resolve(toolUseResponse("tool-use-id-42", "echo", { text: "hello" }));
        return Promise.resolve(textResponse("done"));
      },
    };
    const tools = new InMemoryToolRegistry([echoTool]);

    await runTurnLoop(
      { sql, clock, model, tools, maxTurns: 10 },
      { ...ids, systemPrompt: "sys", initialMessages: baseInput },
    );

    expect(captured).toHaveLength(1);
    const p = captured[0];
    assert(p !== undefined, "pre hook decision must have been called");
    expect(p.toolUseId as string).toBe("tool-use-id-42");
    expect(p.toolName).toBe("echo");
    expect(p.toolInput).toEqual({ text: "hello" });
    expect(p.sessionId).toBe(ids.sessionId);
    expect(p.agentId).toBe(ids.agentId);
    expect(p.tenantId).toBe(ids.tenantId);
    expect(typeof p.turnId).toBe("string");
    expect(p.turnId.length).toBeGreaterThan(0);
  });

  test("post_tool_use hook receives correct payload fields including outcome=invoked", async () => {
    const captured: PostToolUsePayload[] = [];

    registerHook({
      id: makeHookId("system/post_tool_use/capture-payload"),
      layer: "system",
      event: HOOK_EVENT.PostToolUse,
      matcher: () => true,
      decision: (p) => {
        captured.push(p);
        return Promise.resolve({ decision: "approve" });
      },
    });

    let callCount = 0;
    const model: ModelClient = {
      complete: () => {
        callCount++;
        if (callCount === 1)
          return Promise.resolve(toolUseResponse("tu-99", "echo", { text: "world" }));
        return Promise.resolve(textResponse("done"));
      },
    };
    const tools = new InMemoryToolRegistry([echoTool]);

    await runTurnLoop(
      { sql, clock, model, tools, maxTurns: 10 },
      { ...ids, systemPrompt: "sys", initialMessages: baseInput },
    );

    expect(captured).toHaveLength(1);
    const p = captured[0];
    assert(p !== undefined, "post hook decision must have been called");
    expect(p.toolUseId as string).toBe("tu-99");
    expect(p.toolName).toBe("echo");
    expect(p.outcome).toBe("invoked");
    expect(p.sessionId).toBe(ids.sessionId);
    expect(p.agentId).toBe(ids.agentId);
    expect(p.tenantId).toBe(ids.tenantId);
  });

  test("post_tool_use outcome=tool_error when tool returns error", async () => {
    const captured: PostToolUsePayload[] = [];

    registerHook({
      id: makeHookId("system/post_tool_use/capture-outcome"),
      layer: "system",
      event: HOOK_EVENT.PostToolUse,
      matcher: () => true,
      decision: (p) => {
        captured.push(p);
        return Promise.resolve({ decision: "approve" });
      },
    });

    const errorRegistry: ToolRegistry = {
      list: (): readonly ToolSchema[] => [{ name: "boom", inputSchema: { type: "object" } }],
      invoke: (): Promise<ToolResult> =>
        Promise.resolve({ ok: false, errorMessage: "boom failed" }),
    };

    let callCount = 0;
    const model: ModelClient = {
      complete: () => {
        callCount++;
        if (callCount === 1) {
          const b = makeToolUseBlock("tu-boom", "boom", {});
          return Promise.resolve({
            content: [b],
            stopReason: "tool_use",
            usage: { inputTokens: 1, outputTokens: 1 },
          });
        }
        return Promise.resolve(textResponse("recovered"));
      },
    };

    await runTurnLoop(
      { sql, clock, model, tools: errorRegistry, maxTurns: 10 },
      { ...ids, systemPrompt: "sys", initialMessages: baseInput },
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]?.outcome).toBe("tool_error");
  });
});

describe("hook registry — relay.hook.evaluation_total counter", () => {
  let fixture: MetricFixture;

  beforeEach(() => {
    __clearRegistryForTesting();
    fixture = installMetricFixture();
    clock = new FakeClock(1_000_000);
    ids = makeIds();
    sql = makeFakeSql(ids.tenantId);
    // Register one approve hook per event so evaluateHook is called and emits the counter.
    registerHook({
      id: makeHookId("system/pre_tool_use/counter-approve"),
      layer: "system",
      event: HOOK_EVENT.PreToolUse,
      matcher: () => true,
      decision: () => Promise.resolve({ decision: "approve" }),
    });
    registerHook({
      id: makeHookId("system/post_tool_use/counter-approve"),
      layer: "system",
      event: HOOK_EVENT.PostToolUse,
      matcher: () => true,
      decision: () => Promise.resolve({ decision: "approve" }),
    });
  });

  afterEach(async () => {
    __clearRegistryForTesting();
    await uninstallMetricFixture();
  });

  test("one tool_use block → evaluation_total=2 (pre+post), both decision=approve, layer=system", async () => {
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
    expect(sumCounter(rm, "relay.hook.evaluation_total")).toBe(2);
    expect(
      sumCounter(rm, "relay.hook.evaluation_total", {
        "relay.hook.event": "pre_tool_use",
        "relay.hook.decision": "approve",
        "relay.hook.layer": "system",
      }),
    ).toBe(1);
    expect(
      sumCounter(rm, "relay.hook.evaluation_total", {
        "relay.hook.event": "post_tool_use",
        "relay.hook.decision": "approve",
        "relay.hook.layer": "system",
      }),
    ).toBe(1);
  });

  test("two tool_use blocks in one turn → evaluation_total=4", async () => {
    let callCount = 0;
    const model: ModelClient = {
      complete: () => {
        callCount++;
        if (callCount === 1)
          return Promise.resolve({
            content: [
              makeToolUseBlock("tc_a", "echo", { text: "a" }),
              makeToolUseBlock("tc_b", "echo", { text: "b" }),
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
    expect(sumCounter(rm, "relay.hook.evaluation_total")).toBe(4);
  });

  test("evaluation_total carries tool_name attribute", async () => {
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

    await runTurnLoop(
      { sql, clock, model, tools, maxTurns: 10 },
      { ...ids, systemPrompt: "sys", initialMessages: baseInput },
    );

    const rm = await fixture.collect();
    expect(sumCounter(rm, "relay.hook.evaluation_total", { "relay.tool.name": "echo" })).toBe(2);
  });
});

// ─── ask / notify dispatch paths ─────────────────────────────────────────────
// These tests cover: ask/notify block handling in dispatchTurn, dispatchBoundarySends,
// the boundary dispatch section of the loop, and dispatch_failed in outcomeFromTurnLoopError.
// No real DB needed — fake SQL supplies envelope writes (no return needed) and
// controls whether the work_queue enqueue succeeds or reports over-capacity.

import { ChainId as ChainIdParser, Depth as DepthParser } from "../../../src/ids.ts";
import type { ChainId, Depth } from "../../../src/ids.ts";

function makeChainAndDepth(): { chainId: ChainId; depth: Depth } {
  const c = ChainIdParser.parse(randomUUID());
  const d = DepthParser.parse(0);
  assert(c.ok && d.ok, "makeChainAndDepth: invalid ids");
  return { chainId: c.value, depth: d.value };
}

function makeDispatchFakeSql(tenantId: TenantId, opts: { queueSucceeds: boolean }): Sql {
  const fake = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const first = strings[0] ?? "";
    if (first.includes("SELECT tenant_id FROM agents")) {
      return Promise.resolve([{ tenant_id: tenantId }]);
    }
    if (first.includes("INSERT INTO hook_audit")) {
      return Promise.resolve([
        {
          id: randomUUID(),
          hook_id: "test/stub",
          layer: "system",
          event: "pre_message_send",
          matcher_result: true,
          decision: "approve",
          reason: null,
          latency_ms: 0,
          tenant_id: tenantId,
          session_id: null,
          agent_id: randomUUID(),
          turn_id: null,
          tool_name: null,
          created_at: new Date(),
        },
      ]);
    }
    // work_queue enqueue: return a row for success, empty for over-capacity.
    if (first.includes("WITH candidate AS")) {
      return opts.queueSucceeds ? Promise.resolve([{ id: randomUUID() }]) : Promise.resolve([]);
    }
    return Promise.resolve([]);
  };
  Object.assign(fake, {
    json: (v: unknown) => v,
    begin: (fn: (tx: unknown) => Promise<unknown>) => fn(fake),
    unsafe: () => Promise.resolve([]),
  });
  return fake as unknown as Sql;
}

function askToolUseResponse(toolUseId: string, targetAgentId: string): ModelResponse {
  const idResult = ToolUseId.parse(toolUseId);
  assert(idResult.ok, "askToolUseResponse: invalid toolUseId");
  return {
    content: [
      {
        type: "tool_use",
        id: idResult.value,
        name: "ask",
        input: { target_agent_id: targetAgentId, content: "can you help?" },
      },
    ],
    stopReason: "tool_use",
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

describe("runTurnLoop — ask/notify dispatch", () => {
  let clock: FakeClock;
  let ids: ReturnType<typeof makeIds>;
  let chainDepth: ReturnType<typeof makeChainAndDepth>;

  beforeEach(() => {
    clock = new FakeClock(1_000_000);
    ids = makeIds();
    chainDepth = makeChainAndDepth();
    __clearRegistryForTesting();
  });

  afterEach(() => {
    __clearRegistryForTesting();
  });

  test("ask tool_use: enqueue over-capacity → dispatch_failed error", async () => {
    const targetAgentId = randomUUID();
    const model: ModelClient = {
      complete: () => Promise.resolve(askToolUseResponse("toolu_ask_01", targetAgentId)),
    };
    const tools = new InMemoryToolRegistry([]);
    const sql = makeDispatchFakeSql(ids.tenantId, { queueSucceeds: false });

    const result = await runTurnLoop(
      { sql, clock, model, tools, maxTurns: 10 },
      {
        ...ids,
        ...chainDepth,
        systemPrompt: "sys",
        initialMessages: baseInput,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("dispatch_failed");
  });

  test("ask tool_use: enqueue succeeds → suspended with one pending ask", async () => {
    const targetAgentId = randomUUID();
    const model: ModelClient = {
      complete: () => Promise.resolve(askToolUseResponse("toolu_ask_01", targetAgentId)),
    };
    const tools = new InMemoryToolRegistry([]);
    const sql = makeDispatchFakeSql(ids.tenantId, { queueSucceeds: true });

    const result = await runTurnLoop(
      { sql, clock, model, tools, maxTurns: 10 },
      {
        ...ids,
        ...chainDepth,
        systemPrompt: "sys",
        initialMessages: baseInput,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("suspended");
    if (result.value.kind !== "suspended") return;
    expect(result.value.pendingAsks).toHaveLength(1);
    expect(result.value.pendingAsks[0]?.toolUseId as string).toBe("toolu_ask_01");
    expect(result.value.pendingAsks[0]?.targetAgentId as string).toBe(targetAgentId);
    expect(result.value.turns).toHaveLength(1);
  });

  test("ask tool_use with invalid input → inline error tool_result, no suspend", async () => {
    const badIdResult = ToolUseId.parse("toolu_bad_01");
    assert(badIdResult.ok, "test: invalid toolUseId");
    const model: ModelClient = {
      // target_agent_id is missing — parseAskInput returns validation_failed
      complete: () =>
        Promise.resolve({
          content: [
            {
              type: "tool_use" as const,
              id: badIdResult.value,
              name: "ask",
              input: { content: "oops" }, // missing target_agent_id
            },
          ],
          stopReason: "tool_use" as const,
          usage: { inputTokens: 10, outputTokens: 5 },
        }),
    };
    // After inline error, model should get the error tool_result and return end_turn
    let callCount = 0;
    const mockModel: ModelClient = {
      complete: () => {
        callCount++;
        if (callCount === 1)
          return model.complete({
            systemPrompt: "",
            messages: [],
            tools: [],
            signal: new AbortController().signal,
          });
        return Promise.resolve(textResponse("ok after error"));
      },
    };
    const tools = new InMemoryToolRegistry([]);
    const sql = makeFakeSql(ids.tenantId);

    const result = await runTurnLoop(
      { sql, clock, model: mockModel, tools, maxTurns: 10 },
      { ...ids, systemPrompt: "sys", initialMessages: baseInput },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("completed");
    if (result.value.kind !== "completed") return;
    // First turn: ask tool_use with error tool_result (no suspend)
    const firstTurn = result.value.turns[0];
    expect(firstTurn?.toolResults).toHaveLength(1);
    expect(firstTurn?.toolResults[0]?.isError).toBe(true);
  });
});
