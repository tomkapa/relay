// Shared hook types used by stubs, evaluator (RELAY-138), and call sites.
// HookResult promoted from trigger/handlers.ts local declaration.

import type { AgentId, SessionId, TenantId, ToolUseId, TurnId } from "../ids.ts";

export type HookResult = { decision: "approve" } | { decision: "deny"; reason: string };

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
