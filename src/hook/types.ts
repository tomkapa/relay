// Shared hook types used by the registry, evaluator, and call sites.

import type { HookRecordId } from "../ids.ts";
import type { HookEventPayload, PayloadFor } from "./payloads.ts";

// Canonical three-variant decision. SPEC §Composition — modify is a first-class outcome.
// `modify` carries a replacement payload; how modify outputs chain is RELAY-139's concern.
export type HookDecision<TPayload = unknown> =
  | { readonly decision: "approve" }
  | { readonly decision: "deny"; readonly reason: string }
  | { readonly decision: "modify"; readonly payload: TPayload };

// Three-layer composition (RELAY-139). Today all evaluations are "system".
export type HookLayer = "system" | "organization" | "agent";

// Lifecycle events the hook subsystem observes (matches hook_audit.event CHECK constraint).
export type HookEvent =
  | "session_start"
  | "session_end"
  | "pre_tool_use"
  | "post_tool_use"
  | "pre_message_receive"
  | "pre_message_send"
  | "agent_create";

// Named constants for HookEvent values. `as const satisfies` preserves the literal type so
// generic E is correctly inferred from HOOK_EVENT.SessionStart rather than widened to HookEvent.
// Object.freeze prevents accidental mutation (test verifies isFrozen).
export const HOOK_EVENT = Object.freeze({
  SessionStart: "session_start",
  SessionEnd: "session_end",
  PreToolUse: "pre_tool_use",
  PostToolUse: "post_tool_use",
  PreMessageReceive: "pre_message_receive",
  PreMessageSend: "pre_message_send",
  AgentCreate: "agent_create",
} as const satisfies Record<string, HookEvent>);

// Synchronous predicate over a typed payload. Exported for call sites that name the type explicitly.
export type HookMatcher<TPayload> = (payload: TPayload) => boolean;

// Decision function — may be async for CEL predicates and future LLM-as-judge integrations.
export type HookDecide<TPayload> = (
  payload: TPayload,
) => HookDecision<TPayload> | Promise<HookDecision<TPayload>>;

// Canonical hook record. Generic over the event tag so the matcher and decision are
// typed to exactly the right payload for that event. The default = HookEvent lets the
// registry store Hook[] (i.e. Hook<HookEvent>) in heterogeneous buckets; registration
// call sites narrow to a literal (Hook<"pre_tool_use">).
// id is HookRecordId (UUID or system/<event>/<name>) — not HookId which is UUID-only.
export type Hook<E extends HookEvent = HookEvent> = {
  readonly id: HookRecordId;
  readonly layer: HookLayer;
  readonly event: E;
  readonly matcher: (payload: PayloadFor<E>) => boolean;
  readonly decision: (
    payload: PayloadFor<E>,
  ) => HookDecision<PayloadFor<E>> | Promise<HookDecision<PayloadFor<E>>>;
};

// Result of evaluating one Hook record. matched=false means the matcher short-circuited
// before the decision ran — the core invariant of the matcher/decision split.
export type HookEvaluation<TPayload> =
  | { readonly matched: false }
  | { readonly matched: true; readonly decision: HookDecision<TPayload> };

// Re-export for callers that assemble HookEventPayload directly.
export type { HookEventPayload };
// Re-export so callers can import HookConfigSnapshot from types.ts rather than snapshot.ts.
export type { HookConfigSnapshot } from "./snapshot.ts";
