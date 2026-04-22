// Stateless worker loop. Repeatedly dequeues work items and dispatches them to
// handlers. The worker holds no in-memory state between polls — crash recovery is
// handled by lease expiry (SPEC §Retry and idempotency).
//
// `WorkerQueue` abstracts the Postgres ops so the loop is unit-testable without DB.

import type { Sql } from "postgres";
import { AssertionError, assert } from "../core/assert.ts";
import type { Clock } from "../core/clock.ts";
import type { Result } from "../core/result.ts";
import { Attr, SpanName, emit, withSpan } from "../telemetry/otel.ts";
import {
  complete as dbComplete,
  dequeue as dbDequeue,
  release as dbRelease,
  renewLease as dbRenewLease,
} from "../work_queue/queue-ops.ts";
import type { DequeueParams, WorkItem, WorkQueueError, WorkerId } from "../work_queue/queue.ts";
import type { Dispatcher } from "./dispatcher.ts";
import {
  EMPTY_QUEUE_IDLE_MS,
  IDLE_BACKOFF_CAP_MS,
  LEASE_RENEW_INTERVAL_MS,
  LOOP_ERROR_BACKOFF_MS,
} from "./limits.ts";
import type { WorkItemId } from "../ids.ts";

// WorkerQueue abstracts the Postgres work-queue ops. Injected via WorkerDeps so the
// loop can be unit-tested with a fake queue and integration-tested with the real one.
export type WorkerQueue = {
  readonly dequeue: (params: DequeueParams) => Promise<Result<readonly WorkItem[], WorkQueueError>>;
  readonly complete: (id: WorkItemId, workerId: WorkerId) => Promise<Result<void, WorkQueueError>>;
  readonly release: (id: WorkItemId, workerId: WorkerId) => Promise<Result<void, WorkQueueError>>;
  readonly renewLease: (
    id: WorkItemId,
    workerId: WorkerId,
    nowMs: number,
  ) => Promise<Result<void, WorkQueueError>>;
};

export type WorkerDeps = Readonly<{
  queue: WorkerQueue;
  workerId: WorkerId;
  clock: Clock;
  dispatcher: Dispatcher;
  emptyIdleMs?: number;
  errorBackoffMs?: number;
  leaseRenewMs?: number;
}>;

// Bind queue-ops functions to a specific Sql instance to produce a WorkerQueue.
export function makeWorkerQueue(sql: Sql): WorkerQueue {
  return {
    dequeue: (params) => dbDequeue(sql, params),
    complete: (id, workerId) => dbComplete(sql, id, workerId),
    release: (id, workerId) => dbRelease(sql, id, workerId),
    renewLease: (id, workerId, nowMs) => dbRenewLease(sql, id, workerId, nowMs),
  };
}

// Outer loop. Runs until signal is aborted. AssertionErrors propagate out (programmer
// error — crash the process). All other errors are caught and backed off.
export async function runWorker(deps: WorkerDeps, signal: AbortSignal): Promise<void> {
  assert(deps.workerId.length > 0, "worker: workerId must not be empty");
  const idleMs = deps.emptyIdleMs ?? EMPTY_QUEUE_IDLE_MS;
  const errorMs = deps.errorBackoffMs ?? LOOP_ERROR_BACKOFF_MS;
  assert(idleMs > 0, "worker: emptyIdleMs must be positive", { idleMs });
  assert(errorMs > 0, "worker: errorBackoffMs must be positive", { errorMs });

  let consecutiveIdles = 0;

  while (!signal.aborted) {
    let outcome: "processed" | "idle" | "error";
    try {
      outcome = await pollOnce(deps, signal);
    } catch (e) {
      if (e instanceof AssertionError) throw e;
      emit("ERROR", "worker.loop.error", { "relay.worker.error": String(e) });
      outcome = "error";
    }

    if (outcome === "processed") {
      consecutiveIdles = 0;
      continue;
    }

    const sleepMs = outcome === "error" ? errorMs : undefined;
    await sleepWithBackoff(deps.clock, consecutiveIdles, idleMs, signal, sleepMs);
    if (outcome === "idle") {
      consecutiveIdles++;
    } else {
      consecutiveIdles = 0;
    }
  }
}

// One dequeue→dispatch iteration. Returns the poll outcome for backoff decisions.
async function pollOnce(
  deps: WorkerDeps,
  signal: AbortSignal,
): Promise<"processed" | "idle" | "error"> {
  return withSpan(SpanName.WorkerTick, { [Attr.WorkerId]: deps.workerId }, async () => {
    const now = new Date(deps.clock.now());
    const dqResult = await deps.queue.dequeue({
      workerId: deps.workerId,
      limit: 1,
      now,
    });

    if (!dqResult.ok) {
      emit("ERROR", "worker.dequeue.error", { "relay.queue.error": dqResult.error.kind });
      return "error";
    }

    const items = dqResult.value;
    assert(items.length <= 1, "worker: dequeue limit=1 returned more than 1 item", {
      count: items.length,
    });

    if (items.length === 0) return "idle";

    const item = items[0];
    assert(item !== undefined, "worker: items[0] undefined despite length check");

    if (signal.aborted) return "idle";

    await processItem(deps, item, signal);
    return "processed";
  });
}

// Process a single work item: run handler concurrently with lease renewal,
// then complete or release depending on handler outcome.
async function processItem(deps: WorkerDeps, item: WorkItem, signal: AbortSignal): Promise<void> {
  const renewMs = deps.leaseRenewMs ?? LEASE_RENEW_INTERVAL_MS;
  assert(renewMs > 0, "worker: leaseRenewMs must be positive", { renewMs });

  const renewCtrl = new AbortController();

  // Start lease renewal loop concurrently with handler.
  const renewPromise = startRenewLoop(deps, item.id, renewMs, renewCtrl.signal);

  const handlerResult = await withSpan(
    SpanName.WorkerHandle,
    {
      [Attr.WorkId]: item.id,
      [Attr.WorkKind]: item.kind,
    },
    async () => {
      const handler = deps.dispatcher[item.kind];
      return handler(item, signal);
    },
  );

  // Stop renew loop whether handler succeeded or failed.
  renewCtrl.abort();
  await renewPromise;

  if (handlerResult.ok) {
    const completeResult = await deps.queue.complete(item.id, deps.workerId);
    if (!completeResult.ok) {
      emit("WARN", "worker.complete.lease_not_held", {
        [Attr.WorkId]: item.id,
        [Attr.WorkerId]: deps.workerId,
        "relay.queue.error": completeResult.error.kind,
      });
    }
    return;
  }

  emit("WARN", "worker.handler.error", {
    [Attr.WorkId]: item.id,
    [Attr.WorkKind]: item.kind,
    "relay.handler.error": handlerResult.error.kind,
  });

  const releaseResult = await deps.queue.release(item.id, deps.workerId);
  if (!releaseResult.ok) {
    emit("WARN", "worker.release.lease_not_held", {
      [Attr.WorkId]: item.id,
      [Attr.WorkerId]: deps.workerId,
      "relay.queue.error": releaseResult.error.kind,
    });
  }
}

// Concurrent loop that renews the lease every renewMs until aborted or lease stolen.
async function startRenewLoop(
  deps: WorkerDeps,
  id: WorkItemId,
  renewMs: number,
  signal: AbortSignal,
): Promise<void> {
  assert(renewMs > 0, "startRenewLoop: renewMs must be positive", { renewMs });

  while (!signal.aborted) {
    try {
      await deps.clock.sleep(renewMs, signal);
    } catch {
      // Aborted — handler finished, stop renewing.
      return;
    }

    const result = await deps.queue.renewLease(id, deps.workerId, deps.clock.now());

    if (!result.ok) {
      emit("WARN", "worker.renew.lease_not_held", {
        [Attr.WorkId]: id,
        [Attr.WorkerId]: deps.workerId,
        "relay.queue.error": result.error.kind,
      });
      return;
    }
  }
}

// Sleep with capped exponential back-off for idle polls. If overrideMs is provided,
// use that duration directly (used for error back-off).
async function sleepWithBackoff(
  clock: Clock,
  consecutiveIdles: number,
  idleMs: number,
  signal: AbortSignal,
  overrideMs?: number,
): Promise<void> {
  assert(consecutiveIdles >= 0, "sleepWithBackoff: consecutiveIdles must be non-negative", {
    consecutiveIdles,
  });
  assert(idleMs > 0, "sleepWithBackoff: idleMs must be positive", { idleMs });

  if (overrideMs !== undefined) {
    try {
      await clock.sleep(overrideMs, signal);
    } catch {
      // Aborted — return immediately.
    }
    return;
  }

  // Exponential back-off: idleMs * 2^consecutiveIdles, capped at IDLE_BACKOFF_CAP_MS.
  const backoff = Math.min(idleMs * Math.pow(2, consecutiveIdles), IDLE_BACKOFF_CAP_MS);
  try {
    await clock.sleep(backoff, signal);
  } catch {
    // Aborted — return immediately.
  }
}
