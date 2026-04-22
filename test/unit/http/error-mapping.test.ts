// Unit tests for AgentCreateError → HTTP status mapping.
// Exhaustive: if a new error kind is added without updating agentCreateErrorStatus,
// the TypeScript compiler will error at the `assertNever` default branch.

import { describe, expect, test } from "bun:test";
import { agentCreateErrorStatus } from "../../../src/http/routes/agents.ts";
import type { AgentCreateError } from "../../../src/agent/create.ts";

describe("agentCreateErrorStatus", () => {
  test("validation_failed maps to 400", () => {
    const e: AgentCreateError = { kind: "validation_failed", issues: [] };
    expect(agentCreateErrorStatus(e)).toBe(400);
  });

  test("system_prompt_too_long maps to 400", () => {
    const e: AgentCreateError = { kind: "system_prompt_too_long", length: 33000, max: 32768 };
    expect(agentCreateErrorStatus(e)).toBe(400);
  });

  test("tool_set_too_large maps to 400", () => {
    const e: AgentCreateError = { kind: "tool_set_too_large", size: 257, max: 256 };
    expect(agentCreateErrorStatus(e)).toBe(400);
  });

  test("hook_rules_too_large maps to 400", () => {
    const e: AgentCreateError = { kind: "hook_rules_too_large", size: 257, max: 256 };
    expect(agentCreateErrorStatus(e)).toBe(400);
  });

  test("tenant_id_invalid maps to 400", () => {
    const e: AgentCreateError = { kind: "tenant_id_invalid", reason: "malformed" };
    expect(agentCreateErrorStatus(e)).toBe(400);
  });

  test("db_conflict maps to 409", () => {
    const e: AgentCreateError = { kind: "db_conflict", detail: "duplicate key value" };
    expect(agentCreateErrorStatus(e)).toBe(409);
  });
});
