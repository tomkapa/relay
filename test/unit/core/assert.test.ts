import { describe, expect, test } from "bun:test";
import { assert, assertNever, AssertionError } from "../../../src/core/assert.ts";

describe("assert", () => {
  test("passes through on truthy condition", () => {
    expect(() => {
      assert(1 + 1 === 2, "math works");
    }).not.toThrow();
  });

  test("throws AssertionError on falsy condition", () => {
    expect(() => {
      assert(false, "boom");
    }).toThrow(AssertionError);
  });

  test("AssertionError carries details", () => {
    let caught: unknown;
    try {
      assert(false, "with details", { foo: 1 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AssertionError);
    expect((caught as AssertionError).details).toEqual({ foo: 1 });
  });

  test("assert narrows types", () => {
    const x: string | null = Math.random() < 2 ? "hello" : null;
    assert(x !== null, "x is non-null");
    // Type narrowed: x is string here.
    expect(x.length).toBe(5);
  });
});

describe("assertNever", () => {
  test("throws for any value passed at runtime", () => {
    expect(() => {
      assertNever("unexpected" as never, "should not happen");
    }).toThrow(AssertionError);
  });
});
