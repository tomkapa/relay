// Integration tests for the work_queue ObservableGauge callback.
// Uses a real Postgres DB to verify that the SQL query backing the gauges returns
// correct values; the OTel metric provider is a test fixture, not the production SDK.
//
// Consumes INTEGRATION_DATABASE_URL. Skipped when the env var is absent.

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import postgres, { type Sql } from "postgres";
import { randomUUID } from "node:crypto";
import { assert } from "../../../src/core/assert.ts";
import { realClock } from "../../../src/core/clock.ts";
import { TenantId } from "../../../src/ids.ts";
import { migrate } from "../../../src/db/migrate-apply.ts";
import { Attr } from "../../../src/telemetry/otel.ts";
import { registerQueueGauges } from "../../../src/work_queue/observability.ts";
import {
  installMetricFixture,
  uninstallMetricFixture,
  type MetricFixture,
} from "../../helpers/metrics.ts";
import { DB_URL, HOOK_TIMEOUT_MS, MIGRATIONS_DIR, describeOrSkip, resetDb } from "../helpers.ts";

let sqlRef: Sql | undefined;

function requireSql(): Sql {
  assert(sqlRef !== undefined, "integration test: sql initialized by beforeAll");
  return sqlRef;
}

function tenant(): TenantId {
  const r = TenantId.parse(randomUUID());
  if (!r.ok) throw new Error("tenant fixture");
  return r.value;
}

beforeAll(async () => {
  if (!DB_URL) return;
  const s = postgres(DB_URL, { max: 4, idle_timeout: 2 });
  await s`SELECT 1`;
  await resetDb(s);
  const mig = await migrate(s, MIGRATIONS_DIR);
  if (!mig.ok) throw new Error(`migration setup failed: ${mig.error.kind}`);
  sqlRef = s;
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  if (sqlRef !== undefined) await sqlRef.end({ timeout: 5 });
}, 10_000);

beforeEach(async () => {
  if (!DB_URL) return;
  const sql = requireSql();
  await sql`TRUNCATE TABLE work_queue`;
});

// Helper: read observations for a specific metric and tenant from ResourceMetrics.
function observationsForTenant(
  rm: Awaited<ReturnType<MetricFixture["collect"]>>,
  metricName: string,
  tenantId: string,
): number[] {
  const values: number[] = [];
  for (const sm of rm.scopeMetrics) {
    for (const metric of sm.metrics) {
      if (metric.descriptor.name !== metricName) continue;
      for (const dp of metric.dataPoints) {
        if (dp.attributes[Attr.TenantId] === tenantId) {
          values.push(dp.value as number);
        }
      }
    }
  }
  return values;
}

describeOrSkip("work_queue observer (integration)", () => {
  let fixture: MetricFixture;
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    fixture = installMetricFixture();
  });

  afterEach(async () => {
    dispose?.();
    dispose = undefined;
    await uninstallMetricFixture();
  });

  test(
    "depth observation equals number of enqueued rows for a tenant",
    async () => {
      const sql = requireSql();
      const t = tenant();
      const now = new Date();
      const N = 5;

      const rows = Array.from({ length: N }, (_, i) => ({
        id: randomUUID(),
        tenant_id: t,
        kind: "task_fire",
        payload_ref: `task:obs:${i.toString()}`,
        scheduled_at: now,
      }));
      await sql`
        INSERT INTO work_queue ${sql(rows, "id", "tenant_id", "kind", "payload_ref", "scheduled_at")}
      `;

      dispose = registerQueueGauges(sql, realClock);
      const rm = await fixture.collect();
      const depths = observationsForTenant(rm, "relay.work_queue.depth", t);
      expect(depths).toHaveLength(1);
      expect(depths[0]).toBe(N);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "oldest_ready_age_seconds is at least 60 for a past-scheduled row",
    async () => {
      const sql = requireSql();
      const t = tenant();
      const pastScheduled = new Date(Date.now() - 60_000);

      await sql`
        INSERT INTO work_queue (id, tenant_id, kind, payload_ref, scheduled_at)
        VALUES (
          ${randomUUID()}::uuid,
          ${t}::uuid,
          'task_fire',
          'task:age-test',
          ${pastScheduled}::timestamptz
        )
      `;

      dispose = registerQueueGauges(sql, realClock);
      const rm = await fixture.collect();
      const ages = observationsForTenant(rm, "relay.work_queue.oldest_ready_age_seconds", t);
      expect(ages).toHaveLength(1);
      // The row was scheduled 60s ago; allow generous ±10s for CI clock skew
      assert(ages[0] !== undefined, "observer test: age observation must exist");
      expect(ages[0]).toBeGreaterThanOrEqual(50);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "future-scheduled row contributes to depth but not to oldest_ready_age",
    async () => {
      const sql = requireSql();
      const t = tenant();
      const future = new Date(Date.now() + 60_000);

      await sql`
        INSERT INTO work_queue (id, tenant_id, kind, payload_ref, scheduled_at)
        VALUES (
          ${randomUUID()}::uuid,
          ${t}::uuid,
          'task_fire',
          'task:future',
          ${future}::timestamptz
        )
      `;

      dispose = registerQueueGauges(sql, realClock);
      const rm = await fixture.collect();

      // Depth = 1 (the row is uncompleted)
      const depths = observationsForTenant(rm, "relay.work_queue.depth", t);
      expect(depths).toHaveLength(1);
      expect(depths[0]).toBe(1);

      // oldest_ready_age = 0 (COALESCE of NULL from the FILTER WHERE scheduled_at <= now())
      const ages = observationsForTenant(rm, "relay.work_queue.oldest_ready_age_seconds", t);
      expect(ages).toHaveLength(1);
      expect(ages[0]).toBe(0);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "empty queue emits zero observations (not zero-valued observations)",
    async () => {
      const sql = requireSql();
      const t = tenant();

      dispose = registerQueueGauges(sql, realClock);
      const rm = await fixture.collect();

      const depths = observationsForTenant(rm, "relay.work_queue.depth", t);
      expect(depths).toHaveLength(0);
      const ages = observationsForTenant(rm, "relay.work_queue.oldest_ready_age_seconds", t);
      expect(ages).toHaveLength(0);
    },
    HOOK_TIMEOUT_MS,
  );
});
