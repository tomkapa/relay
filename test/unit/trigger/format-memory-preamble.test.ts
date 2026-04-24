// Pure unit tests for formatMemoryPreamble, humanizeAge, and oneLine.
// No DB, no clock side-effects. CLAUDE.md §11 — production code takes clock as param.

import { describe, expect, test } from "bun:test";
import { AssertionError, assert } from "../../../src/core/assert.ts";
import type { MemoryId } from "../../../src/ids.ts";
import { MemoryKind } from "../../../src/memory/kind.ts";
import { MAX_MEMORY_PREAMBLE_BYTES } from "../../../src/memory/limits.ts";
import type { RankedMemory } from "../../../src/memory/retrieve.ts";
import { formatMemoryPreamble, humanizeAge, oneLine } from "../../../src/trigger/synthesize.ts";

function parseKind(raw: string) {
  const r = MemoryKind.parse(raw);
  assert(r.ok, "fixture: invalid MemoryKind");
  return r.value;
}

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const SYSTEM_PROMPT = "You are a helpful assistant.";
const NOW = new Date("2026-04-22T12:00:00.000Z");

function makeMemory(overrides: Partial<RankedMemory> = {}): RankedMemory {
  return {
    id: VALID_UUID as MemoryId,
    text: "Alice leads the Acme eng team.",
    kind: parseKind("fact"),
    importance: 0.9,
    createdAt: new Date("2026-04-19T12:00:00.000Z"), // 3 days ago from NOW
    similarity: 0.95,
    recencyFactor: 0.97,
    scaledImportance: 0.9,
    score: 0.83,
    ...overrides,
  };
}

describe("humanizeAge", () => {
  test("formatMemoryPreamble_humanizesAge_minutes", () => {
    expect(humanizeAge(45 * 60 * 1000)).toBe("45m ago");
  });

  test("formatMemoryPreamble_humanizesAge_hours", () => {
    expect(humanizeAge(12 * 3600 * 1000)).toBe("12h ago");
  });

  test("formatMemoryPreamble_humanizesAge_days", () => {
    expect(humanizeAge(3 * 86_400_000)).toBe("3d ago");
  });

  test("formatMemoryPreamble_humanizesAge_weeks", () => {
    expect(humanizeAge(2 * 7 * 86_400_000)).toBe("2w ago");
  });

  test("returns 0m ago for zero ms", () => {
    expect(humanizeAge(0)).toBe("0m ago");
  });

  test("returns 0m ago for negative ms (clamped)", () => {
    expect(humanizeAge(-5000)).toBe("0m ago");
  });
});

describe("oneLine", () => {
  test("collapses internal newlines to single space", () => {
    expect(oneLine("hello\nworld")).toBe("hello world");
  });

  test("collapses tabs and multiple spaces", () => {
    expect(oneLine("a\t\t b")).toBe("a b");
  });

  test("trims leading and trailing whitespace", () => {
    expect(oneLine("  hello  ")).toBe("hello");
  });

  test("truncates at 512 chars and appends ...", () => {
    const long = "x".repeat(600);
    const result = oneLine(long);
    expect(result.length).toBe(512);
    expect(result.endsWith("...")).toBe(true);
  });

  test("does not truncate exactly 512 chars", () => {
    const exact = "x".repeat(512);
    expect(oneLine(exact)).toBe(exact);
  });
});

describe("formatMemoryPreamble", () => {
  test("formatMemoryPreamble_includesHeading", () => {
    const result = formatMemoryPreamble(SYSTEM_PROMPT, [makeMemory()], NOW);
    expect(result.content).toContain("# Recalled memories");
  });

  test("formatMemoryPreamble_systemPromptUnchangedExceptAppended", () => {
    const result = formatMemoryPreamble(SYSTEM_PROMPT, [makeMemory()], NOW);
    expect(result.content.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(result.content.length).toBeGreaterThan(SYSTEM_PROMPT.length);
  });

  test("formatMemoryPreamble_emitsOneBulletPerMemory", () => {
    const memories = [
      makeMemory(),
      makeMemory({ text: "Bob is the CTO." }),
      makeMemory({ text: "Acme uses React." }),
    ];
    const result = formatMemoryPreamble(SYSTEM_PROMPT, memories, NOW);
    const bullets = (result.content.match(/^- \[/gm) ?? []).length;
    expect(bullets).toBe(3);
  });

  test("formatMemoryPreamble_includesKindImportanceAge", () => {
    const m = makeMemory({
      kind: parseKind("fact"),
      importance: 0.9,
      createdAt: new Date("2026-04-19T12:00:00.000Z"),
    });
    const result = formatMemoryPreamble(SYSTEM_PROMPT, [m], NOW);
    expect(result.content).toContain("fact");
    expect(result.content).toContain("importance 0.9");
    expect(result.content).toContain("3d ago");
  });

  test("formatMemoryPreamble_collapsesMultilineMemoryText", () => {
    const m = makeMemory({ text: "line one\nline two\nline three" });
    const result = formatMemoryPreamble(SYSTEM_PROMPT, [m], NOW);
    expect(result.content).toContain("line one line two line three");
    // The bullet itself must be a single line — no embedded newline in the text portion
    const bullet = result.content.split("\n").find((l) => l.startsWith("- ["));
    expect(bullet).toBeDefined();
    expect(bullet).toContain("line one line two line three");
  });

  test("formatMemoryPreamble_truncatesIndividualLineAt512", () => {
    const long = "x".repeat(600);
    const m = makeMemory({ text: long });
    const result = formatMemoryPreamble(SYSTEM_PROMPT, [m], NOW);
    const line = result.content.split("\n").find((l) => l.startsWith("- ["));
    expect(line).toBeDefined();
    // The text portion within the bullet is capped at 512 chars + "..."
    const textPart = line?.split("] ")[1] ?? "";
    expect(textPart.length).toBeLessThanOrEqual(512);
    expect(textPart.endsWith("...")).toBe(true);
  });

  test("formatMemoryPreamble_truncatesAtPreambleBudget_returnsTruncatedTrue", () => {
    // Each line is ~100 bytes; 50 memories exceeds 4 KB.
    const memories = Array.from({ length: 50 }, (_, i) =>
      makeMemory({ text: `Memory entry number ${i.toString()} with some padding text here.` }),
    );
    const result = formatMemoryPreamble(SYSTEM_PROMPT, memories, NOW);
    expect(result.truncated).toBe(true);
    expect(
      Buffer.byteLength(result.content.slice(SYSTEM_PROMPT.length), "utf8"),
    ).toBeLessThanOrEqual(
      MAX_MEMORY_PREAMBLE_BYTES + 100, // allow a bit of slack for preamble header
    );
  });

  test("formatMemoryPreamble_keepsHighestScoredPrefix_onTruncation", () => {
    // Use long texts so the budget is exhausted before all 50 entries fit.
    const pad = "a".repeat(80);
    const memories = Array.from(
      { length: 50 },
      (_, i) => makeMemory({ text: `Memory ${i.toString()} ${pad}`, score: 50 - i }), // desc by score: 0 is highest
    );
    const result = formatMemoryPreamble(SYSTEM_PROMPT, memories, NOW);
    expect(result.truncated).toBe(true);
    // First entry (score=50, i=0) must appear; last entry (score=1, i=49) must be absent.
    expect(result.content).toContain("Memory 0");
    expect(result.content).not.toContain("Memory 49");
  });

  test("formatMemoryPreamble_assertsNonEmptyInput", () => {
    expect(() => formatMemoryPreamble(SYSTEM_PROMPT, [], NOW)).toThrow(AssertionError);
  });

  test("formatMemoryPreamble_isDeterministic_acrossSameInput", () => {
    const m = makeMemory();
    const r1 = formatMemoryPreamble(SYSTEM_PROMPT, [m], NOW);
    const r2 = formatMemoryPreamble(SYSTEM_PROMPT, [m], NOW);
    expect(r1.content).toBe(r2.content);
    expect(r1.truncated).toBe(r2.truncated);
  });

  test("formatMemoryPreamble_returnsTruncatedFalse_forSmallInput", () => {
    const result = formatMemoryPreamble(SYSTEM_PROMPT, [makeMemory()], NOW);
    expect(result.truncated).toBe(false);
  });

  test("importance formatted to 1 decimal place", () => {
    const m = makeMemory({ importance: 0.777 });
    const result = formatMemoryPreamble(SYSTEM_PROMPT, [m], NOW);
    expect(result.content).toContain("importance 0.8");
  });
});
