// Per-event payload types for the hook subsystem. One type per SPEC §Hooks lifecycle event.
// Kept separate from src/hook/types.ts so cross-domain imports (session, ids) are localized here.

import type {
  AgentId,
  ChainId,
  Depth,
  InboundMessageId,
  SessionId,
  TenantId,
  ToolUseId,
  TurnId,
} from "../ids.ts";
import type { SessionEndReason } from "../session/close.ts";
import type { HookEvent } from "./types.ts";

// Sender info — matches the InboundMessagePayload.sender shape from trigger/inbound/payload.ts.
// Re-exported so PreMessageReceive hook authors have one canonical import.
export type HookSender =
  | { readonly type: "human"; readonly id: string; readonly displayName?: string }
  | { readonly type: "agent"; readonly id: string; readonly displayName?: string }
  | { readonly type: "system"; readonly id: string; readonly displayName?: string };

export type SessionStartPayload = Readonly<{
  tenantId: TenantId;
  agentId: AgentId;
  sessionId: SessionId;
  chainId: ChainId;
  depth: Depth;
  parentSessionId: SessionId | null;
  // Origin trigger. SessionStart hooks can branch on kind — e.g. rate-limit task_fire only.
  triggerKind: "session_start" | "task_fire" | "inbound_message";
}>;

export type SessionEndPayload = Readonly<{
  tenantId: TenantId;
  agentId: AgentId;
  sessionId: SessionId;
  reason: SessionEndReason;
  closedAt: Date;
  createdAt: Date;
  // Pre-computed for hook convenience — same value as the session.close span attribute.
  durationMs: number;
}>;

export type PreToolUsePayload = Readonly<{
  tenantId: TenantId;
  agentId: AgentId;
  sessionId: SessionId;
  turnId: TurnId;
  toolUseId: ToolUseId;
  toolName: string;
  toolInput: Readonly<Record<string, unknown>>;
}>;

export type PostToolUsePayload = Readonly<{
  tenantId: TenantId;
  agentId: AgentId;
  sessionId: SessionId;
  turnId: TurnId;
  toolUseId: ToolUseId;
  toolName: string;
  outcome: "invoked" | "tool_error";
  toolResult:
    | { readonly kind: "ok"; readonly content: string }
    | { readonly kind: "error"; readonly errorMessage: string };
}>;

export type PreMessageReceivePayload = Readonly<{
  tenantId: TenantId;
  targetAgentId: AgentId;
  targetSessionId: SessionId;
  inboundMessageId: InboundMessageId;
  sender: HookSender;
  content: string;
  receivedAt: Date;
}>;

export type PreMessageSendPayload = Readonly<{
  tenantId: TenantId;
  senderAgentId: AgentId;
  senderSessionId: SessionId;
  turnId: TurnId;
  target:
    | { readonly type: "agent"; readonly agentId: AgentId }
    | { readonly type: "human"; readonly externalId: string };
  kind: "ask" | "notify";
  content: string;
  // Stable send identity per SPEC §Retry. Hooks that dedup by send identity read this;
  // modify hooks rewriting content do NOT change it.
  idempotencyKey: string;
}>;

// Discriminated union — the type-level lookup uses Extract<...> to resolve event → payload.
// Listing a new event without its payload pair causes PayloadFor<E> to return never,
// breaking all call sites at compile time. Same exhaustive-coverage trick as CLAUDE.md §1.
export type HookEventPayload =
  | { readonly event: "session_start"; readonly payload: SessionStartPayload }
  | { readonly event: "session_end"; readonly payload: SessionEndPayload }
  | { readonly event: "pre_tool_use"; readonly payload: PreToolUsePayload }
  | { readonly event: "post_tool_use"; readonly payload: PostToolUsePayload }
  | { readonly event: "pre_message_receive"; readonly payload: PreMessageReceivePayload }
  | { readonly event: "pre_message_send"; readonly payload: PreMessageSendPayload };

// Compile-time event → payload lookup. A missing pair returns never, breaking call sites.
export type PayloadFor<E extends HookEvent> = Extract<HookEventPayload, { event: E }>["payload"];
