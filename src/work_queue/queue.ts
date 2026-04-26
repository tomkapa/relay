// Postgres-backed work queue — pure parts. Types, validators, and row mapping live
// here so this file stays unit-testable without Postgres. The DB-touching shell is in
// `queue-ops.ts`; see SPEC §Architecture for queue semantics.

import { assert } from "../core/assert.ts";
import type { Brand } from "../core/brand.ts";
import { err, ok, type Result } from "../core/result.ts";
import type { TenantId, WorkItemId } from "../ids.ts";
import {
  MAX_DEQUEUE_BATCH,
  MAX_PAYLOAD_REF_LEN,
  MAX_TRACEPARENT_LEN,
  MAX_WORKER_ID_LEN,
} from "./limits.ts";

// WorkerId is queue-scoped: workers pick arbitrary identifiers (hostname+pid, pod name)
// that are not UUIDs, so they don't live in `ids.ts` with the entity ids.
export type WorkerId = Brand<string, "WorkerId">;

export const WORK_KINDS = [
  "session_start",
  "task_fire",
  "inbound_message",
  "cascade_close",
] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

export type WorkQueueError =
  | { kind: "payload_ref_empty" }
  | { kind: "payload_ref_too_long"; length: number; max: number }
  | { kind: "worker_id_empty" }
  | { kind: "worker_id_too_long"; length: number; max: number }
  | { kind: "batch_out_of_range"; requested: number; min: number; max: number }
  | { kind: "lease_ms_non_positive"; leaseMs: number }
  | { kind: "lease_not_held"; id: WorkItemId }
  | { kind: "queue_over_capacity"; tenantId: TenantId; cap: number }
  | { kind: "traceparent_too_long"; length: number; max: number };

export type WorkItem = {
  readonly id: WorkItemId;
  readonly tenantId: TenantId;
  readonly kind: WorkKind;
  readonly payloadRef: string;
  readonly scheduledAt: Date;
  readonly attempts: number;
  // W3C traceparent captured at enqueue time. Null when no active trace context existed
  // (e.g. scheduler-originated enqueue with no parent) or when boundary parsing rejected it.
  readonly traceparent: string | null;
};

export type EnqueueParams = {
  readonly tenantId: TenantId;
  readonly kind: WorkKind;
  readonly payloadRef: string;
  readonly scheduledAt: Date;
  // Optional explicit traceparent. Omit to let queue-ops capture the caller's active
  // context automatically — tests pass this explicitly for deterministic assertions.
  readonly traceparent?: string | null;
};

export type DequeueParams = {
  readonly workerId: WorkerId;
  readonly limit: number;
  readonly now: Date;
  readonly leaseMs?: number;
};

// Row shape returned by postgres.js. Exported for the pure/DB-shell split across
// files — consumers of the module use `WorkItem` via enqueue/dequeue, not this.
export type WorkRow = {
  readonly id: string;
  readonly tenant_id: string;
  readonly kind: string;
  readonly payload_ref: string;
  readonly scheduled_at: Date;
  readonly attempts: number;
  readonly traceparent: string | null;
};

export const WorkerId = {
  parse(raw: string): Result<WorkerId, WorkQueueError> {
    if (raw.length === 0) return err({ kind: "worker_id_empty" });
    if (raw.length > MAX_WORKER_ID_LEN) {
      return err({ kind: "worker_id_too_long", length: raw.length, max: MAX_WORKER_ID_LEN });
    }
    return ok(raw as WorkerId);
  },
};

export function validateEnqueue(params: EnqueueParams): Result<void, WorkQueueError> {
  if (params.payloadRef.length === 0) return err({ kind: "payload_ref_empty" });
  if (params.payloadRef.length > MAX_PAYLOAD_REF_LEN) {
    return err({
      kind: "payload_ref_too_long",
      length: params.payloadRef.length,
      max: MAX_PAYLOAD_REF_LEN,
    });
  }
  if (params.traceparent !== undefined && params.traceparent !== null) {
    if (params.traceparent.length > MAX_TRACEPARENT_LEN) {
      return err({
        kind: "traceparent_too_long",
        length: params.traceparent.length,
        max: MAX_TRACEPARENT_LEN,
      });
    }
  }
  return ok(undefined);
}

export function validateDequeue(params: DequeueParams): Result<void, WorkQueueError> {
  if (params.limit < 1 || params.limit > MAX_DEQUEUE_BATCH) {
    return err({
      kind: "batch_out_of_range",
      requested: params.limit,
      min: 1,
      max: MAX_DEQUEUE_BATCH,
    });
  }
  if (params.leaseMs !== undefined && params.leaseMs <= 0) {
    return err({ kind: "lease_ms_non_positive", leaseMs: params.leaseMs });
  }
  return ok(undefined);
}

// Asserts on an unknown kind — a foreign kind in the table means the schema drifted
// from code, which is a programmer error (CLAUDE.md §6), not an operating error.
export function rowToItem(r: WorkRow): WorkItem {
  assert((WORK_KINDS as readonly string[]).includes(r.kind), "work_queue: unknown kind from DB", {
    kind: r.kind,
  });
  return {
    id: r.id as WorkItemId,
    tenantId: r.tenant_id as TenantId,
    kind: r.kind as WorkKind,
    payloadRef: r.payload_ref,
    scheduledAt: r.scheduled_at,
    attempts: r.attempts,
    traceparent: r.traceparent,
  };
}
