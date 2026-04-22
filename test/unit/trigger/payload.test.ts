import { describe, expect, test } from "bun:test";
import {
  MAX_ENVELOPE_BYTES,
  MAX_MESSAGE_CONTENT_BYTES,
  MAX_TASK_INTENT_LEN,
} from "../../../src/trigger/limits.ts";
import { parseEnvelopePayload, parseTaskRow } from "../../../src/trigger/payload.ts";
import type { TaskRow } from "../../../src/trigger/payload.ts";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

function validMessagePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "message",
    sender: { type: "human", id: "user-1", displayName: "Alice" },
    targetAgentId: VALID_UUID,
    content: "Hello there",
    receivedAt: "2026-04-22T00:00:00.000Z",
    ...overrides,
  };
}

function validEventPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "event",
    source: "github",
    targetAgentId: VALID_UUID,
    data: { action: "push", repo: "relay" },
    receivedAt: "2026-04-22T00:00:00.000Z",
    ...overrides,
  };
}

function validTaskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: VALID_UUID,
    agent_id: VALID_UUID,
    tenant_id: VALID_UUID,
    intent: "Run weekly digest",
    ...overrides,
  };
}

describe("parseEnvelopePayload — happy path", () => {
  test("accepts a canonical message payload", () => {
    const r = parseEnvelopePayload(validMessagePayload());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe("message");
    if (r.value.kind !== "message") return;
    expect(r.value.content).toBe("Hello there");
    expect(r.value.sender.type).toBe("human");
    expect(r.value.sender.displayName).toBe("Alice");
    expect(r.value.receivedAt).toBeInstanceOf(Date);
  });

  test("accepts a canonical event payload", () => {
    const r = parseEnvelopePayload(validEventPayload());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe("event");
    if (r.value.kind !== "event") return;
    expect(r.value.source).toBe("github");
    expect(r.value.data).toEqual({ action: "push", repo: "relay" });
    expect(r.value.receivedAt).toBeInstanceOf(Date);
  });

  test("message: optional displayName omitted", () => {
    const r = parseEnvelopePayload(
      validMessagePayload({ sender: { type: "system", id: "sys-1" } }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.value.kind !== "message") return;
    expect(r.value.sender.displayName).toBeUndefined();
  });
});

describe("parseEnvelopePayload — error cases", () => {
  test("rejects missing kind", () => {
    const r = parseEnvelopePayload({ ...validMessagePayload(), kind: undefined });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("validation_failed");
  });

  test("rejects unknown kind", () => {
    const r = parseEnvelopePayload({ ...validMessagePayload(), kind: "webhook" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("validation_failed");
  });

  test("rejects malformed targetAgentId (not a UUID)", () => {
    const r = parseEnvelopePayload(validMessagePayload({ targetAgentId: "not-a-uuid" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("validation_failed");
  });

  test("rejects non-v4/v7 UUID in targetAgentId", () => {
    // v1 UUID passes Zod .uuid() but fails our branded parser
    const r = parseEnvelopePayload(
      validMessagePayload({ targetAgentId: "550e8400-e29b-11d4-a716-446655440000" }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("agent_id_invalid");
  });

  test("rejects content exceeding MAX_MESSAGE_CONTENT_BYTES", () => {
    const r = parseEnvelopePayload(
      validMessagePayload({ content: "x".repeat(MAX_MESSAGE_CONTENT_BYTES + 1) }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("content_too_long");
  });

  test("rejects payload exceeding MAX_ENVELOPE_BYTES", () => {
    // Build a payload whose JSON serialization exceeds the limit
    const big = { content: "x".repeat(MAX_ENVELOPE_BYTES + 1) };
    const r = parseEnvelopePayload({ ...validMessagePayload(), ...big });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("envelope_too_large");
  });

  test("rejects event with missing source", () => {
    const r = parseEnvelopePayload({ ...validEventPayload(), source: undefined });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("validation_failed");
  });
});

describe("parseTaskRow — happy path", () => {
  test("accepts a canonical task row", () => {
    const r = parseTaskRow(validTaskRow(), new Date("2026-04-22T00:00:00.000Z"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe("task_fire");
    expect(r.value.intent).toBe("Run weekly digest");
    expect(r.value.firedAt).toBeInstanceOf(Date);
  });
});

describe("parseTaskRow — error cases", () => {
  test("rejects a row with invalid agent_id", () => {
    const r = parseTaskRow(validTaskRow({ agent_id: "not-a-uuid" }), new Date());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("agent_id_invalid");
  });

  test("rejects intent exceeding MAX_TASK_INTENT_LEN", () => {
    const r = parseTaskRow(
      validTaskRow({ intent: "x".repeat(MAX_TASK_INTENT_LEN + 1) }),
      new Date(),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("content_too_long");
  });

  test("rejects a row with invalid task id", () => {
    const r = parseTaskRow(validTaskRow({ id: "bad-id" }), new Date());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("task_id_invalid");
  });
});
