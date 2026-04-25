import { afterEach, describe, expect, test } from "bun:test";
import { AssertionError, assert } from "../../../src/core/assert.ts";
import { MAX_HOOKS_PER_EVENT } from "../../../src/hook/limits.ts";
import {
  __clearRegistryForTesting,
  getRulesForEvent,
  registerHook,
} from "../../../src/hook/registry.ts";
import type { Hook, HookEvent } from "../../../src/hook/types.ts";
import { HOOK_EVENT } from "../../../src/hook/types.ts";
import { HookRecordId } from "../../../src/ids.ts";
import type { HookRecordId as HookRecordIdType } from "../../../src/ids.ts";

function makeId(tag: string): HookRecordIdType {
  const r = HookRecordId.parse(tag);
  assert(r.ok, `registry.test: invalid HookRecordId: ${tag}`);
  return r.value;
}

function makeHook(tag: string, event: HookEvent = HOOK_EVENT.SessionStart): Hook<unknown> {
  return {
    id: makeId(tag),
    layer: "system",
    event,
    matcher: () => true,
    decision: () => Promise.resolve({ decision: "approve" }),
  };
}

afterEach(() => {
  __clearRegistryForTesting();
});

describe("registerHook / getRulesForEvent", () => {
  test("registered hook is returned by getRulesForEvent", () => {
    const hook = makeHook("system/session_start/test-a");
    registerHook(hook);
    const rules = getRulesForEvent(HOOK_EVENT.SessionStart);
    expect(rules.length).toBe(1);
    expect(rules[0]?.id).toBe(hook.id);
  });

  test("preserves registration order for same event", () => {
    const h1 = makeHook("system/session_start/first");
    const h2 = makeHook("system/session_start/second");
    const h3 = makeHook("system/session_start/third");
    registerHook(h1);
    registerHook(h2);
    registerHook(h3);
    const rules = getRulesForEvent(HOOK_EVENT.SessionStart);
    expect(rules.length).toBe(3);
    expect(rules[0]?.id).toBe(h1.id);
    expect(rules[1]?.id).toBe(h2.id);
    expect(rules[2]?.id).toBe(h3.id);
  });

  test("hooks for different events are isolated", () => {
    registerHook(makeHook("system/session_start/hook-a", HOOK_EVENT.SessionStart));
    registerHook(makeHook("system/pre_tool_use/hook-b", HOOK_EVENT.PreToolUse));
    expect(getRulesForEvent(HOOK_EVENT.SessionStart).length).toBe(1);
    expect(getRulesForEvent(HOOK_EVENT.PreToolUse).length).toBe(1);
    expect(getRulesForEvent(HOOK_EVENT.PostToolUse).length).toBe(0);
  });

  test("unregistered event returns empty array", () => {
    const rules = getRulesForEvent(HOOK_EVENT.SessionEnd);
    expect(rules).toEqual([]);
    expect(rules.length).toBe(0);
  });
});

describe("registerHook — assertion failures", () => {
  test("rejects layer != system → AssertionError", () => {
    const hook: Hook<unknown> = {
      id: makeId("system/session_start/org-hook"),
      layer: "organization",
      event: HOOK_EVENT.SessionStart,
      matcher: () => true,
      decision: () => Promise.resolve({ decision: "approve" }),
    };
    expect(() => {
      registerHook(hook);
    }).toThrow(AssertionError);
  });

  test("rejects duplicate id in the same event bucket → AssertionError", () => {
    const hook = makeHook("system/session_start/dup");
    registerHook(hook);
    expect(() => {
      registerHook(hook);
    }).toThrow(AssertionError);
  });

  test("rejects beyond MAX_HOOKS_PER_EVENT → AssertionError", () => {
    for (let i = 0; i < MAX_HOOKS_PER_EVENT; i++) {
      registerHook(makeHook(`system/session_start/hook-${i.toString()}`));
    }
    expect(() => {
      registerHook(makeHook(`system/session_start/hook-overflow`));
    }).toThrow(AssertionError);
  });
});

describe("__clearRegistryForTesting", () => {
  test("empties all buckets", () => {
    registerHook(makeHook("system/session_start/c1", HOOK_EVENT.SessionStart));
    registerHook(makeHook("system/pre_tool_use/c2", HOOK_EVENT.PreToolUse));
    __clearRegistryForTesting();
    expect(getRulesForEvent(HOOK_EVENT.SessionStart).length).toBe(0);
    expect(getRulesForEvent(HOOK_EVENT.PreToolUse).length).toBe(0);
  });
});
