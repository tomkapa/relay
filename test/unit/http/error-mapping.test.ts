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

  test("seed_memory_too_large maps to 400", () => {
    const e: AgentCreateError = { kind: "seed_memory_too_large", size: 17, max: 16 };
    expect(agentCreateErrorStatus(e)).toBe(400);
  });

  test("seed_memory_text_too_long maps to 400", () => {
    const e: AgentCreateError = { kind: "seed_memory_text_too_long", bytes: 9000, max: 8192 };
    expect(agentCreateErrorStatus(e)).toBe(400);
  });

  test("db_conflict maps to 409", () => {
    const e: AgentCreateError = { kind: "db_conflict", detail: "duplicate key value" };
    expect(agentCreateErrorStatus(e)).toBe(409);
  });

  test("hook_denied maps to 403", () => {
    const e: AgentCreateError = { kind: "hook_denied", reason: "policy violation" };
    expect(agentCreateErrorStatus(e)).toBe(403);
  });

  test("embed_transient maps to 503", () => {
    const e: AgentCreateError = { kind: "embed_transient", message: "rate limited" };
    expect(agentCreateErrorStatus(e)).toBe(503);
  });

  test("embed_permanent maps to 422", () => {
    const e: AgentCreateError = { kind: "embed_permanent", message: "input rejected" };
    expect(agentCreateErrorStatus(e)).toBe(422);
  });

  test("embed_timeout maps to 504", () => {
    const e: AgentCreateError = { kind: "embed_timeout", elapsedMs: 10000 };
    expect(agentCreateErrorStatus(e)).toBe(504);
  });
});
