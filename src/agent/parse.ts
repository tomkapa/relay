// Boundary parser for agent creation requests. Zod validates shape; smart constructors
// produce branded types. No raw strings escape this file into the domain core.
// See CLAUDE.md §1 (Parse, don't validate) and §12 (one error type per boundary).

import { z } from "zod";
import { err, ok, type Result } from "../core/result.ts";
import { TenantId } from "../ids.ts";
import type { TenantId as TenantIdBrand } from "../ids.ts";
import {
  MAX_HOOK_RULE_BYTES,
  MAX_HOOK_RULE_NAME_LEN,
  MAX_HOOK_RULES_PER_AGENT,
  MAX_SYSTEM_PROMPT_LEN,
  MAX_TOOL_DESCRIPTOR_BYTES,
  MAX_TOOL_NAME_LEN,
  MAX_TOOL_SET_SIZE,
} from "./limits.ts";

// ToolDescriptor and HookRuleLiteral are intentionally loose for this task.
// The tool registry and hook evaluator own their respective shapes.
export type ToolDescriptor = { readonly name: string; readonly [key: string]: unknown };
export type HookRuleLiteral = { readonly name: string; readonly [key: string]: unknown };

export type AgentCreateSpec = {
  readonly tenantId: TenantIdBrand;
  readonly systemPrompt: string;
  readonly toolSet: readonly ToolDescriptor[];
  readonly hookRules: readonly HookRuleLiteral[];
};

export type AgentParseError =
  | { kind: "validation_failed"; issues: readonly { path: string; message: string }[] }
  | { kind: "system_prompt_too_long"; length: number; max: number }
  | { kind: "tool_set_too_large"; size: number; max: number }
  | { kind: "hook_rules_too_large"; size: number; max: number }
  | { kind: "tenant_id_invalid"; reason: string };

const ToolDescriptorSchema = z
  .object({ name: z.string().min(1).max(MAX_TOOL_NAME_LEN) })
  .passthrough()
  .refine((v) => JSON.stringify(v).length <= MAX_TOOL_DESCRIPTOR_BYTES, {
    message: "tool descriptor exceeds byte cap",
  });

const HookRuleLiteralSchema = z
  .object({ name: z.string().min(1).max(MAX_HOOK_RULE_NAME_LEN) })
  .passthrough()
  .refine((v) => JSON.stringify(v).length <= MAX_HOOK_RULE_BYTES, {
    message: "hook rule exceeds byte cap",
  });

const AgentCreateBodySchema = z
  .object({
    tenantId: z.string().uuid(),
    systemPrompt: z.string().min(1).max(MAX_SYSTEM_PROMPT_LEN),
    toolSet: z.array(ToolDescriptorSchema).max(MAX_TOOL_SET_SIZE).default([]),
    hookRules: z.array(HookRuleLiteralSchema).max(MAX_HOOK_RULES_PER_AGENT).default([]),
  })
  .strict();

export function parseAgentCreate(raw: unknown): Result<AgentCreateSpec, AgentParseError> {
  // Pre-checks for specific limit violations: run before full Zod validation so we return
  // dedicated error kinds (system_prompt_too_long, etc.) rather than the generic
  // validation_failed. We only check when the input has the expected shape to avoid
  // masking type errors (those fall through to Zod below).
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const body = raw as Record<string, unknown>;

    if (
      typeof body["systemPrompt"] === "string" &&
      body["systemPrompt"].length > MAX_SYSTEM_PROMPT_LEN
    ) {
      return err({
        kind: "system_prompt_too_long",
        length: body["systemPrompt"].length,
        max: MAX_SYSTEM_PROMPT_LEN,
      });
    }

    if (Array.isArray(body["toolSet"]) && body["toolSet"].length > MAX_TOOL_SET_SIZE) {
      return err({
        kind: "tool_set_too_large",
        size: body["toolSet"].length,
        max: MAX_TOOL_SET_SIZE,
      });
    }

    if (Array.isArray(body["hookRules"]) && body["hookRules"].length > MAX_HOOK_RULES_PER_AGENT) {
      return err({
        kind: "hook_rules_too_large",
        size: body["hookRules"].length,
        max: MAX_HOOK_RULES_PER_AGENT,
      });
    }
  }

  const parsed = AgentCreateBodySchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    }));
    return err({ kind: "validation_failed", issues });
  }

  const body = parsed.data;

  const tenantResult = TenantId.parse(body.tenantId);
  if (!tenantResult.ok) {
    return err({ kind: "tenant_id_invalid", reason: tenantResult.error.kind });
  }

  return ok({
    tenantId: tenantResult.value,
    systemPrompt: body.systemPrompt,
    toolSet: body.toolSet,
    hookRules: body.hookRules,
  });
}
