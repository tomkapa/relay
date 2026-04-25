// Builtin tool schemas for ask and notify. These tools are special-cased in the turn-loop
// dispatcher and are NOT invoked through ToolRegistry (their "result" arrives asynchronously).
// RELAY-144 (ask) and RELAY-145 (notify surface).

import { z } from "zod";
import { err, ok, type Result } from "../core/result.ts";
import { AgentId } from "../ids.ts";
import type { AgentId as AgentIdBrand, ToolUseId as ToolUseIdBrand } from "../ids.ts";
import type { ToolSchema } from "./model.ts";

export const ASK_TOOL_NAME = "ask";
export const NOTIFY_TOOL_NAME = "notify";

export type BuiltinToolInput =
  | { readonly kind: "ask"; readonly targetAgentId: AgentIdBrand; readonly content: string }
  | { readonly kind: "notify"; readonly targetAgentId: AgentIdBrand; readonly content: string };

export type BuiltinToolInputError =
  | { kind: "validation_failed"; reason: string }
  | { kind: "target_agent_id_invalid"; reason: string };

const BuiltinInputSchema = z.object({
  target_agent_id: z.uuid(),
  content: z.string().min(1),
});

function parseBuiltinInput(
  kind: "ask" | "notify",
  raw: Readonly<Record<string, unknown>>,
): Result<BuiltinToolInput, BuiltinToolInputError> {
  const parsed = BuiltinInputSchema.safeParse(raw);
  if (!parsed.success) {
    return err({ kind: "validation_failed", reason: parsed.error.issues[0]?.message ?? "invalid" });
  }
  const agentResult = AgentId.parse(parsed.data.target_agent_id);
  if (!agentResult.ok) {
    return err({ kind: "target_agent_id_invalid", reason: agentResult.error.kind });
  }
  return ok({ kind, targetAgentId: agentResult.value, content: parsed.data.content });
}

export function parseAskInput(
  raw: Readonly<Record<string, unknown>>,
): Result<BuiltinToolInput & { kind: "ask" }, BuiltinToolInputError> {
  const r = parseBuiltinInput("ask", raw);
  if (!r.ok) return r;
  return ok(r.value as BuiltinToolInput & { kind: "ask" });
}

export function parseNotifyInput(
  raw: Readonly<Record<string, unknown>>,
): Result<BuiltinToolInput & { kind: "notify" }, BuiltinToolInputError> {
  const r = parseBuiltinInput("notify", raw);
  if (!r.ok) return r;
  return ok(r.value as BuiltinToolInput & { kind: "notify" });
}

export const askToolSchema: ToolSchema = {
  name: ASK_TOOL_NAME,
  description: "Send a question to a target agent and wait for their reply before continuing.",
  inputSchema: {
    type: "object",
    properties: {
      target_agent_id: { type: "string", format: "uuid" },
      content: { type: "string", minLength: 1 },
    },
    required: ["target_agent_id", "content"],
  },
};

export const notifyToolSchema: ToolSchema = {
  name: NOTIFY_TOOL_NAME,
  description: "Send a one-way notification to a target agent without waiting for a reply.",
  inputSchema: {
    type: "object",
    properties: {
      target_agent_id: { type: "string", format: "uuid" },
      content: { type: "string", minLength: 1 },
    },
    required: ["target_agent_id", "content"],
  },
};

// Produces a synthetic tool_result content for a validated tool_use_id.
export function builtinInlineError(toolUseId: ToolUseIdBrand, reason: string) {
  return {
    type: "tool_result" as const,
    toolUseId,
    content: reason,
    isError: true as const,
  };
}
