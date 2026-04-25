import { describe, expect, test } from "bun:test";
import {
  MAX_HOOK_RULES_PER_AGENT,
  MAX_SEED_MEMORIES,
  MAX_SYSTEM_PROMPT_LEN,
  MAX_TOOL_SET_SIZE,
} from "../../../src/agent/limits.ts";
import { MAX_ENTRY_TEXT_BYTES } from "../../../src/memory/limits.ts";
import { parseAgentCreate } from "../../../src/agent/parse.ts";

const VALID_V4_UUID = "550e8400-e29b-41d4-a716-446655440000";
// v1 UUID: passes Zod `.uuid()` but fails our branded parser (version nibble is 1, not 4/7).
const V1_UUID = "550e8400-e29b-11d4-a716-446655440000";

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenantId: VALID_V4_UUID,
    systemPrompt: "You are a helpful assistant.",
    toolSet: [],
    hookRules: [],
    ...overrides,
  };
}

describe("parseAgentCreate — happy path", () => {
  test("valid body returns AgentCreateSpec with branded tenantId", () => {
    const r = parseAgentCreate(validBody());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.tenantId as string).toBe(VALID_V4_UUID);
    expect(r.value.systemPrompt).toBe("You are a helpful assistant.");
    expect(r.value.toolSet).toEqual([]);
    expect(r.value.hookRules).toEqual([]);
  });

  test("toolSet and hookRules default to empty arrays when omitted", () => {
    const r = parseAgentCreate({ tenantId: VALID_V4_UUID, systemPrompt: "hi" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.toolSet).toEqual([]);
    expect(r.value.hookRules).toEqual([]);
  });

  test("accepts toolSet entries with extra fields (passthrough schema)", () => {
    const r = parseAgentCreate(
      validBody({ toolSet: [{ name: "search", description: "web search", maxTokens: 1024 }] }),
    );
    expect(r.ok).toBe(true);
  });
});

describe("parseAgentCreate — systemPrompt limit", () => {
  test("systemPrompt exactly at cap is accepted", () => {
    const r = parseAgentCreate(validBody({ systemPrompt: "x".repeat(MAX_SYSTEM_PROMPT_LEN) }));
    expect(r.ok).toBe(true);
  });

  test("systemPrompt one over cap returns system_prompt_too_long", () => {
    const r = parseAgentCreate(validBody({ systemPrompt: "x".repeat(MAX_SYSTEM_PROMPT_LEN + 1) }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("system_prompt_too_long");
    if (r.error.kind === "system_prompt_too_long") {
      expect(r.error.length).toBe(MAX_SYSTEM_PROMPT_LEN + 1);
      expect(r.error.max).toBe(MAX_SYSTEM_PROMPT_LEN);
    }
  });

  test("empty systemPrompt returns validation_failed", () => {
    const r = parseAgentCreate(validBody({ systemPrompt: "" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("validation_failed");
  });
});

describe("parseAgentCreate — toolSet limit", () => {
  test("toolSet exactly at cap is accepted", () => {
    const tools = Array.from({ length: MAX_TOOL_SET_SIZE }, (_, i) => ({
      name: `tool_${String(i)}`,
    }));
    const r = parseAgentCreate(validBody({ toolSet: tools }));
    expect(r.ok).toBe(true);
  });

  test("toolSet one over cap returns tool_set_too_large", () => {
    const tools = Array.from({ length: MAX_TOOL_SET_SIZE + 1 }, (_, i) => ({
      name: `tool_${String(i)}`,
    }));
    const r = parseAgentCreate(validBody({ toolSet: tools }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("tool_set_too_large");
    if (r.error.kind === "tool_set_too_large") {
      expect(r.error.size).toBe(MAX_TOOL_SET_SIZE + 1);
      expect(r.error.max).toBe(MAX_TOOL_SET_SIZE);
    }
  });
});

describe("parseAgentCreate — hookRules limit", () => {
  test("hookRules exactly at cap is accepted", () => {
    const rules = Array.from({ length: MAX_HOOK_RULES_PER_AGENT }, (_, i) => ({
      name: `rule_${String(i)}`,
    }));
    const r = parseAgentCreate(validBody({ hookRules: rules }));
    expect(r.ok).toBe(true);
  });

  test("hookRules one over cap returns hook_rules_too_large", () => {
    const rules = Array.from({ length: MAX_HOOK_RULES_PER_AGENT + 1 }, (_, i) => ({
      name: `rule_${String(i)}`,
    }));
    const r = parseAgentCreate(validBody({ hookRules: rules }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("hook_rules_too_large");
    if (r.error.kind === "hook_rules_too_large") {
      expect(r.error.size).toBe(MAX_HOOK_RULES_PER_AGENT + 1);
      expect(r.error.max).toBe(MAX_HOOK_RULES_PER_AGENT);
    }
  });
});

describe("parseAgentCreate — tenantId validation", () => {
  test("non-UUID tenantId returns validation_failed", () => {
    const r = parseAgentCreate(validBody({ tenantId: "not-a-uuid" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("validation_failed");
  });

  test("v1 UUID passes Zod but returns tenant_id_invalid from branded parser", () => {
    const r = parseAgentCreate(validBody({ tenantId: V1_UUID }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("tenant_id_invalid");
  });
});

describe("parseAgentCreate — seedMemory field", () => {
  test("seedMemory defaults to empty array when omitted", () => {
    const r = parseAgentCreate(validBody());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.seedMemory).toEqual([]);
  });

  test("valid seedMemory entries are accepted and importance is branded", () => {
    const r = parseAgentCreate(
      validBody({
        seedMemory: [
          { text: "agent knows TypeScript", importance: 0.8 },
          { text: "prefers concise answers" },
        ],
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.seedMemory.length).toBe(2);
    expect(r.value.seedMemory[0]?.text).toBe("agent knows TypeScript");
    expect(r.value.seedMemory[0]?.importance as number).toBe(0.8);
    expect(r.value.seedMemory[1]?.importance as number).toBe(0.5); // DEFAULT_IMPORTANCE
  });

  test("seedMemory exactly at cap is accepted", () => {
    const entries = Array.from({ length: MAX_SEED_MEMORIES }, (_, i) => ({
      text: `fact ${String(i)}`,
    }));
    const r = parseAgentCreate(validBody({ seedMemory: entries }));
    expect(r.ok).toBe(true);
  });

  test("seedMemory one over cap returns seed_memory_too_large", () => {
    const entries = Array.from({ length: MAX_SEED_MEMORIES + 1 }, (_, i) => ({
      text: `fact ${String(i)}`,
    }));
    const r = parseAgentCreate(validBody({ seedMemory: entries }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("seed_memory_too_large");
    if (r.error.kind === "seed_memory_too_large") {
      expect(r.error.size).toBe(MAX_SEED_MEMORIES + 1);
      expect(r.error.max).toBe(MAX_SEED_MEMORIES);
    }
  });

  test("empty text returns validation_failed", () => {
    const r = parseAgentCreate(validBody({ seedMemory: [{ text: "" }] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("validation_failed");
  });

  test("text exceeding MAX_ENTRY_TEXT_BYTES returns seed_memory_text_too_long", () => {
    // Use a multi-byte character to exceed byte limit without exceeding char count limit.
    // One '€' is 3 bytes; enough of them over MAX_ENTRY_TEXT_BYTES / 3 + 1 will exceed limit.
    const overLimitBytes = "€".repeat(Math.ceil(MAX_ENTRY_TEXT_BYTES / 3) + 1);
    const r = parseAgentCreate(validBody({ seedMemory: [{ text: overLimitBytes }] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("seed_memory_text_too_long");
    if (r.error.kind === "seed_memory_text_too_long") {
      expect(r.error.bytes).toBeGreaterThan(MAX_ENTRY_TEXT_BYTES);
      expect(r.error.max).toBe(MAX_ENTRY_TEXT_BYTES);
    }
  });
});

describe("parseAgentCreate — structural validation", () => {
  test("unknown top-level key returns validation_failed (strict schema)", () => {
    const r = parseAgentCreate(validBody({ unknownField: "oops" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("validation_failed");
  });

  test("missing systemPrompt returns validation_failed", () => {
    const body = Object.fromEntries(
      Object.entries(validBody()).filter(([k]) => k !== "systemPrompt"),
    );
    const r = parseAgentCreate(body);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("validation_failed");
  });

  test("null input returns validation_failed", () => {
    const r = parseAgentCreate(null);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("validation_failed");
  });
});
