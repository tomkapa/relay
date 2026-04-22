import { describe, expect, test } from "bun:test";
import {
  AgentId,
  ChainId,
  Depth,
  DEPTH_CAP,
  HookId,
  Importance,
  MemoryId,
  SessionId,
  TaskId,
  TenantId,
  TurnId,
  UserId,
  mintId,
} from "../../../src/ids.ts";

const VALID_V4 = "550e8400-e29b-41d4-a716-446655440000";
const VALID_V7 = "018f3f2a-4a2b-7b7a-8cba-2b55a6fe8d11";

describe("AgentId.parse / SessionId.parse", () => {
  test("accepts UUIDv4", () => {
    const r = AgentId.parse(VALID_V4);
    expect(r.ok).toBe(true);
  });

  test("accepts UUIDv7", () => {
    const r = SessionId.parse(VALID_V7);
    expect(r.ok).toBe(true);
  });

  test("rejects empty", () => {
    const r = AgentId.parse("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("empty");
  });

  test("rejects overlong", () => {
    const r = AgentId.parse("x".repeat(37));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("too_long");
  });

  test("rejects malformed", () => {
    const r = AgentId.parse("not-a-uuid-at-all-ok?");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("malformed");
  });

  test("normalizes case", () => {
    const upper = "550E8400-E29B-41D4-A716-446655440000";
    const r = AgentId.parse(upper);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value as string).toBe(VALID_V4);
  });
});

describe("every id namespace parses a valid UUID", () => {
  // Exercise each parser so regressions in one don't hide. All share `parseUuid` internally,
  // but the public surface is per-id and callers route through these entry points.
  const parsers: readonly (readonly [string, (raw: string) => { ok: boolean }])[] = [
    ["AgentId", AgentId.parse],
    ["SessionId", SessionId.parse],
    ["TurnId", TurnId.parse],
    ["TaskId", TaskId.parse],
    ["MemoryId", MemoryId.parse],
    ["HookId", HookId.parse],
    ["TenantId", TenantId.parse],
    ["UserId", UserId.parse],
    ["ChainId", ChainId.parse],
  ];

  for (const [name, parse] of parsers) {
    test(name, () => {
      expect(parse(VALID_V4).ok).toBe(true);
      expect(parse("").ok).toBe(false);
    });
  }
});

describe("Depth.parse", () => {
  test("accepts 0", () => {
    const r = Depth.parse(0);
    expect(r.ok).toBe(true);
  });

  test("accepts cap", () => {
    const r = Depth.parse(DEPTH_CAP);
    expect(r.ok).toBe(true);
  });

  test("rejects negative", () => {
    const r = Depth.parse(-1);
    expect(r.ok).toBe(false);
  });

  test("rejects above cap", () => {
    const r = Depth.parse(DEPTH_CAP + 1);
    expect(r.ok).toBe(false);
  });

  test("rejects non-integer", () => {
    const r = Depth.parse(1.5);
    expect(r.ok).toBe(false);
  });
});

describe("Importance.parse", () => {
  test("accepts 0 and 1 (inclusive endpoints)", () => {
    expect(Importance.parse(0).ok).toBe(true);
    expect(Importance.parse(1).ok).toBe(true);
  });

  test("accepts fractional in range", () => {
    expect(Importance.parse(0.5).ok).toBe(true);
  });

  test("rejects out of range", () => {
    expect(Importance.parse(-0.01).ok).toBe(false);
    expect(Importance.parse(1.01).ok).toBe(false);
  });

  test("rejects NaN and Infinity", () => {
    expect(Importance.parse(Number.NaN).ok).toBe(false);
    expect(Importance.parse(Number.POSITIVE_INFINITY).ok).toBe(false);
  });
});

describe("mintId", () => {
  test("returns a valid branded id using the provided parser", () => {
    const id = mintId(AgentId.parse, "test");
    const re = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(re.test(id as string)).toBe(true);
  });

  test("returns different values on successive calls", () => {
    const a = mintId(SessionId.parse, "test") as string;
    const b = mintId(SessionId.parse, "test") as string;
    expect(a).not.toBe(b);
  });
});
