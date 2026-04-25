// Pass-through hook stubs. Always approve. RELAY-138 replaces these with the real evaluator.
// Uses typed arrow consts (no declared params) so the linter stays quiet — same pattern as
// hookStub / preMessageReceiveStub in trigger/handlers.ts.

import type { HookDecision, PostToolUsePayload, PreToolUsePayload } from "./types.ts";

export const preToolUseStub: (payload: PreToolUsePayload) => Promise<HookDecision> = () =>
  Promise.resolve({ decision: "approve" });

export const postToolUseStub: (payload: PostToolUsePayload) => Promise<HookDecision> = () =>
  Promise.resolve({ decision: "approve" });
