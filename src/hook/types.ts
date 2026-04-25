// Shared hook types used by stubs, evaluator (RELAY-138), and call sites.

import type { AgentId, HookId, SessionId, TenantId, ToolUseId, TurnId } from "../ids.ts";

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
  | "pre_message_send";

// Named constants for HookEvent values. Prefer these over raw string literals at call sites.
// RELAY-140 will replace this with a stricter branded type and parse boundary.
export const HOOK_EVENT = Object.freeze({
  SessionStart: "session_start",
  SessionEnd: "session_end",
  PreToolUse: "pre_tool_use",
  PostToolUse: "post_tool_use",
  PreMessageReceive: "pre_message_receive",
  PreMessageSend: "pre_message_send",
} as const satisfies Record<string, HookEvent>);

// Payload union — one variant per event kind. Shapes fill in with RELAY-140.
// Placeholder until the real CEL predicate evaluator needs typed access to the payload.
export type HookPayload = Record<string, unknown>;

export type PreToolUsePayload = {
  readonly sessionId: SessionId;
  readonly agentId: AgentId;
  readonly tenantId: TenantId;
  readonly turnId: TurnId;
  readonly toolUseId: ToolUseId;
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
};

export type PostToolUsePayload = {
  readonly sessionId: SessionId;
  readonly agentId: AgentId;
  readonly tenantId: TenantId;
  readonly turnId: TurnId;
  readonly toolUseId: ToolUseId;
  readonly toolName: string;
  readonly outcome: "invoked" | "tool_error";
};

// Synchronous predicate over a payload. Matchers are a hot path (called on every event),
// so async is intentionally excluded — see SPEC §Hooks for the design rationale.
export type HookMatcher<TPayload> = (payload: TPayload) => boolean;

// Decision function — may be async for CEL predicates and future LLM-as-judge integrations.
export type HookDecide<TPayload> = (
  payload: TPayload,
) => HookDecision<TPayload> | Promise<HookDecision<TPayload>>;

// Canonical hook record. Stored in the registry (RELAY-138) keyed by event.
export type Hook<TPayload> = {
  readonly id: HookId;
  readonly layer: HookLayer;
  readonly event: HookEvent;
  readonly matcher: HookMatcher<TPayload>;
  readonly decision: HookDecide<TPayload>;
};

// Result of evaluating one Hook record. matched=false means the matcher short-circuited
// before the decision ran — the core invariant of the matcher/decision split.
export type HookEvaluation<TPayload> =
  | { readonly matched: false }
  | { readonly matched: true; readonly decision: HookDecision<TPayload> };

export type HookSeams = {
  readonly preToolUse: (payload: PreToolUsePayload) => Promise<HookDecision>;
  readonly postToolUse: (payload: PostToolUsePayload) => Promise<HookDecision>;
};
