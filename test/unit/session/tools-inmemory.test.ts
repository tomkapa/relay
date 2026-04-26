// Unit tests for notifyTool and InMemoryToolRegistry. RELAY-145.

import { describe, expect, test } from "bun:test";
import { AssertionError } from "../../../src/core/assert.ts";
import { NOTIFY_TOOL_NAME } from "../../../src/session/builtin-tools.ts";
import { InMemoryToolRegistry, echoTool, notifyTool } from "../../../src/session/tools-inmemory.ts";
import type { ToolInvocationContext } from "../../../src/session/tools.ts";

// Satisfies the ToolInvocationContext type for invoke tests without populating real IDs.
// notifyTool.invoke asserts(false) before touching ctx, so the values are irrelevant.
const dummyCtx = null as unknown as ToolInvocationContext;

describe("notifyTool", () => {
  test("schema.name is NOTIFY_TOOL_NAME", () => {
    expect(notifyTool.schema.name).toBe(NOTIFY_TOOL_NAME);
  });

  test("schema has required fields target_agent_id and content", () => {
    const { inputSchema } = notifyTool.schema;
    const props = inputSchema["properties"] as Record<string, unknown>;
    expect(props).toHaveProperty("target_agent_id");
    expect(props).toHaveProperty("content");
    expect(inputSchema["required"]).toContain("target_agent_id");
    expect(inputSchema["required"]).toContain("content");
  });

  test("invoke throws AssertionError — must never be reached at runtime", () => {
    expect(() =>
      notifyTool.invoke(
        { target_agent_id: "abc", content: "hi" },
        dummyCtx,
        new AbortController().signal,
      ),
    ).toThrow(AssertionError);
  });
});

describe("InMemoryToolRegistry with notifyTool", () => {
  test("list() includes notify schema when notifyTool is registered", () => {
    const reg = new InMemoryToolRegistry([notifyTool]);
    const names = reg.list().map((s) => s.name);
    expect(names).toContain(NOTIFY_TOOL_NAME);
  });

  test("list() includes both echo and notify when both registered", () => {
    const reg = new InMemoryToolRegistry([echoTool, notifyTool]);
    const names = reg.list().map((s) => s.name);
    expect(names).toContain("echo");
    expect(names).toContain(NOTIFY_TOOL_NAME);
  });

  test("duplicate tool names throw AssertionError", () => {
    expect(() => new InMemoryToolRegistry([notifyTool, notifyTool])).toThrow(AssertionError);
  });
});
