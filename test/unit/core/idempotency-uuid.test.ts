// Tests for idempotencyKeyToUuid — deterministic UUID derivation. RELAY-144.

import { describe, expect, test } from "bun:test";
import { idempotencyKey, idempotencyKeyToUuid } from "../../../src/core/idempotency.ts";
import type { SessionId, TurnId } from "../../../src/ids.ts";
import { EnvelopeId } from "../../../src/ids.ts";

const SESS_ID = "11111111-1111-4111-a111-111111111111" as SessionId;
const TURN_ID = "22222222-2222-4222-a222-222222222222" as TurnId;

describe("idempotencyKeyToUuid", () => {
  test("produces a valid UUID v4 format", () => {
    const key = idempotencyKey({
      writer: "ask",
      sessionId: SESS_ID,
      turnId: TURN_ID,
      toolCallId: "toolu_01",
    });
    const uuid = idempotencyKeyToUuid(key);
    const uuidResult = EnvelopeId.parse(uuid);
    expect(uuidResult.ok).toBe(true);
  });

  test("is deterministic — same key always yields the same UUID", () => {
    const key = idempotencyKey({
      writer: "ask",
      sessionId: SESS_ID,
      turnId: TURN_ID,
      toolCallId: "toolu_01",
    });
    const uuid1 = idempotencyKeyToUuid(key);
    const uuid2 = idempotencyKeyToUuid(key);
    expect(uuid1).toBe(uuid2);
  });

  test("different inputs yield different UUIDs", () => {
    const key1 = idempotencyKey({
      writer: "ask",
      sessionId: SESS_ID,
      turnId: TURN_ID,
      toolCallId: "toolu_01",
    });
    const key2 = idempotencyKey({
      writer: "ask",
      sessionId: SESS_ID,
      turnId: TURN_ID,
      toolCallId: "toolu_02",
    });
    const uuid1 = idempotencyKeyToUuid(key1);
    const uuid2 = idempotencyKeyToUuid(key2);
    expect(uuid1).not.toBe(uuid2);
  });

  test("produced UUID has version nibble 4", () => {
    const key = idempotencyKey({
      writer: "ask",
      sessionId: SESS_ID,
      turnId: TURN_ID,
      toolCallId: "toolu_x",
    });
    const uuid = idempotencyKeyToUuid(key);
    // UUID format: xxxxxxxx-xxxx-4xxx-...
    expect(uuid[14]).toBe("4");
  });

  test("produced UUID has RFC 4122 variant nibble 8, 9, a, or b", () => {
    const key = idempotencyKey({
      writer: "ask",
      sessionId: SESS_ID,
      turnId: TURN_ID,
      toolCallId: "toolu_y",
    });
    const uuid = idempotencyKeyToUuid(key);
    // UUID format: ...-{variant}{3}-...  (position 19 is the first nibble of group 4)
    const variantNibble = uuid[19] ?? "";
    expect(["8", "9", "a", "b"]).toContain(variantNibble);
  });
});
