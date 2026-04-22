// Unit tests for writeInboundMessage's pure boundary-validation branches. These fire
// before any SQL is touched, so they are covered without a live DB. Integration coverage
// for the DB path lives in test/integration/trigger/handlers.test.ts.

import { describe, expect, test } from "bun:test";
import type { Sql } from "postgres";
import type { SessionId, TenantId, WorkItemId } from "../../../../src/ids.ts";
import { writeInboundMessage } from "../../../../src/trigger/inbound/inbound-ops.ts";
import {
  MAX_INBOUND_CONTENT_BYTES,
  MAX_INBOUND_SENDER_EXTERNAL_ID_LEN,
} from "../../../../src/trigger/inbound/limits.ts";

// The validation branches return err before touching sql, so the callable stays unused.
// Any access or call throws loudly if that contract ever regresses.
const unreachableSql = new Proxy(
  function unreachable(): never {
    throw new Error("sql must not be invoked on validation-error path");
  },
  {
    get(): never {
      throw new Error("sql must not be read on validation-error path");
    },
  },
) as unknown as Sql;

const VALID_UUID_A = "550e8400-e29b-41d4-a716-446655440000";
const VALID_UUID_B = "550e8400-e29b-41d4-a716-446655440001";
const VALID_UUID_C = "550e8400-e29b-41d4-a716-446655440002";

const baseSpec = {
  tenantId: VALID_UUID_A as TenantId,
  targetSessionId: VALID_UUID_B as SessionId,
  sender: { type: "human" as const, id: "user:123" },
  content: "hello",
  receivedAt: new Date(0),
  sourceWorkItemId: VALID_UUID_C as WorkItemId,
};

describe("writeInboundMessage — boundary validation", () => {
  test("returns content_too_long when content exceeds MAX_INBOUND_CONTENT_BYTES", async () => {
    const over = "x".repeat(MAX_INBOUND_CONTENT_BYTES + 1);
    const result = await writeInboundMessage(unreachableSql, { ...baseSpec, content: over });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("content_too_long");
    if (result.error.kind !== "content_too_long") return;
    expect(result.error.length).toBe(over.length);
    expect(result.error.max).toBe(MAX_INBOUND_CONTENT_BYTES);
  });

  test("returns sender_id_too_long when sender.id exceeds MAX_INBOUND_SENDER_EXTERNAL_ID_LEN", async () => {
    const over = "a".repeat(MAX_INBOUND_SENDER_EXTERNAL_ID_LEN + 1);
    const result = await writeInboundMessage(unreachableSql, {
      ...baseSpec,
      sender: { type: "human", id: over },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("sender_id_too_long");
    if (result.error.kind !== "sender_id_too_long") return;
    expect(result.error.length).toBe(over.length);
    expect(result.error.max).toBe(MAX_INBOUND_SENDER_EXTERNAL_ID_LEN);
  });
});
