// Integration tests for the worker loop against real Postgres. Exercises the full
// dequeue→dispatch→complete path including concurrent workers and lease renewal.
// CLAUDE.md §3 — real Postgres in integration; mock only paid external services.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { assert } from "../../../src/core/assert.ts";
import { realClock } from "../../../src/core/clock.ts";
import { ok, type Result } from "../../../src/core/result.ts";
import type { WorkItemId } from "../../../src/ids.ts";
import { TenantId } from "../../../src/ids.ts";
import { migrate } from "../../../src/db/migrate-apply.ts";
import { enqueue } from "../../../src/work_queue/queue-ops.ts";
import type { WorkItem, WorkerId } from "../../../src/work_queue/queue.ts";
import { WorkerId as WorkerIdParser } from "../../../src/work_queue/queue.ts";
import type { Dispatcher, HandlerError } from "../../../src/worker/dispatcher.ts";
import { makeWorkerQueue, runWorker } from "../../../src/worker/worker.ts";
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

function worker(name: string): WorkerId {
  const r = WorkerIdParser.parse(name);
  if (!r.ok) throw new Error(`worker fixture: ${r.error.kind}`);
  return r.value;
}

beforeAll(async () => {
  if (!DB_URL) return;
  const s = postgres(DB_URL, { max: 8, idle_timeout: 2 });
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

describeOrSkip("worker (integration)", () => {
  test(
    "end-to-end: enqueue 2 items, worker processes both",
    async () => {
      const sql = requireSql();
      const t = tenant();
      const now = new Date();

      const [eq1, eq2] = await Promise.all([
        enqueue(sql, {
          tenantId: t,
          kind: "session_start",
          payloadRef: "session:1",
          scheduledAt: now,
        }),
        enqueue(sql, { tenantId: t, kind: "task_fire", payloadRef: "task:1", scheduledAt: now }),
      ]);
      assert(eq1.ok && eq2.ok, "enqueue fixture failed");

      let completedCount = 0;
      const ctrl = new AbortController();

      const onItem = (): Promise<Result<void, HandlerError>> => {
        completedCount++;
        if (completedCount >= 2) ctrl.abort();
        return Promise.resolve(ok(undefined));
      };
      const countingDispatcher: Dispatcher = {
        session_start: onItem,
        task_fire: onItem,
        inbound_message: onItem,
      };

      const queue = makeWorkerQueue(sql);
      await runWorker(
        {
          queue,
          workerId: worker("integration-worker-1"),
          clock: realClock,
          dispatcher: countingDispatcher,
          emptyIdleMs: 20,
          leaseRenewMs: 10_000,
        },
        ctrl.signal,
      );

      expect(completedCount).toBe(2);

      // Verify both rows are marked completed in DB.
      const rows = await sql<{ completed_at: Date | null }[]>`
        SELECT completed_at FROM work_queue
        WHERE id IN (${eq1.value}, ${eq2.value})
        ORDER BY id
      `;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.completed_at).not.toBeNull();
      }
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "two concurrent workers partition rows",
    async () => {
      const sql = requireSql();
      const t = tenant();
      const now = new Date();
      const TOTAL = 4;

      const enqueues = Array.from({ length: TOTAL }, (_, i) =>
        enqueue(sql, {
          tenantId: t,
          kind: "task_fire",
          payloadRef: `task:${i.toString()}`,
          scheduledAt: now,
        }),
      );
      const enqueuedResults = await Promise.all(enqueues);
      for (const r of enqueuedResults) assert(r.ok, "enqueue fixture failed");

      const processedByA: WorkItemId[] = [];
      const processedByB: WorkItemId[] = [];
      let totalProcessed = 0;

      const ctrlA = new AbortController();
      const ctrlB = new AbortController();

      function makeCountingDispatcher(
        processed: WorkItemId[],
        ctrlSelf: AbortController,
        ctrlOther: AbortController,
      ): Dispatcher {
        const handler = (item: WorkItem): Promise<Result<void, HandlerError>> => {
          processed.push(item.id);
          totalProcessed++;
          if (totalProcessed >= TOTAL) {
            ctrlSelf.abort();
            ctrlOther.abort();
          }
          return Promise.resolve(ok(undefined));
        };
        return { session_start: handler, task_fire: handler, inbound_message: handler };
      }

      const queueA = makeWorkerQueue(sql);
      const queueB = makeWorkerQueue(sql);

      await Promise.all([
        runWorker(
          {
            queue: queueA,
            workerId: worker("concurrent-worker-a"),
            clock: realClock,
            dispatcher: makeCountingDispatcher(processedByA, ctrlA, ctrlB),
            emptyIdleMs: 20,
            leaseRenewMs: 10_000,
          },
          ctrlA.signal,
        ),
        runWorker(
          {
            queue: queueB,
            workerId: worker("concurrent-worker-b"),
            clock: realClock,
            dispatcher: makeCountingDispatcher(processedByB, ctrlB, ctrlA),
            emptyIdleMs: 20,
            leaseRenewMs: 10_000,
          },
          ctrlB.signal,
        ),
      ]);

      expect(totalProcessed).toBe(TOTAL);

      // Verify no overlap between the two workers.
      const setA = new Set(processedByA);
      for (const id of processedByB) {
        expect(setA.has(id)).toBe(false);
      }
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "lease renewal keeps item from being reclaimed by another worker",
    async () => {
      const sql = requireSql();
      const t = tenant();
      const now = new Date();
      const renewMs = 200;

      const eq = await enqueue(sql, {
        tenantId: t,
        kind: "task_fire",
        payloadRef: "task:renewable",
        scheduledAt: now,
      });
      assert(eq.ok, "enqueue fixture failed");

      // Worker A holds the item and sleeps 3 * renewMs (real time).
      const ctrlA = new AbortController();

      const slowDispatcher: Dispatcher = {
        session_start: (): Promise<Result<void, HandlerError>> => Promise.resolve(ok(undefined)),
        task_fire: async (
          _item: WorkItem,
          signal: AbortSignal,
        ): Promise<Result<void, HandlerError>> => {
          await realClock.sleep(3 * renewMs, signal);
          return ok(undefined);
        },
        inbound_message: (): Promise<Result<void, HandlerError>> => Promise.resolve(ok(undefined)),
      };

      const queueA = makeWorkerQueue(sql);
      const workerAPromise = runWorker(
        {
          queue: queueA,
          workerId: worker("renewal-worker-a"),
          clock: realClock,
          dispatcher: slowDispatcher,
          emptyIdleMs: 20,
          leaseRenewMs: renewMs,
        },
        ctrlA.signal,
      );

      // Give worker A time to acquire the lease.
      await realClock.sleep(50);

      // Worker B tries to dequeue — should get nothing because A holds and renews the lease.
      const queueB = makeWorkerQueue(sql);
      const ctrlB = new AbortController();
      let workerBPickedUp = false;

      const onDetect = (): Promise<Result<void, HandlerError>> => {
        workerBPickedUp = true;
        return Promise.resolve(ok(undefined));
      };
      const detectingDispatcher: Dispatcher = {
        session_start: onDetect,
        task_fire: onDetect,
        inbound_message: onDetect,
      };

      // Let B poll for 2 * renewMs — the lease should still be held by A.
      const workerBTimeout = setTimeout(() => {
        ctrlB.abort();
      }, 2 * renewMs);

      await runWorker(
        {
          queue: queueB,
          workerId: worker("renewal-worker-b"),
          clock: realClock,
          dispatcher: detectingDispatcher,
          emptyIdleMs: 20,
          leaseRenewMs: renewMs,
        },
        ctrlB.signal,
      );

      clearTimeout(workerBTimeout);

      // Worker A should still be processing (not done yet).
      expect(workerBPickedUp).toBe(false);

      // Let worker A finish.
      ctrlA.abort();
      await workerAPromise;
    },
    HOOK_TIMEOUT_MS,
  );
});
