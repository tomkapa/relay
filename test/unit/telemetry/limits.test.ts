// Unit tests for telemetry byte caps and truncateUtf8.
// CLAUDE.md §5 — every string crossing a trust boundary has a length cap.
// truncateUtf8 must never split a multi-byte UTF-8 codepoint.

import { describe, expect, test } from "bun:test";
import {
  MAX_GENAI_CONTENT_BYTES_PER_PART,
  MAX_GENAI_MESSAGES_PER_EVENT,
  MAX_GENAI_THINKING_BYTES_PER_BLOCK,
  MAX_GENAI_TOOL_DEFINITIONS,
  truncateUtf8,
} from "../../../src/telemetry/limits.ts";

describe("constants", () => {
  test("content cap is 16 KiB", () => {
    expect(MAX_GENAI_CONTENT_BYTES_PER_PART).toBe(16 * 1024);
  });
  test("thinking cap is 16 KiB", () => {
    expect(MAX_GENAI_THINKING_BYTES_PER_BLOCK).toBe(16 * 1024);
  });
  test("messages per event cap is 50", () => {
    expect(MAX_GENAI_MESSAGES_PER_EVENT).toBe(50);
  });
  test("tool definitions cap is 100", () => {
    expect(MAX_GENAI_TOOL_DEFINITIONS).toBe(100);
  });
});

describe("truncateUtf8", () => {
  test("returns untruncated when input fits", () => {
    const r = truncateUtf8("hello", 100);
    expect(r.text).toBe("hello");
    expect(r.truncated).toBe(false);
  });

  test("returns empty string passthrough untruncated", () => {
    const r = truncateUtf8("", 100);
    expect(r.text).toBe("");
    expect(r.truncated).toBe(false);
  });

  test("cuts at the byte cap for ASCII", () => {
    const r = truncateUtf8("abcdefghij", 4);
    expect(r.text).toBe("abcd");
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.text, "utf8")).toBe(4);
  });

  test("cut at exact byte boundary is not marked truncated", () => {
    const r = truncateUtf8("abcd", 4);
    expect(r.text).toBe("abcd");
    expect(r.truncated).toBe(false);
  });

  test("never splits a multi-byte codepoint — pulls back to a safe boundary", () => {
    // "é" is 0xC3 0xA9 in UTF-8 (2 bytes). Cap=1 must not yield a half-char.
    const r = truncateUtf8("é", 1);
    expect(r.truncated).toBe(true);
    expect(r.text).toBe(""); // no complete codepoint fits
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThanOrEqual(1);
  });

  test("respects 4-byte codepoints (emoji)", () => {
    // "🙂" is 4 bytes in UTF-8 (F0 9F 99 82). cap=3 must drop it entirely.
    const r = truncateUtf8("ab🙂cd", 5); // "ab" = 2 bytes, "🙂" would push to 6
    expect(r.truncated).toBe(true);
    expect(r.text).toBe("ab");
  });

  test("preserves full multi-byte codepoint when it exactly fits", () => {
    const r = truncateUtf8("ab🙂", 6); // 2 + 4 = 6 bytes exactly
    expect(r.text).toBe("ab🙂");
    expect(r.truncated).toBe(false);
  });

  test("asserts on non-positive maxBytes", () => {
    expect(() => truncateUtf8("x", 0)).toThrow();
    expect(() => truncateUtf8("x", -1)).toThrow();
  });
});
