// Unit tests for parseEnvelopePayload with childSessionId — RELAY-146.
// TDD: written before the implementation.

import { describe, expect, test } from "bun:test";
import { parseEnvelopePayload } from "../../../src/trigger/payload.ts";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const VALID_UUID_PARENT = "660e8400-e29b-41d4-a716-446655440001";
const VALID_UUID_CHAIN = "770e8400-e29b-41d4-a716-446655440002";
const VALID_UUID_CHILD = "880e8400-e29b-41d4-a716-446655440003";

function validMessagePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "message",
    sender: { type: "human", id: "user-1" },
    targetAgentId: VALID_UUID,
    content: "Hello",
    receivedAt: "2026-04-22T00:00:00.000Z",
    ...overrides,
  };
}

describe("parseEnvelopePayload — childSessionId (RELAY-146)", () => {
  test("accepts message with all parent-link fields including childSessionId", () => {
    const r = parseEnvelopePayload(
      validMessagePayload({
        parentSessionId: VALID_UUID_PARENT,
        parentChainId: VALID_UUID_CHAIN,
        parentDepth: 1,
        parentToolUseId: "toolu_ask_01",
        childSessionId: VALID_UUID_CHILD,
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe("message");
    if (r.value.kind !== "message") return;
    expect(r.value.childSessionId as string).toBe(VALID_UUID_CHILD);
  });

  test("rejects message with parentSessionId but no childSessionId", () => {
    const r = parseEnvelopePayload(
      validMessagePayload({
        parentSessionId: VALID_UUID_PARENT,
        parentChainId: VALID_UUID_CHAIN,
        parentDepth: 1,
        parentToolUseId: "toolu_ask_01",
        // childSessionId intentionally omitted
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("parent_link_invalid");
  });

  test("accepts message with neither parentSessionId nor childSessionId (fresh trigger)", () => {
    const r = parseEnvelopePayload(validMessagePayload());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.value.kind !== "message") return;
    expect(r.value.parentSessionId).toBeUndefined();
    expect(r.value.childSessionId).toBeUndefined();
  });

  test("rejects invalid childSessionId UUID format (not v4/v7)", () => {
    const r = parseEnvelopePayload(
      validMessagePayload({
        parentSessionId: VALID_UUID_PARENT,
        parentChainId: VALID_UUID_CHAIN,
        parentDepth: 0,
        parentToolUseId: "toolu_ask_01",
        childSessionId: "550e8400-e29b-11d4-a716-446655440000", // v1 UUID passes Zod but fails branded parser
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("session_id_invalid");
  });

  test("rejects malformed childSessionId (not a UUID)", () => {
    const r = parseEnvelopePayload(
      validMessagePayload({
        parentSessionId: VALID_UUID_PARENT,
        parentChainId: VALID_UUID_CHAIN,
        parentDepth: 0,
        parentToolUseId: "toolu_ask_01",
        childSessionId: "not-a-uuid",
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("validation_failed");
  });
});
