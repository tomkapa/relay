import { describe, expect, test } from "bun:test";
import { AssertionError } from "../../../src/core/assert.ts";
import { firstRow } from "../../../src/db/utils.ts";

describe("firstRow", () => {
  test("returns the first element of a non-empty array", () => {
    expect(firstRow([{ id: "a" }, { id: "b" }], "ctx")).toEqual({ id: "a" });
  });

  test("works for a single-element array", () => {
    expect(firstRow(["x"], "ctx")).toBe("x");
  });

  test("throws AssertionError for an empty array", () => {
    expect(() => firstRow([], "ctx")).toThrow(AssertionError);
  });
});
