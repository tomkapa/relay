import { describe, expect, test } from "bun:test";
import { assert, AssertionError } from "../../../src/core/assert.ts";
import type { Hook, HookDecision, HookEvent } from "../../../src/hook/types.ts";
import { HOOK_EVENT } from "../../../src/hook/types.ts";
import type { PayloadFor, PreToolUsePayload } from "../../../src/hook/payloads.ts";
import { MAX_DENY_REASON_CHARS } from "../../../src/hook/limits.ts";
import { evaluateHookRecord } from "../../../src/hook/record.ts";
import {
  HookRecordId,
  TenantId,
  AgentId,
  SessionId,
  TurnId,
  ToolUseId,
  mintId,
} from "../../../src/ids.ts";

const _hookIdResult = HookRecordId.parse("00000000-0000-4000-8000-000000000001");
assert(_hookIdResult.ok, "test setup: invalid HOOK_ID");
const HOOK_ID = _hookIdResult.value;

// Fixtures for PreToolUsePayload — used throughout this test file.
function makeTenantId() {
  const r = TenantId.parse("00000000-0000-4000-8000-000000000010");
  assert(r.ok, "fixture: invalid TenantId");
  return r.value;
}
function makeAgentId() {
  const r = AgentId.parse("00000000-0000-4000-8000-000000000020");
  assert(r.ok, "fixture: invalid AgentId");
  return r.value;
}
function makeSessionId() {
  const r = SessionId.parse("00000000-0000-4000-8000-000000000030");
  assert(r.ok, "fixture: invalid SessionId");
  return r.value;
}

const TENANT_ID = makeTenantId();
const AGENT_ID = makeAgentId();
const SESSION_ID = makeSessionId();

function makeTurnId() {
  return mintId(TurnId.parse, "test");
}
function makeToolUseId() {
  const r = ToolUseId.parse("test-tool-use");
  assert(r.ok, "fixture: invalid ToolUseId");
  return r.value;
}

function makePreToolPayload(): PreToolUsePayload {
  return {
    tenantId: TENANT_ID,
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    turnId: makeTurnId(),
    toolUseId: makeToolUseId(),
    toolName: "bash",
    toolInput: {},
  };
}

function makeHook<E extends HookEvent>(
  event: E,
  matcher: (payload: PayloadFor<E>) => boolean,
  decision: (
    payload: PayloadFor<E>,
  ) => HookDecision<PayloadFor<E>> | Promise<HookDecision<PayloadFor<E>>>,
): Hook<E> {
  return { id: HOOK_ID, layer: "system", event, matcher, decision };
}

describe("evaluateHookRecord", () => {
  test("matcher returns false → decision is not called", async () => {
    let called = 0;
    const hook = makeHook(
      HOOK_EVENT.PreToolUse,
      () => false,
      () => {
        called++;
        return Promise.resolve({ decision: "approve" as const });
      },
    );
    const result = await evaluateHookRecord(hook, makePreToolPayload());
    expect(result.matched).toBe(false);
    expect(called).toBe(0);
  });

  test("matcher true, approve → matched true with approve decision", async () => {
    const hook = makeHook(
      HOOK_EVENT.PreToolUse,
      () => true,
      () => Promise.resolve({ decision: "approve" as const }),
    );
    const result = await evaluateHookRecord(hook, makePreToolPayload());
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.decision).toEqual({ decision: "approve" });
    }
  });

  test("matcher true, deny → reason is preserved", async () => {
    const hook = makeHook(
      HOOK_EVENT.PreToolUse,
      () => true,
      () => Promise.resolve({ decision: "deny" as const, reason: "not allowed" }),
    );
    const result = await evaluateHookRecord(hook, makePreToolPayload());
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.decision).toEqual({ decision: "deny", reason: "not allowed" });
    }
  });

  test("matcher true, modify → payload is preserved", async () => {
    const original = makePreToolPayload();
    const modified = { ...original, toolInput: { replaced: true } };
    const hook = makeHook(
      HOOK_EVENT.PreToolUse,
      () => true,
      () => Promise.resolve({ decision: "modify" as const, payload: modified }),
    );
    const result = await evaluateHookRecord(hook, original);
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.decision).toEqual({ decision: "modify", payload: modified });
    }
  });

  test("matcher returns undefined → AssertionError", async () => {
    expect.assertions(1);
    const badMatcher = (() => undefined) as unknown as (p: PreToolUsePayload) => boolean;
    const hook = makeHook(HOOK_EVENT.PreToolUse, badMatcher, () =>
      Promise.resolve({ decision: "approve" as const }),
    );
    try {
      await evaluateHookRecord(hook, makePreToolPayload());
    } catch (e) {
      expect(e).toBeInstanceOf(AssertionError);
    }
  });

  test("matcher returns truthy non-boolean → AssertionError", async () => {
    expect.assertions(1);
    const badMatcher = (() => "yes") as unknown as (p: PreToolUsePayload) => boolean;
    const hook = makeHook(HOOK_EVENT.PreToolUse, badMatcher, () =>
      Promise.resolve({ decision: "approve" as const }),
    );
    try {
      await evaluateHookRecord(hook, makePreToolPayload());
    } catch (e) {
      expect(e).toBeInstanceOf(AssertionError);
    }
  });

  test("decision returns deny with empty reason → AssertionError", async () => {
    expect.assertions(1);
    const hook = makeHook(
      HOOK_EVENT.PreToolUse,
      () => true,
      () => Promise.resolve({ decision: "deny" as const, reason: "" }),
    );
    try {
      await evaluateHookRecord(hook, makePreToolPayload());
    } catch (e) {
      expect(e).toBeInstanceOf(AssertionError);
    }
  });

  test("decision returns deny with reason over MAX_DENY_REASON_CHARS → AssertionError", async () => {
    expect.assertions(1);
    const longReason = "x".repeat(MAX_DENY_REASON_CHARS + 1);
    const hook = makeHook(
      HOOK_EVENT.PreToolUse,
      () => true,
      () => Promise.resolve({ decision: "deny" as const, reason: longReason }),
    );
    try {
      await evaluateHookRecord(hook, makePreToolPayload());
    } catch (e) {
      expect(e).toBeInstanceOf(AssertionError);
    }
  });

  test("async decision is awaited", async () => {
    const hook = makeHook(
      HOOK_EVENT.PreToolUse,
      () => true,
      () => Promise.resolve({ decision: "approve" as const }),
    );
    const result = await evaluateHookRecord(hook, makePreToolPayload());
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.decision.decision).toBe("approve");
    }
  });

  test("matcher throws → exception propagates unchanged", async () => {
    expect.assertions(1);
    const err = new Error("matcher exploded");
    const hook = makeHook(
      HOOK_EVENT.PreToolUse,
      () => {
        throw err;
      },
      () => Promise.resolve({ decision: "approve" as const }),
    );
    try {
      await evaluateHookRecord(hook, makePreToolPayload());
    } catch (e) {
      expect(e).toBe(err);
    }
  });

  test("decision throws → exception propagates unchanged", async () => {
    expect.assertions(1);
    const err = new Error("decision exploded");
    const hook = makeHook(
      HOOK_EVENT.PreToolUse,
      () => true,
      () => {
        throw err;
      },
    );
    try {
      await evaluateHookRecord(hook, makePreToolPayload());
    } catch (e) {
      expect(e).toBe(err);
    }
  });

  test("decision returns unrecognized variant → AssertionError (exhaustive default)", async () => {
    expect.assertions(1);
    const badDecision = { decision: "unknown_variant" } as unknown as HookDecision;
    const hook = makeHook(
      HOOK_EVENT.PreToolUse,
      () => true,
      () => Promise.resolve(badDecision as HookDecision<PreToolUsePayload>),
    );
    try {
      await evaluateHookRecord(hook, makePreToolPayload());
    } catch (e) {
      expect(e).toBeInstanceOf(AssertionError);
    }
  });
});
