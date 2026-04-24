import { expect, test } from "bun:test";
import { MemoryKind } from "../../../src/memory/kind.ts";

test("memoryKind_parse: 'event' returns ok", () => {
  const result = MemoryKind.parse("event");
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value as string).toBe("event");
});

test("memoryKind_parse: 'fact' returns ok", () => {
  const result = MemoryKind.parse("fact");
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value as string).toBe("fact");
});

test("memoryKind_parse: unknown string returns unknown_kind error", () => {
  const result = MemoryKind.parse("bogus");
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.kind).toBe("unknown_kind");
  expect(result.error.raw).toBe("bogus");
});

test("memoryKind_parse: empty string returns unknown_kind error", () => {
  const result = MemoryKind.parse("");
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.kind).toBe("unknown_kind");
});

test("memoryKind_parse: wrong casing 'EVENT' returns unknown_kind error", () => {
  const result = MemoryKind.parse("EVENT");
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.kind).toBe("unknown_kind");
});

test("memoryKind_parse: 'FACT' returns unknown_kind error", () => {
  const result = MemoryKind.parse("FACT");
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.kind).toBe("unknown_kind");
});
