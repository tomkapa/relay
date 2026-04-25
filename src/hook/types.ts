// Shared hook types used by stubs, evaluator (RELAY-138), and call sites.
// HookResult promoted from trigger/handlers.ts local declaration.

import type { AgentId, SessionId, TenantId, ToolUseId, TurnId } from "../ids.ts";

// Canonical decision returned by a hook's decide-fn and by evaluateHook.
// `modify` carries a transformed payload (shape fills in with RELAY-138).
export type HookDecision =
  | { readonly decision: "approve" }
  | { readonly decision: "deny"; readonly reason: string }
  | { readonly decision: "modify"; readonly payload: HookPayload };

// Backward-compat alias — existing stubs return HookResult which is the same union.
export type HookResult = HookDecision;

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

// Payload union — one variant per event kind. Shapes fill in with RELAY-138.
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

export type HookSeams = {
  readonly preToolUse: (payload: PreToolUsePayload) => Promise<HookResult>;
  readonly postToolUse: (payload: PostToolUsePayload) => Promise<HookResult>;
};
