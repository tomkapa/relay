import { describe, expect, test } from "bun:test";
import { assertNever } from "../../../src/core/assert.ts";
import { HOOK_EVENT } from "../../../src/hook/types.ts";
import type { HookDecision } from "../../../src/hook/types.ts";

describe("HookDecision", () => {
  test("switch over all three variants is exhaustive at compile time", () => {
    function classify(d: HookDecision): string {
      switch (d.decision) {
        case "approve":
          return "approve";
        case "deny":
          return "deny";
        case "modify":
          return "modify";
        default:
          assertNever(d, "unexpected HookDecision variant");
      }
    }
    expect(classify({ decision: "approve" })).toBe("approve");
    expect(classify({ decision: "deny", reason: "blocked" })).toBe("deny");
    expect(classify({ decision: "modify", payload: {} })).toBe("modify");
  });
});

describe("HOOK_EVENT", () => {
  test("SessionStart equals the string session_start", () => {
    expect(HOOK_EVENT.SessionStart).toBe("session_start");
  });

  test("all six lifecycle events are present", () => {
    expect(HOOK_EVENT.SessionStart).toBe("session_start");
    expect(HOOK_EVENT.SessionEnd).toBe("session_end");
    expect(HOOK_EVENT.PreToolUse).toBe("pre_tool_use");
    expect(HOOK_EVENT.PostToolUse).toBe("post_tool_use");
    expect(HOOK_EVENT.PreMessageReceive).toBe("pre_message_receive");
    expect(HOOK_EVENT.PreMessageSend).toBe("pre_message_send");
    expect(Object.keys(HOOK_EVENT)).toHaveLength(6);
  });

  test("constant is frozen", () => {
    expect(Object.isFrozen(HOOK_EVENT)).toBe(true);
  });
});
