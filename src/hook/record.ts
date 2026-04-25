// Pure single-record evaluator. Enforces the SPEC §Hooks matcher/decision split:
// the matcher runs unconditionally; the decision runs only when the matcher passes.
// No telemetry, no timeout — both are the caller's responsibility (RELAY-136, RELAY-138).

import { assert, assertNever } from "../core/assert.ts";
import type { PayloadFor } from "./payloads.ts";
import { MAX_DENY_REASON_CHARS } from "./limits.ts";
import type { Hook, HookDecision, HookEvaluation, HookEvent } from "./types.ts";

export async function evaluateHookRecord<E extends HookEvent>(
  hook: Hook<E>,
  payload: PayloadFor<E>,
): Promise<HookEvaluation<PayloadFor<E>>> {
  const matched = hook.matcher(payload);

  // A matcher returning undefined/"yes"/etc. is a programmer error — crash loudly
  // rather than silently gate decisions on truthiness. CLAUDE.md §6.
  assert(typeof matched === "boolean", "evaluateHookRecord: matcher must return boolean", {
    hookId: hook.id,
    event: hook.event,
    got: typeof matched,
  });

  if (!matched) return { matched: false };

  const decision = await hook.decision(payload);

  assertDecisionShape(decision, hook.id);

  return { matched: true, decision };
}

function assertDecisionShape<TPayload>(decision: HookDecision<TPayload>, hookId: Hook["id"]): void {
  switch (decision.decision) {
    case "approve":
      return;
    case "deny":
      assert(decision.reason.length > 0, "evaluateHookRecord: deny must carry non-empty reason", {
        hookId,
      });
      assert(
        decision.reason.length <= MAX_DENY_REASON_CHARS,
        "evaluateHookRecord: deny reason exceeds cap",
        { hookId, length: decision.reason.length, max: MAX_DENY_REASON_CHARS },
      );
      return;
    case "modify":
      assert(decision.payload !== undefined, "evaluateHookRecord: modify must carry payload", {
        hookId,
      });
      return;
    default:
      // Exhaustive — TypeScript proves this unreachable. CLAUDE.md §1 pattern.
      assertNever(decision, "evaluateHookRecord: unexpected decision shape");
  }
}
