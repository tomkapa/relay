import { describe, expect, test } from "bun:test";
import { AssertionError } from "../../../src/core/assert.ts";
import { TenantId } from "../../../src/ids.ts";
import {
  MAX_DEQUEUE_BATCH,
  MAX_PAYLOAD_REF_LEN,
  MAX_WORK_QUEUE_ROWS_PER_TENANT,
  MAX_WORKER_ID_LEN,
} from "../../../src/work_queue/limits.ts";
import {
  rowToItem,
  validateDequeue,
  validateEnqueue,
  WorkerId,
  type DequeueParams,
  type EnqueueParams,
  type WorkQueueError,
  type WorkRow,
} from "../../../src/work_queue/queue.ts";

function tenant(): TenantId {
  const r = TenantId.parse("00000000-0000-4000-8000-000000000001");
  if (!r.ok) throw new Error("tenant fixture");
  return r.value;
}

function worker(raw: string): WorkerId {
  const r = WorkerId.parse(raw);
  if (!r.ok) throw new Error(`worker fixture: ${r.error.kind}`);
  return r.value;
}

describe("WorkerId.parse", () => {
  test("accepts a reasonable non-empty id", () => {
    const r = WorkerId.parse("worker-abc-1234");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value as string).toBe("worker-abc-1234");
  });

  test("rejects empty string", () => {
    const r = WorkerId.parse("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("worker_id_empty");
  });

  test("rejects overly long id", () => {
    const r = WorkerId.parse("w".repeat(MAX_WORKER_ID_LEN + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("worker_id_too_long");
      if (r.error.kind === "worker_id_too_long") {
        expect(r.error.length).toBe(MAX_WORKER_ID_LEN + 1);
        expect(r.error.max).toBe(MAX_WORKER_ID_LEN);
      }
    }
  });

  test("accepts an id exactly at the cap", () => {
    const r = WorkerId.parse("w".repeat(MAX_WORKER_ID_LEN));
    expect(r.ok).toBe(true);
  });
});

describe("validateEnqueue", () => {
  const base: EnqueueParams = {
    tenantId: tenant(),
    kind: "session_start",
    payloadRef: "session:01HXZ00000000000000000",
    scheduledAt: new Date("2026-04-21T12:00:00Z"),
  };

  test("accepts a well-formed payload", () => {
    const r = validateEnqueue(base);
    expect(r.ok).toBe(true);
  });

  test("rejects empty payload_ref", () => {
    const r = validateEnqueue({ ...base, payloadRef: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("payload_ref_empty");
  });

  test("rejects overly long payload_ref", () => {
    const r = validateEnqueue({
      ...base,
      payloadRef: "x".repeat(MAX_PAYLOAD_REF_LEN + 1),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("payload_ref_too_long");
      if (r.error.kind === "payload_ref_too_long") {
        expect(r.error.length).toBe(MAX_PAYLOAD_REF_LEN + 1);
        expect(r.error.max).toBe(MAX_PAYLOAD_REF_LEN);
      }
    }
  });

  test("accepts payload_ref exactly at the cap", () => {
    const r = validateEnqueue({ ...base, payloadRef: "x".repeat(MAX_PAYLOAD_REF_LEN) });
    expect(r.ok).toBe(true);
  });
});

describe("validateDequeue", () => {
  const base: DequeueParams = {
    workerId: worker("worker-a"),
    limit: 1,
    now: new Date("2026-04-21T12:00:00Z"),
  };

  test("accepts a limit of 1", () => {
    const r = validateDequeue(base);
    expect(r.ok).toBe(true);
  });

  test("accepts a limit at the batch cap", () => {
    const r = validateDequeue({ ...base, limit: MAX_DEQUEUE_BATCH });
    expect(r.ok).toBe(true);
  });

  test("rejects a limit of 0", () => {
    const r = validateDequeue({ ...base, limit: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("batch_out_of_range");
      if (r.error.kind === "batch_out_of_range") {
        expect(r.error.requested).toBe(0);
        expect(r.error.max).toBe(MAX_DEQUEUE_BATCH);
      }
    }
  });

  test("rejects a negative limit", () => {
    const r = validateDequeue({ ...base, limit: -3 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("batch_out_of_range");
  });

  test("rejects a limit beyond the batch cap", () => {
    const r = validateDequeue({ ...base, limit: MAX_DEQUEUE_BATCH + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("batch_out_of_range");
  });

  test("rejects a non-positive lease_ms", () => {
    const r = validateDequeue({ ...base, leaseMs: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("lease_ms_non_positive");
  });

  test("accepts an omitted lease_ms (default applies downstream)", () => {
    const r = validateDequeue(base);
    expect(r.ok).toBe(true);
  });

  test("accepts a positive lease_ms", () => {
    const r = validateDequeue({ ...base, leaseMs: 1_000 });
    expect(r.ok).toBe(true);
  });
});

describe("WorkQueueError — queue_over_capacity shape", () => {
  test("queue_over_capacity carries tenantId and cap", () => {
    const t = tenant();
    const e: WorkQueueError = {
      kind: "queue_over_capacity",
      tenantId: t,
      cap: MAX_WORK_QUEUE_ROWS_PER_TENANT,
    };
    expect(e.kind).toBe("queue_over_capacity");
    expect(e.tenantId).toBe(t);
    expect(e.cap).toBe(MAX_WORK_QUEUE_ROWS_PER_TENANT);
  });
});

describe("rowToItem", () => {
  const tenantRaw = "00000000-0000-4000-8000-000000000001";
  const idRaw = "00000000-0000-4000-8000-00000000abcd";
  const base: WorkRow = {
    id: idRaw,
    tenant_id: tenantRaw,
    kind: "session_start",
    payload_ref: "session:1",
    scheduled_at: new Date("2026-04-21T12:00:00Z"),
    attempts: 0,
  };

  test("maps snake_case DB fields to branded camelCase item", () => {
    const item = rowToItem(base);
    expect(item.id as string).toBe(idRaw);
    expect(item.tenantId as string).toBe(tenantRaw);
    expect(item.kind).toBe("session_start");
    expect(item.payloadRef).toBe("session:1");
    expect(item.attempts).toBe(0);
  });

  test("accepts every WorkKind in the table", () => {
    for (const kind of ["session_start", "task_fire", "inbound_message"] as const) {
      const item = rowToItem({ ...base, kind });
      expect(item.kind).toBe(kind);
    }
  });

  test("asserts on an unrecognized kind (schema drift is a programmer error)", () => {
    expect(() => rowToItem({ ...base, kind: "telegram" })).toThrow(AssertionError);
  });
});
