import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { AssertionError } from "../../../src/core/assert.ts";
import {
  assertValidKeyFormat,
  idempotencyKey,
  idempotencyKeyForAgentSeed,
} from "../../../src/core/idempotency.ts";
import { AgentId, SessionId, TurnId, type AgentId as AgentIdBrand } from "../../../src/ids.ts";

function sid(): SessionId {
  const r = SessionId.parse(randomUUID());
  if (!r.ok) throw new Error("fixture: invalid SessionId");
  return r.value;
}

function tid(): TurnId {
  const r = TurnId.parse(randomUUID());
  if (!r.ok) throw new Error("fixture: invalid TurnId");
  return r.value;
}

const BASE = {
  writer: "memory.write",
  sessionId: sid(),
  turnId: tid(),
  toolCallId: "toolu_01AbCdEf",
} as const;

describe("idempotencyKey", () => {
  test("idempotencyKey_deterministic: same inputs produce same digest", () => {
    const a = idempotencyKey(BASE);
    const b = idempotencyKey(BASE);
    expect(a).toBe(b);
  });

  test("idempotencyKey_changesOnAnyInputChange: different writer → different digest", () => {
    expect(idempotencyKey({ ...BASE, writer: "hook.audit" })).not.toBe(idempotencyKey(BASE));
  });

  test("idempotencyKey_changesOnAnyInputChange: different sessionId → different digest", () => {
    expect(idempotencyKey({ ...BASE, sessionId: sid() })).not.toBe(idempotencyKey(BASE));
  });

  test("idempotencyKey_changesOnAnyInputChange: different turnId → different digest", () => {
    expect(idempotencyKey({ ...BASE, turnId: tid() })).not.toBe(idempotencyKey(BASE));
  });

  test("idempotencyKey_changesOnAnyInputChange: different toolCallId → different digest", () => {
    expect(idempotencyKey({ ...BASE, toolCallId: "toolu_other" })).not.toBe(idempotencyKey(BASE));
  });

  test("idempotencyKey_assertsPipeInWriter: writer containing | throws AssertionError", () => {
    expect(() => idempotencyKey({ ...BASE, writer: "bad|writer" })).toThrow(AssertionError);
  });

  test("idempotencyKey_assertsEmptyWriter: empty writer throws AssertionError", () => {
    expect(() => idempotencyKey({ ...BASE, writer: "" })).toThrow(AssertionError);
  });

  test("idempotencyKey_assertsEmptyToolCallId: empty toolCallId throws AssertionError", () => {
    expect(() => idempotencyKey({ ...BASE, toolCallId: "" })).toThrow(AssertionError);
  });

  test("idempotencyKey_assertsOversizeToolCallId: toolCallId > 128 chars throws AssertionError", () => {
    expect(() => idempotencyKey({ ...BASE, toolCallId: "x".repeat(129) })).toThrow(AssertionError);
  });

  test("idempotencyKey_producesHexDigest: output is 64 lowercase hex chars", () => {
    expect(idempotencyKey(BASE)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("idempotencyKeyForAgentSeed", () => {
  function aid(): AgentIdBrand {
    const r = AgentId.parse(randomUUID());
    if (!r.ok) throw new Error("fixture: invalid AgentId");
    return r.value;
  }

  const AGENT_ID = aid();

  test("deterministic: same agentId and index produce same key", () => {
    const a = idempotencyKeyForAgentSeed({ agentId: AGENT_ID, index: 0 });
    const b = idempotencyKeyForAgentSeed({ agentId: AGENT_ID, index: 0 });
    expect(a).toBe(b);
  });

  test("different agentId produces different key", () => {
    const a = idempotencyKeyForAgentSeed({ agentId: AGENT_ID, index: 0 });
    const b = idempotencyKeyForAgentSeed({ agentId: aid(), index: 0 });
    expect(a).not.toBe(b);
  });

  test("different index produces different key", () => {
    const a = idempotencyKeyForAgentSeed({ agentId: AGENT_ID, index: 0 });
    const b = idempotencyKeyForAgentSeed({ agentId: AGENT_ID, index: 1 });
    expect(a).not.toBe(b);
  });

  test("output is a 64-char lowercase hex digest", () => {
    const key = idempotencyKeyForAgentSeed({ agentId: AGENT_ID, index: 0 });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  test("negative index throws AssertionError", () => {
    expect(() => idempotencyKeyForAgentSeed({ agentId: AGENT_ID, index: -1 })).toThrow(
      AssertionError,
    );
  });
});

describe("assertValidKeyFormat", () => {
  test("assertValidKeyFormat_rejectsMalformed: non-hex string throws AssertionError", () => {
    expect(() => {
      assertValidKeyFormat("not-a-hex-digest");
    }).toThrow(AssertionError);
  });

  test("assertValidKeyFormat_rejectsMalformed: empty string throws AssertionError", () => {
    expect(() => {
      assertValidKeyFormat("");
    }).toThrow(AssertionError);
  });

  test("assertValidKeyFormat_rejectsMalformed: 63-char hex throws AssertionError", () => {
    expect(() => {
      assertValidKeyFormat("a".repeat(63));
    }).toThrow(AssertionError);
  });

  test("assertValidKeyFormat_accepts: valid 64-char hex digest passes", () => {
    const key = idempotencyKey(BASE);
    expect(() => {
      assertValidKeyFormat(key);
    }).not.toThrow();
  });
});
