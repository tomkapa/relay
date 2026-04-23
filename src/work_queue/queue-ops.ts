// DB-touching work queue operations. Pure validation and row mapping live in
// `queue.ts`; this file is the postgres.js shell. Covered by integration tests per
// CLAUDE.md §3 — the FOR UPDATE SKIP LOCKED semantics cannot be tested against a mock.

import type { Sql } from "postgres";
import { assert } from "../core/assert.ts";
import { err, ok, type Result } from "../core/result.ts";
import { WorkItemId, mintId } from "../ids.ts";
import { Attr, SpanName, counter, withSpan } from "../telemetry/otel.ts";
import { DEFAULT_LEASE_MS, MAX_WORK_QUEUE_ROWS_PER_TENANT } from "./limits.ts";
import {
  rowToItem,
  validateDequeue,
  validateEnqueue,
  type DequeueParams,
  type EnqueueParams,
  type WorkItem,
  type WorkQueueError,
  type WorkRow,
  type WorkerId,
} from "./queue.ts";

export async function enqueue(
  sql: Sql,
  params: EnqueueParams,
): Promise<Result<WorkItemId, WorkQueueError>> {
  const v = validateEnqueue(params);
  if (!v.ok) return v;

  const id = mintId(WorkItemId.parse, "enqueue");
  const cap = MAX_WORK_QUEUE_ROWS_PER_TENANT;

  const rows = await sql<{ id: string }[]>`
    WITH candidate AS (
      SELECT ${id}::uuid          AS id,
             ${params.tenantId}::uuid AS tenant_id,
             ${params.kind}::text  AS kind,
             ${params.payloadRef}::text AS payload_ref,
             ${params.scheduledAt}::timestamptz AS scheduled_at
    )
    INSERT INTO work_queue (id, tenant_id, kind, payload_ref, scheduled_at)
    SELECT c.id, c.tenant_id, c.kind, c.payload_ref, c.scheduled_at
    FROM candidate c
    WHERE (
      SELECT count(*) FROM work_queue
      WHERE tenant_id = ${params.tenantId} AND completed_at IS NULL
    ) < ${cap}
    RETURNING id
  `;

  if (rows.length === 0) {
    counter(
      "relay.work_queue.enqueue_rejected_total",
      "Enqueue attempts rejected by capacity cap",
    ).add(1, {
      [Attr.TenantId]: params.tenantId,
    });
    return err({ kind: "queue_over_capacity", tenantId: params.tenantId, cap });
  }

  return ok(id);
}

// 'Ready' = not completed AND scheduled_at <= now AND (unleased OR lease expired).
// FOR UPDATE SKIP LOCKED lets concurrent workers pick disjoint rows without contention.
export async function dequeue(
  sql: Sql,
  params: DequeueParams,
): Promise<Result<readonly WorkItem[], WorkQueueError>> {
  const v = validateDequeue(params);
  if (!v.ok) return v;

  const leaseMs = params.leaseMs ?? DEFAULT_LEASE_MS;
  assert(leaseMs > 0, "dequeue: lease_ms positive post-validation", { leaseMs });
  const leaseUntil = new Date(params.now.getTime() + leaseMs);

  return withSpan(
    SpanName.WorkerPick,
    {
      [Attr.QueueOp]: "dequeue",
      [Attr.QueueBatch]: params.limit,
    },
    async (span) => {
      const rows = await sql<WorkRow[]>`
        UPDATE work_queue SET
          leased_by = ${params.workerId},
          leased_until = ${leaseUntil},
          attempts = attempts + 1,
          updated_at = now()
        WHERE id IN (
          SELECT id FROM work_queue
          WHERE completed_at IS NULL
            AND scheduled_at <= ${params.now}
            AND (leased_until IS NULL OR leased_until < ${params.now})
          ORDER BY scheduled_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT ${params.limit}
        )
        RETURNING id, tenant_id, kind, payload_ref, scheduled_at, attempts
      `;

      // UPDATE ... RETURNING does not preserve the inner ORDER BY — Postgres returns
      // updated rows in arbitrary physical order. The subquery picks the correct N rows
      // (earliest ready); we restore scheduled_at ordering here so callers see the
      // batch in the order a worker should process it.
      const items = rows
        .map(rowToItem)
        .sort(
          (a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime() || a.id.localeCompare(b.id),
        );
      span.setAttribute(Attr.QueuePicked, items.length);
      return ok(items);
    },
  );
}

// Succeeds only if the caller still holds the lease; otherwise returns lease_not_held
// so the caller can drop work that another worker reclaimed after a missed renewal.
export async function complete(
  sql: Sql,
  id: WorkItemId,
  workerId: WorkerId,
): Promise<Result<void, WorkQueueError>> {
  const rows = await sql<{ id: string }[]>`
    UPDATE work_queue
    SET completed_at = now(), updated_at = now()
    WHERE id = ${id}
      AND leased_by = ${workerId}
      AND completed_at IS NULL
    RETURNING id
  `;
  if (rows.length === 0) return err({ kind: "lease_not_held", id });
  return ok(undefined);
}

// Extends the lease deadline for an item the caller still holds. Returns lease_not_held
// if the caller no longer owns the item (stolen by another worker after a missed renewal).
export async function renewLease(
  sql: Sql,
  id: WorkItemId,
  workerId: WorkerId,
  nowMs: number,
  leaseMs: number = DEFAULT_LEASE_MS,
): Promise<Result<void, WorkQueueError>> {
  assert(leaseMs > 0, "renewLease: leaseMs must be positive", { leaseMs });
  const until = new Date(nowMs + leaseMs);
  const rows = await sql<{ id: string }[]>`
    UPDATE work_queue
    SET leased_until = ${until}, updated_at = now()
    WHERE id = ${id}
      AND leased_by = ${workerId}
      AND completed_at IS NULL
    RETURNING id
  `;
  if (rows.length === 0) return err({ kind: "lease_not_held", id });
  return ok(undefined);
}

// Drops the lease without completing. The next dequeue re-leases the row to whoever
// picks it up — for transient failures where waiting out the lease TTL would waste time.
export async function release(
  sql: Sql,
  id: WorkItemId,
  workerId: WorkerId,
): Promise<Result<void, WorkQueueError>> {
  const rows = await sql<{ id: string }[]>`
    UPDATE work_queue
    SET leased_by = NULL, leased_until = NULL, updated_at = now()
    WHERE id = ${id}
      AND leased_by = ${workerId}
      AND completed_at IS NULL
    RETURNING id
  `;
  if (rows.length === 0) return err({ kind: "lease_not_held", id });
  return ok(undefined);
}
