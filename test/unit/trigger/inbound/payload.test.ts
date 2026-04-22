import { describe, expect, test } from "bun:test";
import {
  MAX_INBOUND_CONTENT_BYTES,
  MAX_INBOUND_SENDER_EXTERNAL_ID_LEN,
} from "../../../../src/trigger/inbound/limits.ts";
import { parseInboundMessageRow } from "../../../../src/trigger/inbound/payload.ts";
import type { InboundMessageRow } from "../../../../src/trigger/inbound/payload.ts";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

function validRow(overrides: Partial<InboundMessageRow> = {}): InboundMessageRow {
  return {
    id: VALID_UUID,
    tenant_id: VALID_UUID,
    target_session_id: VALID_UUID,
    sender_type: "human",
    sender_id: "user-1",
    sender_display_name: null,
    kind: "message",
    content: "Hello there",
    received_at: new Date("2026-04-22T00:00:00.000Z"),
    ...overrides,
  };
}

describe("parseInboundMessageRow — happy path", () => {
  test("accepts canonical row with sender_type human", () => {
    const r = parseInboundMessageRow(validRow({ sender_type: "human" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe("message");
    expect(r.value.sender.type).toBe("human");
    expect(r.value.content).toBe("Hello there");
    expect(r.value.receivedAt).toBeInstanceOf(Date);
    expect(r.value.sender.displayName).toBeUndefined();
  });

  test("accepts sender_type agent", () => {
    const r = parseInboundMessageRow(validRow({ sender_type: "agent" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sender.type).toBe("agent");
  });

  test("accepts sender_type system", () => {
    const r = parseInboundMessageRow(validRow({ sender_type: "system" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sender.type).toBe("system");
  });

  test("sender_display_name non-null is present on branded payload", () => {
    const r = parseInboundMessageRow(validRow({ sender_display_name: "Alice" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sender.displayName).toBe("Alice");
  });

  test("sender_display_name null is omitted from branded payload", () => {
    const r = parseInboundMessageRow(validRow({ sender_display_name: null }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sender.displayName).toBeUndefined();
  });

  test("produces branded SessionId from target_session_id", () => {
    const r = parseInboundMessageRow(validRow());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.targetSessionId as string).toBe(VALID_UUID);
  });
});

describe("parseInboundMessageRow — error cases", () => {
  test("rejects unknown kind with unknown_kind error", () => {
    const r = parseInboundMessageRow(validRow({ kind: "timeout" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("unknown_kind");
    if (r.error.kind !== "unknown_kind") return;
    expect(r.error.value).toBe("timeout");
  });

  test("rejects missing sender_id (empty string) with validation_failed", () => {
    const r = parseInboundMessageRow(validRow({ sender_id: "" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("validation_failed");
  });

  test("rejects invalid sender_type with validation_failed", () => {
    const r = parseInboundMessageRow(validRow({ sender_type: "robot" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("validation_failed");
  });

  test("rejects malformed target_session_id with session_id_invalid", () => {
    const r = parseInboundMessageRow(validRow({ target_session_id: "not-a-uuid" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("session_id_invalid");
  });

  test("rejects non-v4/v7 UUID in target_session_id with session_id_invalid", () => {
    // v1 UUID passes Zod .uuid() but fails our branded parser
    const r = parseInboundMessageRow(
      validRow({ target_session_id: "550e8400-e29b-11d4-a716-446655440000" }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("session_id_invalid");
  });

  test("rejects sender_id exceeding MAX_INBOUND_SENDER_EXTERNAL_ID_LEN with sender_id_too_long", () => {
    const r = parseInboundMessageRow(
      validRow({ sender_id: "x".repeat(MAX_INBOUND_SENDER_EXTERNAL_ID_LEN + 1) }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("sender_id_too_long");
  });

  test("rejects content exceeding MAX_INBOUND_CONTENT_BYTES with content_too_long", () => {
    const r = parseInboundMessageRow(
      validRow({ content: "x".repeat(MAX_INBOUND_CONTENT_BYTES + 1) }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("content_too_long");
  });

  test("rejects empty content with validation_failed", () => {
    const r = parseInboundMessageRow(validRow({ content: "" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("validation_failed");
  });
});
