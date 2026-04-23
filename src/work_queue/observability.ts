// Per-tenant queue depth and oldest-ready-age gauges. Registered once at worker boot;
// the returned disposer detaches the callback before pool shutdown so an in-flight
// scrape cannot hit a closed connection.

import type { BatchObservableResult } from "@opentelemetry/api";
import type { Sql } from "postgres";
import { Attr, emit, getMeterForObservable } from "../telemetry/otel.ts";
import { MAX_TENANTS_OBSERVED_PER_TICK } from "./limits.ts";

type QueueRow = {
  readonly tenant_id: string;
  readonly depth: string;
  readonly oldest_age_seconds: string;
};

export function registerQueueGauges(sql: Sql): () => void {
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
    let rows: QueueRow[] = Array.from(
      await sql<QueueRow[]>`
        SELECT
          tenant_id,
          count(*)::bigint AS depth,
          COALESCE(
            EXTRACT(EPOCH FROM (now() - min(scheduled_at) FILTER (WHERE scheduled_at <= now()))),
            0
          )::numeric AS oldest_age_seconds
        FROM work_queue
        WHERE completed_at IS NULL
        GROUP BY tenant_id
      `,
    );

    if (rows.length > MAX_TENANTS_OBSERVED_PER_TICK) {
      emit("ERROR", "work_queue.observer.cardinality_overflow", {
        "relay.observed": rows.length,
        "relay.max": MAX_TENANTS_OBSERVED_PER_TICK,
      });
      rows = rows
        .slice()
        .sort((a, b) => Number(b.depth) - Number(a.depth))
        .slice(0, MAX_TENANTS_OBSERVED_PER_TICK);
    }

    for (const r of rows) {
      const attrs = { [Attr.TenantId]: r.tenant_id };
      result.observe(depth, Number(r.depth), attrs);
      result.observe(age, Number(r.oldest_age_seconds), attrs);
    }
  };

  m.addBatchObservableCallback(callback, [depth, age]);
  return () => {
    m.removeBatchObservableCallback(callback, [depth, age]);
  };
}
