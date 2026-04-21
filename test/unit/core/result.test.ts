import { describe, expect, test } from "bun:test";
import { err, isErr, isOk, ok, type Result, unreachable } from "../../../src/core/result.ts";

describe("Result", () => {
  test("ok(v) produces an Ok with value", () => {
    const r: Result<number, { kind: "bad" }> = ok(42);
    expect(r.ok).toBe(true);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toBe(42);
  });

  test("err(e) produces an Err with error", () => {
    const r: Result<number, { kind: "bad" }> = err({ kind: "bad" });
    expect(r.ok).toBe(false);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("bad");
  });

  test("exhaustive switch with unreachable fails at runtime if a variant is missed", () => {
    type E = { kind: "a" } | { kind: "b" };
    const handle = (e: E): string => {
      switch (e.kind) {
        case "a":
          return "A";
        case "b":
          return "B";
        default:
          throw unreachable(e);
      }
    };
    expect(handle({ kind: "a" })).toBe("A");
    expect(handle({ kind: "b" })).toBe("B");
    expect(() => handle({ kind: "c" } as unknown as E)).toThrow(/unreachable/);
  });
});
