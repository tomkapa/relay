// Integration tests for the Postgres-backed work queue. Real Postgres per CLAUDE.md §3
// — the FOR UPDATE SKIP LOCKED dequeue, the lease contract, and the 'ready' predicate
// cannot be faithfully tested against a mock.
//
// Consumes INTEGRATION_DATABASE_URL (same contract as test/integration/db/migrate.test.ts).
// Skipped when the env var is unset so `bun test` stays green on a machine without Docker.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import postgres, { type Sql } from "postgres";
import { randomUUID } from "node:crypto";
import { assert } from "../../../src/core/assert.ts";
import { TenantId, WorkItemId } from "../../../src/ids.ts";
import { migrate } from "../../../src/db/migrate-apply.ts";
import { complete, dequeue, enqueue, release } from "../../../src/work_queue/queue-ops.ts";
import { WorkerId } from "../../../src/work_queue/queue.ts";
import { DB_URL, HOOK_TIMEOUT_MS, MIGRATIONS_DIR, describeOrSkip, resetDb } from "../helpers.ts";

let sqlRef: Sql | undefined;

function requireSql(): Sql {
  assert(sqlRef !== undefined, "integration test: sql initialized by beforeAll");
  return sqlRef;
}

function tenant(): TenantId {
  const raw = randomUUID();
  const r = TenantId.parse(raw);
  if (!r.ok) throw new Error("tenant fixture");
  return r.value;
}

function worker(name: string): WorkerId {
  const r = WorkerId.parse(name);
  if (!r.ok) throw new Error(`worker fixture: ${r.error.kind}`);
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

describeOrSkip("work_queue (integration)", () => {
  test(
    "enqueue then dequeue returns the item with the same fields",
    async () => {
      const sql = requireSql();
      const t = tenant();
      const w = worker("worker-1");
      const now = new Date();

      const eq = await enqueue(sql, {
        tenantId: t,
        kind: "session_start",
        payloadRef: "session:abc",
        scheduledAt: now,
      });
      expect(eq.ok).toBe(true);
      if (!eq.ok) return;

      const dq = await dequeue(sql, { workerId: w, limit: 1, now });
      expect(dq.ok).toBe(true);
      if (!dq.ok) return;
      expect(dq.value).toHaveLength(1);
      const item = dq.value[0];
      expect(item).toBeDefined();
      if (!item) return;
      expect(item.id).toBe(eq.value);
      expect(item.tenantId).toBe(t);
      expect(item.kind).toBe("session_start");
      expect(item.payloadRef).toBe("session:abc");
      expect(item.attempts).toBe(1);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "dequeue is exclusive — a second call sees nothing while the first holds the lease",
    async () => {
      const sql = requireSql();
      const t = tenant();
      const a = worker("worker-a");
      const b = worker("worker-b");
      const now = new Date();

      await enqueue(sql, {
        tenantId: t,
        kind: "task_fire",
        payloadRef: "task:1",
        scheduledAt: now,
      });

      const first = await dequeue(sql, { workerId: a, limit: 10, now });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.value).toHaveLength(1);

      const second = await dequeue(sql, { workerId: b, limit: 10, now });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value).toHaveLength(0);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "scheduled_at in the future is not dequeued until its time arrives",
    async () => {
      const sql = requireSql();
      const t = tenant();
      const w = worker("worker-1");
      const now = new Date();
      const future = new Date(now.getTime() + 60_000);

      await enqueue(sql, {
        tenantId: t,
        kind: "task_fire",
        payloadRef: "task:future",
        scheduledAt: future,
      });

      const early = await dequeue(sql, { workerId: w, limit: 10, now });
      expect(early.ok).toBe(true);
      if (!early.ok) return;
      expect(early.value).toHaveLength(0);

      const later = await dequeue(sql, {
        workerId: w,
        limit: 10,
        now: new Date(future.getTime() + 1_000),
      });
      expect(later.ok).toBe(true);
      if (!later.ok) return;
      expect(later.value).toHaveLength(1);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "an expired lease is reclaimed by the next dequeue",
    async () => {
      const sql = requireSql();
      const t = tenant();
      const a = worker("worker-a");
      const b = worker("worker-b");
      const now = new Date();

      const eq = await enqueue(sql, {
        tenantId: t,
        kind: "inbound_message",
        payloadRef: "msg:1",
        scheduledAt: now,
      });
      expect(eq.ok).toBe(true);
      if (!eq.ok) return;

      const first = await dequeue(sql, { workerId: a, limit: 1, leaseMs: 1_000, now });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.value).toHaveLength(1);

      const afterExpiry = new Date(now.getTime() + 5_000);
      const second = await dequeue(sql, {
        workerId: b,
        limit: 1,
        leaseMs: 1_000,
        now: afterExpiry,
      });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value).toHaveLength(1);
      const [item] = second.value;
      expect(item).toBeDefined();
      if (!item) return;
      expect(item.id).toBe(eq.value);
      expect(item.attempts).toBe(2);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "complete succeeds for the current lease holder and marks the row done",
    async () => {
      const sql = requireSql();
      const t = tenant();
      const w = worker("worker-1");
      const now = new Date();

      const eq = await enqueue(sql, {
        tenantId: t,
        kind: "task_fire",
        payloadRef: "task:x",
        scheduledAt: now,
      });
      expect(eq.ok).toBe(true);
      if (!eq.ok) return;

      const dq = await dequeue(sql, { workerId: w, limit: 1, now });
      expect(dq.ok).toBe(true);

      const done = await complete(sql, eq.value, w);
      expect(done.ok).toBe(true);

      const after = await dequeue(sql, { workerId: w, limit: 10, now });
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(after.value).toHaveLength(0);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "complete returns lease_not_held when the caller does not own the current lease",
    async () => {
      const sql = requireSql();
      const t = tenant();
      const a = worker("worker-a");
      const b = worker("worker-b");
      const now = new Date();

      const eq = await enqueue(sql, {
        tenantId: t,
        kind: "task_fire",
        payloadRef: "task:y",
        scheduledAt: now,
      });
      expect(eq.ok).toBe(true);
      if (!eq.ok) return;

      await dequeue(sql, { workerId: a, limit: 1, now });
      const badComplete = await complete(sql, eq.value, b);
      expect(badComplete.ok).toBe(false);
      if (!badComplete.ok) expect(badComplete.error.kind).toBe("lease_not_held");
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "complete on a non-existent id returns lease_not_held",
    async () => {
      const sql = requireSql();
      const w = worker("worker-1");
      const parsed = WorkItemId.parse(randomUUID());
      if (!parsed.ok) throw new Error("ghost id fixture");
      const r = await complete(sql, parsed.value, w);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe("lease_not_held");
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "release re-opens the item for the next dequeue",
    async () => {
      const sql = requireSql();
      const t = tenant();
      const a = worker("worker-a");
      const b = worker("worker-b");
      const now = new Date();

      const eq = await enqueue(sql, {
        tenantId: t,
        kind: "session_start",
        payloadRef: "session:retry",
        scheduledAt: now,
      });
      expect(eq.ok).toBe(true);
      if (!eq.ok) return;

      const first = await dequeue(sql, { workerId: a, limit: 1, now });
      expect(first.ok).toBe(true);

      const rel = await release(sql, eq.value, a);
      expect(rel.ok).toBe(true);

      const second = await dequeue(sql, { workerId: b, limit: 1, now });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value).toHaveLength(1);
      const [item] = second.value;
      expect(item?.id).toBe(eq.value);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "release returns lease_not_held when the caller does not own the lease",
    async () => {
      const sql = requireSql();
      const t = tenant();
      const a = worker("worker-a");
      const b = worker("worker-b");
      const now = new Date();

      const eq = await enqueue(sql, {
        tenantId: t,
        kind: "task_fire",
        payloadRef: "task:z",
        scheduledAt: now,
      });
      expect(eq.ok).toBe(true);
      if (!eq.ok) return;

      await dequeue(sql, { workerId: a, limit: 1, now });
      const bad = await release(sql, eq.value, b);
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error.kind).toBe("lease_not_held");
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "dequeue with limit N returns up to N ready items in scheduled_at order",
    async () => {
      const sql = requireSql();
      const t = tenant();
      const w = worker("worker-1");
      const now = new Date();

      const t0 = new Date(now.getTime() - 3_000);
      const t1 = new Date(now.getTime() - 2_000);
      const t2 = new Date(now.getTime() - 1_000);

      const [first, second, third] = await Promise.all([
        enqueue(sql, { tenantId: t, kind: "task_fire", payloadRef: "task:a", scheduledAt: t0 }),
        enqueue(sql, { tenantId: t, kind: "task_fire", payloadRef: "task:b", scheduledAt: t1 }),
        enqueue(sql, { tenantId: t, kind: "task_fire", payloadRef: "task:c", scheduledAt: t2 }),
      ]);
      expect(first.ok && second.ok && third.ok).toBe(true);

      const dq = await dequeue(sql, { workerId: w, limit: 2, now });
      expect(dq.ok).toBe(true);
      if (!dq.ok) return;
      expect(dq.value).toHaveLength(2);
      if (first.ok && second.ok) {
        expect(dq.value[0]?.id).toBe(first.value);
        expect(dq.value[1]?.id).toBe(second.value);
      }
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "concurrent dequeues partition rows via FOR UPDATE SKIP LOCKED",
    async () => {
      const sql = requireSql();
      const t = tenant();
      const a = worker("worker-a");
      const b = worker("worker-b");
      const now = new Date();

      // Each dequeue takes limit=5 from 10 rows. If both run concurrently on separate
      // connections (the postgres.js pool has max >= 2), SKIP LOCKED guarantees they
      // partition: neither sees the other's locked rows, so the union is all 10.
      const PER_WORKER = 5;
      const TOTAL = PER_WORKER * 2;
      const enqueues = Array.from({ length: TOTAL }, (_, i) =>
        enqueue(sql, {
          tenantId: t,
          kind: "task_fire",
          payloadRef: `task:${i.toString()}`,
          scheduledAt: now,
        }),
      );
      const results = await Promise.all(enqueues);
      for (const r of results) expect(r.ok).toBe(true);

      const [dqA, dqB] = await Promise.all([
        dequeue(sql, { workerId: a, limit: PER_WORKER, now }),
        dequeue(sql, { workerId: b, limit: PER_WORKER, now }),
      ]);
      expect(dqA.ok).toBe(true);
      expect(dqB.ok).toBe(true);
      if (!dqA.ok || !dqB.ok) return;

      const setA = new Set(dqA.value.map((x) => x.id));
      const setB = new Set(dqB.value.map((x) => x.id));
      for (const id of setA) expect(setB.has(id)).toBe(false);
      expect(setA.size + setB.size).toBe(TOTAL);
      expect(setA.size).toBe(PER_WORKER);
      expect(setB.size).toBe(PER_WORKER);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "validation errors surface without touching the DB",
    async () => {
      const sql = requireSql();
      const w = worker("worker-1");
      const now = new Date();

      const badPayload = await enqueue(sql, {
        tenantId: tenant(),
        kind: "task_fire",
        payloadRef: "",
        scheduledAt: now,
      });
      expect(badPayload.ok).toBe(false);
      if (!badPayload.ok) expect(badPayload.error.kind).toBe("payload_ref_empty");

      const badBatch = await dequeue(sql, { workerId: w, limit: 0, now });
      expect(badBatch.ok).toBe(false);
      if (!badBatch.ok) expect(badBatch.error.kind).toBe("batch_out_of_range");
    },
    HOOK_TIMEOUT_MS,
  );
});
