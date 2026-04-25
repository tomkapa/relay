import { afterEach, describe, expect, test } from "bun:test";
import { AssertionError, assert } from "../../../src/core/assert.ts";
import { MAX_HOOKS_PER_EVENT } from "../../../src/hook/limits.ts";
import {
  LAYER_ORDER,
  __clearRegistryForTesting,
  getRulesForEvent,
  registerHook,
} from "../../../src/hook/registry.ts";
import type { Hook, HookEvent, HookLayer } from "../../../src/hook/types.ts";
import { HOOK_EVENT } from "../../../src/hook/types.ts";
import { HookRecordId } from "../../../src/ids.ts";
import type { HookRecordId as HookRecordIdType } from "../../../src/ids.ts";

function makeId(tag: string): HookRecordIdType {
  const r = HookRecordId.parse(tag);
  assert(r.ok, `registry.test: invalid HookRecordId: ${tag}`);
  return r.value;
}

function makeHook<E extends HookEvent>(
  tag: string,
  event: E,
  layer: HookLayer = "system",
): Hook<E> {
  return {
    id: makeId(tag),
    layer,
    event,
    matcher: () => true,
    decision: () => Promise.resolve({ decision: "approve" as const }),
  };
}

afterEach(() => {
  __clearRegistryForTesting();
});

describe("LAYER_ORDER", () => {
  test("equals [system, organization, agent] in SPEC-mandated order", () => {
    expect(Array.from(LAYER_ORDER)).toEqual(["system", "organization", "agent"]);
  });

  test("is frozen — Object.isFrozen returns true", () => {
    expect(Object.isFrozen(LAYER_ORDER)).toBe(true);
  });
});

describe("registerHook / getRulesForEvent", () => {
  test("registered system hook is returned by getRulesForEvent", () => {
    const hook = makeHook("system/session_start/test-a", HOOK_EVENT.SessionStart);
    registerHook(hook);
    const rules = getRulesForEvent("system", HOOK_EVENT.SessionStart);
    expect(rules.length).toBe(1);
    expect(rules[0]?.id).toBe(hook.id);
  });

  test("preserves registration order for same (layer, event)", () => {
    const h1 = makeHook("system/session_start/first", HOOK_EVENT.SessionStart);
    const h2 = makeHook("system/session_start/second", HOOK_EVENT.SessionStart);
    const h3 = makeHook("system/session_start/third", HOOK_EVENT.SessionStart);
    registerHook(h1);
    registerHook(h2);
    registerHook(h3);
    const rules = getRulesForEvent("system", HOOK_EVENT.SessionStart);
    expect(rules.length).toBe(3);
    expect(rules[0]?.id).toBe(h1.id);
    expect(rules[1]?.id).toBe(h2.id);
    expect(rules[2]?.id).toBe(h3.id);
  });

  test("hooks for different events in the same layer are isolated", () => {
    registerHook(makeHook("system/session_start/hook-a", HOOK_EVENT.SessionStart));
    registerHook(makeHook("system/pre_tool_use/hook-b", HOOK_EVENT.PreToolUse));
    expect(getRulesForEvent("system", HOOK_EVENT.SessionStart).length).toBe(1);
    expect(getRulesForEvent("system", HOOK_EVENT.PreToolUse).length).toBe(1);
    expect(getRulesForEvent("system", HOOK_EVENT.PostToolUse).length).toBe(0);
  });

  test("unregistered event returns empty array", () => {
    const rules = getRulesForEvent("system", HOOK_EVENT.SessionEnd);
    expect(rules).toEqual([]);
    expect(rules.length).toBe(0);
  });

  test("organization layer returns empty array before any registration", () => {
    expect(getRulesForEvent("organization", HOOK_EVENT.SessionStart).length).toBe(0);
    expect(getRulesForEvent("organization", HOOK_EVENT.PreToolUse).length).toBe(0);
  });

  test("agent layer returns empty array before any registration", () => {
    expect(getRulesForEvent("agent", HOOK_EVENT.SessionStart).length).toBe(0);
    expect(getRulesForEvent("agent", HOOK_EVENT.PreToolUse).length).toBe(0);
  });

  test("registerHook accepts layer=organization", () => {
    const hook = makeHook("system/session_start/org-hook", HOOK_EVENT.SessionStart, "organization");
    expect(() => {
      registerHook(hook);
    }).not.toThrow();
    expect(getRulesForEvent("organization", HOOK_EVENT.SessionStart).length).toBe(1);
  });

  test("registerHook accepts layer=agent", () => {
    const hook = makeHook("system/session_start/agent-hook", HOOK_EVENT.SessionStart, "agent");
    expect(() => {
      registerHook(hook);
    }).not.toThrow();
    expect(getRulesForEvent("agent", HOOK_EVENT.SessionStart).length).toBe(1);
  });

  test("hooks in different layers for the same event are fully isolated", () => {
    registerHook(makeHook("system/session_start/sys-hook", HOOK_EVENT.SessionStart, "system"));
    registerHook(
      makeHook("system/session_start/org-hook", HOOK_EVENT.SessionStart, "organization"),
    );
    expect(getRulesForEvent("system", HOOK_EVENT.SessionStart).length).toBe(1);
    expect(getRulesForEvent("organization", HOOK_EVENT.SessionStart).length).toBe(1);
    expect(getRulesForEvent("agent", HOOK_EVENT.SessionStart).length).toBe(0);
  });

  test("same hook id allowed in different layers — duplicate check is per-bucket", () => {
    const sysHook = makeHook("system/session_start/shared-id", HOOK_EVENT.SessionStart, "system");
    const orgHook: Hook<"session_start"> = { ...sysHook, layer: "organization" };
    expect(() => {
      registerHook(sysHook);
      registerHook(orgHook);
    }).not.toThrow();
  });

  test("getRulesForEvent returns ReadonlyArray<Hook<E>> narrowed to the requested event", () => {
    registerHook(makeHook("system/pre_tool_use/typed-hook", HOOK_EVENT.PreToolUse));
    const rules = getRulesForEvent("system", HOOK_EVENT.PreToolUse);
    expect(rules.length).toBe(1);
    // Compile-time: rules is ReadonlyArray<Hook<"pre_tool_use">>
    // If the cast in getRulesForEvent is wrong, a later task that uses the typed payload
    // in a matcher/decision would fail to compile.
    expect(rules[0]?.event).toBe("pre_tool_use");
  });
});

describe("registerHook — assertion failures", () => {
  test("rejects duplicate id in the same (layer, event) bucket → AssertionError", () => {
    const hook = makeHook("system/session_start/dup", HOOK_EVENT.SessionStart);
    registerHook(hook);
    expect(() => {
      registerHook(hook);
    }).toThrow(AssertionError);
  });

  test("per-(layer,event) cap: 64 system hooks for event E does not block 64 org hooks for same event", () => {
    for (let i = 0; i < MAX_HOOKS_PER_EVENT; i++) {
      registerHook(
        makeHook(`system/session_start/sys-hook-${i.toString()}`, HOOK_EVENT.SessionStart),
      );
    }
    // org bucket for the same event is completely independent
    for (let i = 0; i < MAX_HOOKS_PER_EVENT; i++) {
      expect(() => {
        registerHook(
          makeHook(
            `system/session_start/org-hook-${i.toString()}`,
            HOOK_EVENT.SessionStart,
            "organization",
          ),
        );
      }).not.toThrow();
    }
    expect(getRulesForEvent("system", HOOK_EVENT.SessionStart).length).toBe(MAX_HOOKS_PER_EVENT);
    expect(getRulesForEvent("organization", HOOK_EVENT.SessionStart).length).toBe(
      MAX_HOOKS_PER_EVENT,
    );
  });

  test("rejects beyond MAX_HOOKS_PER_EVENT within one (layer, event) bucket → AssertionError", () => {
    for (let i = 0; i < MAX_HOOKS_PER_EVENT; i++) {
      registerHook(makeHook(`system/session_start/hook-${i.toString()}`, HOOK_EVENT.SessionStart));
    }
    expect(() => {
      registerHook(makeHook(`system/session_start/hook-overflow`, HOOK_EVENT.SessionStart));
    }).toThrow(AssertionError);
  });
});

describe("__clearRegistryForTesting", () => {
  test("empties all three layer maps", () => {
    registerHook(makeHook("system/session_start/sys", HOOK_EVENT.SessionStart, "system"));
    registerHook(makeHook("system/session_start/org", HOOK_EVENT.SessionStart, "organization"));
    registerHook(makeHook("system/session_start/agt", HOOK_EVENT.SessionStart, "agent"));

    __clearRegistryForTesting();

    expect(getRulesForEvent("system", HOOK_EVENT.SessionStart).length).toBe(0);
    expect(getRulesForEvent("organization", HOOK_EVENT.SessionStart).length).toBe(0);
    expect(getRulesForEvent("agent", HOOK_EVENT.SessionStart).length).toBe(0);
  });
});
