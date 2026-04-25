// Boundary parser for agent creation requests. Zod validates shape; smart constructors
// produce branded types. No raw strings escape this file into the domain core.
// See CLAUDE.md §1 (Parse, don't validate) and §12 (one error type per boundary).

import { z } from "zod";
import { err, ok, type Result } from "../core/result.ts";
import { assert } from "../core/assert.ts";
import { TenantId, Importance } from "../ids.ts";
import type { TenantId as TenantIdBrand, Importance as ImportanceBrand } from "../ids.ts";
import {
  MAX_HOOK_RULE_BYTES,
  MAX_HOOK_RULE_NAME_LEN,
  MAX_HOOK_RULES_PER_AGENT,
  MAX_SEED_MEMORIES,
  MAX_SYSTEM_PROMPT_LEN,
  MAX_TOOL_DESCRIPTOR_BYTES,
  MAX_TOOL_NAME_LEN,
  MAX_TOOL_SET_SIZE,
} from "./limits.ts";
import { DEFAULT_IMPORTANCE, MAX_ENTRY_TEXT_BYTES } from "../memory/limits.ts";

// ToolDescriptor and HookRuleLiteral are intentionally loose for this task.
// The tool registry and hook evaluator own their respective shapes.
export type ToolDescriptor = { readonly name: string; readonly [key: string]: unknown };
export type HookRuleLiteral = { readonly name: string; readonly [key: string]: unknown };

export type SeedMemorySpec = {
  readonly text: string;
  readonly importance: ImportanceBrand;
};

export type AgentCreateSpec = {
  readonly tenantId: TenantIdBrand;
  readonly systemPrompt: string;
  readonly toolSet: readonly ToolDescriptor[];
  readonly hookRules: readonly HookRuleLiteral[];
  readonly seedMemory: readonly SeedMemorySpec[];
};

export type AgentParseError =
  | { kind: "validation_failed"; issues: readonly { path: string; message: string }[] }
  | { kind: "system_prompt_too_long"; length: number; max: number }
  | { kind: "tool_set_too_large"; size: number; max: number }
  | { kind: "hook_rules_too_large"; size: number; max: number }
  | { kind: "tenant_id_invalid"; reason: string }
  | { kind: "seed_memory_too_large"; size: number; max: number }
  | { kind: "seed_memory_text_too_long"; bytes: number; max: number };

const ToolDescriptorSchema = z
  .object({ name: z.string().min(1).max(MAX_TOOL_NAME_LEN) })
  .loose()
  .refine((v) => JSON.stringify(v).length <= MAX_TOOL_DESCRIPTOR_BYTES, {
    message: "tool descriptor exceeds byte cap",
  });

const HookRuleLiteralSchema = z
  .object({ name: z.string().min(1).max(MAX_HOOK_RULE_NAME_LEN) })
  .loose()
  .refine((v) => JSON.stringify(v).length <= MAX_HOOK_RULE_BYTES, {
    message: "hook rule exceeds byte cap",
  });

const SeedMemorySchema = z
  .object({
    text: z.string().min(1).max(MAX_ENTRY_TEXT_BYTES),
    importance: z.number().min(0).max(1).default(DEFAULT_IMPORTANCE),
  })
  .strict();

const AgentCreateBodySchema = z
  .object({
    tenantId: z.uuid(),
    systemPrompt: z.string().min(1).max(MAX_SYSTEM_PROMPT_LEN),
    toolSet: z.array(ToolDescriptorSchema).max(MAX_TOOL_SET_SIZE).default([]),
    hookRules: z.array(HookRuleLiteralSchema).max(MAX_HOOK_RULES_PER_AGENT).default([]),
    seedMemory: z.array(SeedMemorySchema).max(MAX_SEED_MEMORIES).default([]),
  })
  .strict();

export function parseAgentCreate(raw: unknown): Result<AgentCreateSpec, AgentParseError> {
  // Pre-checks for specific limit violations: run before full Zod validation so we return
  // dedicated error kinds rather than the generic validation_failed. Only check when the
  // input has the expected shape to avoid masking type errors.
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

    if (Array.isArray(body["seedMemory"])) {
      if (body["seedMemory"].length > MAX_SEED_MEMORIES) {
        return err({
          kind: "seed_memory_too_large",
          size: body["seedMemory"].length,
          max: MAX_SEED_MEMORIES,
        });
      }
      for (const entry of body["seedMemory"] as unknown[]) {
        if (
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as Record<string, unknown>)["text"] === "string"
        ) {
          const text = (entry as Record<string, unknown>)["text"] as string;
          const bytes = Buffer.byteLength(text, "utf8");
          if (bytes > MAX_ENTRY_TEXT_BYTES) {
            return err({ kind: "seed_memory_text_too_long", bytes, max: MAX_ENTRY_TEXT_BYTES });
          }
        }
      }
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

  const seedMemory: SeedMemorySpec[] = body.seedMemory.map((entry) => {
    const importanceResult = Importance.parse(entry.importance);
    assert(importanceResult.ok, "parseAgentCreate: importance out of [0,1] after zod validation", {
      importance: entry.importance,
    });
    return { text: entry.text, importance: importanceResult.value };
  });

  return ok({
    tenantId: tenantResult.value,
    systemPrompt: body.systemPrompt,
    toolSet: body.toolSet,
    hookRules: body.hookRules,
    seedMemory,
  });
}
