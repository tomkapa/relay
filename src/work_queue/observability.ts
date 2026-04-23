// Per-tenant queue depth and oldest-ready-age gauges. Registered once at worker boot;
// the returned disposer detaches the callback before pool shutdown so an in-flight
// scrape cannot hit a closed connection.

import type { BatchObservableResult } from "@opentelemetry/api";
import type { Sql } from "postgres";
import type { Clock } from "../core/clock.ts";
import { TenantId } from "../ids.ts";
import type { TenantId as TenantIdBrand } from "../ids.ts";
import { Attr, emit, getMeterForObservable } from "../telemetry/otel.ts";
import { MAX_TENANTS_OBSERVED_PER_TICK } from "./limits.ts";

type QueueRow = {
  readonly tenant_id: string;
  readonly depth: string;
  readonly oldest_age_seconds: string;
};

type ParsedQueueRow = {
  readonly tenantId: TenantIdBrand;
  readonly depth: number;
  readonly oldestAgeSeconds: number;
};

// Parse one DB row into branded/validated form. Returns null for malformed rows so the
// caller can WARN and drop the sample rather than crash the meter tick (CLAUDE §1 — parse
// at boundary; soft-fail chosen here because this IS the observability path — an assert
// would blank every tenant's metrics on a single bad row).
function parseQueueRow(r: QueueRow): ParsedQueueRow | null {
  const tid = TenantId.parse(r.tenant_id);
  if (!tid.ok) return null;
  const depth = Number(r.depth);
  if (!Number.isFinite(depth) || depth < 0) return null;
  const age = Number(r.oldest_age_seconds);
  if (!Number.isFinite(age) || age < 0) return null;
  return { tenantId: tid.value, depth, oldestAgeSeconds: age };
}

export function registerQueueGauges(sql: Sql, clock: Clock): () => void {
  const m = getMeterForObservable();
  const depth = m.createObservableGauge("relay.work_queue.depth", {
    description: "Uncompleted work_queue rows, per tenant",
    unit: "{row}",
  });
  const age = m.createObservableGauge("relay.work_queue.oldest_ready_age_seconds", {
    description: "Age of oldest ready (scheduled_at <= now, uncompleted) row, per tenant",
    unit: "s",
  });

  const callback = async (result: BatchObservableResult): Promise<void> => {
    // Single reference time per tick — matches dequeue's `params.now` semantics so the
    // gauge reports rows by the same definition of "ready" the worker would pick up
    // (CLAUDE §11 — production code takes a Clock, not the DB's wall clock).
    const now = new Date(clock.now());
    const raw = await sql<QueueRow[]>`
        SELECT
          tenant_id,
          count(*)::bigint AS depth,
          COALESCE(
            EXTRACT(
              EPOCH FROM
              (${now}::timestamptz - min(scheduled_at) FILTER (WHERE scheduled_at <= ${now}::timestamptz))
            ),
            0
          )::numeric AS oldest_age_seconds
        FROM work_queue
        WHERE completed_at IS NULL
        GROUP BY tenant_id
      `;

    let parsed: ParsedQueueRow[] = [];
    for (const r of raw) {
      const p = parseQueueRow(r);
      if (p === null) {
        emit("WARN", "work_queue.observer.invalid_row", {
          "relay.tenant_id_raw": r.tenant_id,
          "relay.depth_raw": r.depth,
          "relay.oldest_age_seconds_raw": r.oldest_age_seconds,
        });
        continue;
      }
      parsed.push(p);
    }

    if (parsed.length > MAX_TENANTS_OBSERVED_PER_TICK) {
      emit("ERROR", "work_queue.observer.cardinality_overflow", {
        "relay.observed": parsed.length,
        "relay.max": MAX_TENANTS_OBSERVED_PER_TICK,
      });
      parsed = parsed
        .slice()
        .sort((a, b) => b.depth - a.depth)
        .slice(0, MAX_TENANTS_OBSERVED_PER_TICK);
    }

    for (const r of parsed) {
      const attrs = { [Attr.TenantId]: r.tenantId };
      result.observe(depth, r.depth, attrs);
      result.observe(age, r.oldestAgeSeconds, attrs);
    }
  };

  m.addBatchObservableCallback(callback, [depth, age]);
  return () => {
    m.removeBatchObservableCallback(callback, [depth, age]);
  };
}
