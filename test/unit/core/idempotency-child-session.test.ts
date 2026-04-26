// Unit tests for idempotencyKeyForChildSession — RELAY-146.
// TDD: written before the implementation.

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { AssertionError } from "../../../src/core/assert.ts";
import { idempotencyKeyForChildSession } from "../../../src/core/idempotency.ts";
import {
  AgentId,
  SessionId,
  type AgentId as AgentIdBrand,
  type SessionId as SessionIdBrand,
} from "../../../src/ids.ts";

function sid(): SessionIdBrand {
  const r = SessionId.parse(randomUUID());
  if (!r.ok) throw new Error("fixture: invalid SessionId");
  return r.value;
}

function aid(): AgentIdBrand {
  const r = AgentId.parse(randomUUID());
  if (!r.ok) throw new Error("fixture: invalid AgentId");
  return r.value;
}

const PARENT_SESSION_ID = sid();
const TARGET_AGENT_ID = aid();

describe("idempotencyKeyForChildSession", () => {
  test("deterministic: same inputs produce same key", () => {
    const a = idempotencyKeyForChildSession({
      parentSessionId: PARENT_SESSION_ID,
      targetAgentId: TARGET_AGENT_ID,
    });
    const b = idempotencyKeyForChildSession({
      parentSessionId: PARENT_SESSION_ID,
      targetAgentId: TARGET_AGENT_ID,
    });
    expect(a).toBe(b);
  });

  test("different parentSessionId produces different key", () => {
    const a = idempotencyKeyForChildSession({
      parentSessionId: PARENT_SESSION_ID,
      targetAgentId: TARGET_AGENT_ID,
    });
    const b = idempotencyKeyForChildSession({
      parentSessionId: sid(),
      targetAgentId: TARGET_AGENT_ID,
    });
    expect(a).not.toBe(b);
  });

  test("different targetAgentId produces different key", () => {
    const a = idempotencyKeyForChildSession({
      parentSessionId: PARENT_SESSION_ID,
      targetAgentId: TARGET_AGENT_ID,
    });
    const b = idempotencyKeyForChildSession({
      parentSessionId: PARENT_SESSION_ID,
      targetAgentId: aid(),
    });
    expect(a).not.toBe(b);
  });

  test("output is a 64-char lowercase hex digest", () => {
    const key = idempotencyKeyForChildSession({
      parentSessionId: PARENT_SESSION_ID,
      targetAgentId: TARGET_AGENT_ID,
    });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  test("empty parentSessionId throws AssertionError", () => {
    expect(() =>
      idempotencyKeyForChildSession({
        parentSessionId: "" as SessionIdBrand,
        targetAgentId: TARGET_AGENT_ID,
      }),
    ).toThrow(AssertionError);
  });

  test("empty targetAgentId throws AssertionError", () => {
    expect(() =>
      idempotencyKeyForChildSession({
        parentSessionId: PARENT_SESSION_ID,
        targetAgentId: "" as AgentIdBrand,
      }),
    ).toThrow(AssertionError);
  });
});
