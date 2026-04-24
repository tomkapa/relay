// ToolRegistry seam: the turn loop depends on this interface, not on any specific tool
// implementation. InMemoryToolRegistry is the default; MCP connectors plug in here (RELAY-11).

import type { AgentId, SessionId, TenantId, ToolUseId, TurnId } from "../ids.ts";
import type { ToolSchema } from "./model.ts";

export type ToolInvocationContext = {
  readonly sessionId: SessionId;
  readonly agentId: AgentId;
  readonly tenantId: TenantId;
  readonly turnId: TurnId;
  readonly toolUseId: ToolUseId;
};

export type ToolResult =
  | { readonly ok: true; readonly content: string }
  | { readonly ok: false; readonly errorMessage: string };

export interface ToolRegistry {
  list(): readonly ToolSchema[];
  invoke(params: {
    readonly name: string;
    readonly input: Readonly<Record<string, unknown>>;
    readonly ctx: ToolInvocationContext;
    readonly signal: AbortSignal;
  }): Promise<ToolResult>;
}
