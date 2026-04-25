import { describe, expect, test } from "bun:test";
import { assert, AssertionError } from "../../../src/core/assert.ts";
import type { HookDecide, HookDecision, HookMatcher, Hook } from "../../../src/hook/types.ts";
import { HOOK_EVENT } from "../../../src/hook/types.ts";
import { MAX_DENY_REASON_CHARS } from "../../../src/hook/limits.ts";
import { evaluateHookRecord } from "../../../src/hook/record.ts";
import { HookId } from "../../../src/ids.ts";

const EVENT = HOOK_EVENT.SessionStart;
const _hookIdResult = HookId.parse("00000000-0000-4000-8000-000000000001");
assert(_hookIdResult.ok, "test setup: invalid HOOK_ID");
const HOOK_ID = _hookIdResult.value;

function makeHook<P>(matcher: HookMatcher<P>, decision: HookDecide<P>): Hook<P> {
  return { id: HOOK_ID, layer: "system", event: EVENT, matcher, decision };
}

describe("evaluateHookRecord", () => {
  test("matcher returns false → decision is not called", async () => {
    let called = 0;
    const hook = makeHook<unknown>(
      () => false,
      () => {
        called++;
        return Promise.resolve({ decision: "approve" as const });
      },
    );
    const result = await evaluateHookRecord(hook, {});
    expect(result.matched).toBe(false);
    expect(called).toBe(0);
  });

  test("matcher true, approve → matched true with approve decision", async () => {
    const hook = makeHook<unknown>(
      () => true,
      () => Promise.resolve({ decision: "approve" as const }),
    );
    const result = await evaluateHookRecord(hook, {});
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.decision).toEqual({ decision: "approve" });
    }
  });

  test("matcher true, deny → reason is preserved", async () => {
    const hook = makeHook<unknown>(
      () => true,
      () => Promise.resolve({ decision: "deny" as const, reason: "not allowed" }),
    );
    const result = await evaluateHookRecord(hook, {});
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.decision).toEqual({ decision: "deny", reason: "not allowed" });
    }
  });

  test("matcher true, modify → payload is preserved", async () => {
    const replacement = { replaced: true };
    const hook = makeHook<Record<string, unknown>>(
      () => true,
      () => Promise.resolve({ decision: "modify" as const, payload: replacement }),
    );
    const result = await evaluateHookRecord(hook, { original: true });
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.decision).toEqual({ decision: "modify", payload: { replaced: true } });
    }
  });

  test("matcher returns undefined → AssertionError", async () => {
    expect.assertions(1);
    const badMatcher = (() => undefined) as unknown as HookMatcher<unknown>;
    const hook = makeHook<unknown>(badMatcher, () =>
      Promise.resolve({ decision: "approve" as const }),
    );
    try {
      await evaluateHookRecord(hook, {});
    } catch (e) {
      expect(e).toBeInstanceOf(AssertionError);
    }
  });

  test("matcher returns truthy non-boolean → AssertionError", async () => {
    expect.assertions(1);
    const badMatcher = (() => "yes") as unknown as HookMatcher<unknown>;
    const hook = makeHook<unknown>(badMatcher, () =>
      Promise.resolve({ decision: "approve" as const }),
    );
    try {
      await evaluateHookRecord(hook, {});
    } catch (e) {
      expect(e).toBeInstanceOf(AssertionError);
    }
  });

  test("decision returns deny with empty reason → AssertionError", async () => {
    expect.assertions(1);
    const hook = makeHook<unknown>(
      () => true,
      () => Promise.resolve({ decision: "deny" as const, reason: "" }),
    );
    try {
      await evaluateHookRecord(hook, {});
    } catch (e) {
      expect(e).toBeInstanceOf(AssertionError);
    }
  });

  test("decision returns deny with reason over MAX_DENY_REASON_CHARS → AssertionError", async () => {
    expect.assertions(1);
    const longReason = "x".repeat(MAX_DENY_REASON_CHARS + 1);
    const hook = makeHook<unknown>(
      () => true,
      () => Promise.resolve({ decision: "deny" as const, reason: longReason }),
    );
    try {
      await evaluateHookRecord(hook, {});
    } catch (e) {
      expect(e).toBeInstanceOf(AssertionError);
    }
  });

  test("async decision is awaited", async () => {
    const hook = makeHook<unknown>(
      () => true,
      () => Promise.resolve({ decision: "approve" as const }),
    );
    const result = await evaluateHookRecord(hook, {});
    expect(result.matched).toBe(true);
    if (result.matched) {
      expect(result.decision.decision).toBe("approve");
    }
  });

  test("matcher throws → exception propagates unchanged", async () => {
    expect.assertions(1);
    const err = new Error("matcher exploded");
    const hook = makeHook<unknown>(
      () => {
        throw err;
      },
      () => Promise.resolve({ decision: "approve" as const }),
    );
    try {
      await evaluateHookRecord(hook, {});
    } catch (e) {
      expect(e).toBe(err);
    }
  });

  test("decision throws → exception propagates unchanged", async () => {
    expect.assertions(1);
    const err = new Error("decision exploded");
    const hook = makeHook<unknown>(
      () => true,
      () => {
        throw err;
      },
    );
    try {
      await evaluateHookRecord(hook, {});
    } catch (e) {
      expect(e).toBe(err);
    }
  });

  test("decision returns unrecognized variant → AssertionError (exhaustive default)", async () => {
    expect.assertions(1);
    // The static type won't prevent a JS caller or a future unhandled discriminant from
    // reaching this path — the runtime guard in assertDecisionShape must hold regardless.
    const badDecision = { decision: "unknown_variant" } as unknown as HookDecision;
    const hook = makeHook<unknown>(
      () => true,
      () => Promise.resolve(badDecision),
    );
    try {
      await evaluateHookRecord(hook, {});
    } catch (e) {
      expect(e).toBeInstanceOf(AssertionError);
    }
  });
});
