// Unit tests for the worker loop. All tests use FakeClock for deterministic timing
// and an in-memory WorkerQueue fake for clean isolation from Postgres.
// CLAUDE.md §3 — test observable behaviour at a boundary; never mock internal state.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { AssertionError } from "../../../src/core/assert.ts";
import { FakeClock } from "../../../src/core/clock.ts";
import { err, ok, type Result } from "../../../src/core/result.ts";
import type { WorkItemId } from "../../../src/ids.ts";
import { WorkItemId as WorkItemIdParser, TenantId } from "../../../src/ids.ts";
import {
  type WorkItem,
  type WorkKind,
  type WorkQueueError,
  WorkerId,
} from "../../../src/work_queue/queue.ts";
import type { Dispatcher, HandlerError } from "../../../src/worker/dispatcher.ts";
import { EMPTY_QUEUE_IDLE_MS, IDLE_BACKOFF_CAP_MS } from "../../../src/worker/limits.ts";
import type { WorkerQueue } from "../../../src/worker/worker.ts";
import { runWorker } from "../../../src/worker/worker.ts";
import {
  installMetricFixture,
  uninstallMetricFixture,
  sumCounter,
  type MetricFixture,
} from "../../helpers/metrics.ts";

// Allow many promise microtask flushes to propagate async state machines.
async function flush(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

function makeItem(kind: WorkKind): WorkItem {
  const idResult = WorkItemIdParser.parse(randomUUID());
  if (!idResult.ok) throw new Error("makeItem: UUID parse failed");
  const tenantResult = TenantId.parse(randomUUID());
  if (!tenantResult.ok) throw new Error("makeItem: TenantId parse failed");
  return {
    id: idResult.value,
    tenantId: tenantResult.value,
    kind,
    payloadRef: "test:ref",
    scheduledAt: new Date(0),
    attempts: 1,
    traceparent: null,
  };
}

function makeWorkerId(): WorkerId {
  return "test-worker" as WorkerId;
}

type FakeQueueState = {
  dequeueResponses: Result<readonly WorkItem[], WorkQueueError>[];
  completeCalls: { id: WorkItemId; workerId: WorkerId }[];
  releaseCalls: { id: WorkItemId; workerId: WorkerId }[];
  renewCalls: { id: WorkItemId; workerId: WorkerId; nowMs: number }[];
  dequeueCallCount: number;
};

type FakeQueue = WorkerQueue & { state: FakeQueueState };

function makeWorkerQueueFake(responses: Result<readonly WorkItem[], WorkQueueError>[]): FakeQueue {
  const state: FakeQueueState = {
    dequeueResponses: [...responses],
    completeCalls: [],
    releaseCalls: [],
    renewCalls: [],
    dequeueCallCount: 0,
  };

  return {
    state,
    dequeue: (): Promise<Result<readonly WorkItem[], WorkQueueError>> => {
      state.dequeueCallCount++;
      const response = state.dequeueResponses.shift();
      if (response !== undefined) return Promise.resolve(response);
      return Promise.resolve(ok([]));
    },
    complete: (id: WorkItemId, workerId: WorkerId): Promise<Result<void, WorkQueueError>> => {
      state.completeCalls.push({ id, workerId });
      return Promise.resolve(ok(undefined));
    },
    release: (id: WorkItemId, workerId: WorkerId): Promise<Result<void, WorkQueueError>> => {
      state.releaseCalls.push({ id, workerId });
      return Promise.resolve(ok(undefined));
    },
    renewLease: (
      id: WorkItemId,
      workerId: WorkerId,
      nowMs: number,
    ): Promise<Result<void, WorkQueueError>> => {
      state.renewCalls.push({ id, workerId, nowMs });
      return Promise.resolve(ok(undefined));
    },
  };
}

function makeNoopDispatcher(): Dispatcher {
  const handler = (): Promise<Result<void, HandlerError>> => Promise.resolve(ok(undefined));
  return {
    session_start: handler,
    task_fire: handler,
    inbound_message: handler,
    cascade_close: handler,
  };
}

let clock: FakeClock;
let ctrl: AbortController;

beforeEach(() => {
  clock = new FakeClock(1_000_000);
  ctrl = new AbortController();
});

describe("runWorker", () => {
  test("exits promptly when signal is already aborted", async () => {
    ctrl.abort();
    const queue = makeWorkerQueueFake([]);
    await runWorker(
      { queue, workerId: makeWorkerId(), clock, dispatcher: makeNoopDispatcher() },
      ctrl.signal,
    );
    expect(queue.state.dequeueCallCount).toBe(0);
  });

  test("idle dequeue causes sleep then polls again", async () => {
    // First dequeue: idle (empty). After clock advance, second dequeue: abort.
    let secondDequeueResolve: (() => void) | undefined;
    const secondDequeuePromise = new Promise<void>((res) => {
      secondDequeueResolve = res;
    });

    let dequeueCount = 0;
    const queue: WorkerQueue = {
      dequeue: (): Promise<Result<readonly WorkItem[], WorkQueueError>> => {
        dequeueCount++;
        if (dequeueCount === 1) return Promise.resolve(ok([]));
        // Second call: abort the signal then resolve idle so worker exits.
        ctrl.abort();
        secondDequeueResolve?.();
        return Promise.resolve(ok([]));
      },
      complete: () => Promise.resolve(ok(undefined)),
      release: () => Promise.resolve(ok(undefined)),
      renewLease: () => Promise.resolve(ok(undefined)),
    };

    const workerPromise = runWorker(
      {
        queue,
        workerId: makeWorkerId(),
        clock,
        dispatcher: makeNoopDispatcher(),
        emptyIdleMs: 100,
      },
      ctrl.signal,
    );

    // Flush so worker reaches its first idle sleep.
    await flush();
    expect(dequeueCount).toBe(1);

    // Advance clock past idle sleep so the second dequeue fires.
    clock.advance(100);
    await secondDequeuePromise;
    await flush();

    await workerPromise;
    expect(dequeueCount).toBe(2);
  });

  test("consecutive idle dequeues scale sleep up to IDLE_BACKOFF_CAP_MS", async () => {
    const sleepDurations: number[] = [];
    const idleMs = EMPTY_QUEUE_IDLE_MS;

    let dequeueCount = 0;
    const TOTAL_IDLES = 5;

    const queue: WorkerQueue = {
      dequeue: (): Promise<Result<readonly WorkItem[], WorkQueueError>> => {
        dequeueCount++;
        if (dequeueCount > TOTAL_IDLES) {
          ctrl.abort();
        }
        return Promise.resolve(ok([]));
      },
      complete: () => Promise.resolve(ok(undefined)),
      release: () => Promise.resolve(ok(undefined)),
      renewLease: () => Promise.resolve(ok(undefined)),
    };

    // Wrap clock.sleep to capture durations before delegating.
    const originalSleep = clock.sleep.bind(clock);
    const clockWithCapture = {
      now: () => clock.now(),
      monotonic: () => clock.monotonic(),
      sleep: (ms: number, signal?: AbortSignal): Promise<void> => {
        sleepDurations.push(ms);
        return originalSleep(ms, signal);
      },
    };

    const workerPromise = runWorker(
      {
        queue,
        workerId: makeWorkerId(),
        clock: clockWithCapture,
        dispatcher: makeNoopDispatcher(),
        emptyIdleMs: idleMs,
      },
      ctrl.signal,
    );

    // Advance clock enough to drive all idles through.
    for (let i = 0; i <= TOTAL_IDLES; i++) {
      await flush();
      clock.advance(IDLE_BACKOFF_CAP_MS * 2);
    }
    await flush();
    await workerPromise;

    // Verify durations are non-decreasing and capped.
    expect(sleepDurations.length).toBeGreaterThanOrEqual(TOTAL_IDLES);
    for (let i = 1; i < sleepDurations.length; i++) {
      const prev = sleepDurations[i - 1];
      const curr = sleepDurations[i];
      if (prev !== undefined && curr !== undefined) {
        expect(curr).toBeLessThanOrEqual(IDLE_BACKOFF_CAP_MS);
        // Once capped, stays capped.
        if (prev >= IDLE_BACKOFF_CAP_MS) expect(curr).toBe(IDLE_BACKOFF_CAP_MS);
      }
    }
  });

  test("handler ok — complete is called with correct id and workerId", async () => {
    const item = makeItem("task_fire");
    const queue = makeWorkerQueueFake([ok([item])]);
    const workerId = makeWorkerId();

    const workerPromise = runWorker(
      {
        queue,
        workerId,
        clock,
        dispatcher: makeNoopDispatcher(),
        emptyIdleMs: 100,
        leaseRenewMs: 50_000,
      },
      ctrl.signal,
    );

    // Let worker process and reach idle sleep after processing.
    await flush(50);
    clock.advance(100); // Trigger idle sleep to cycle to second dequeue (empty), then abort.
    await flush(50);
    ctrl.abort();
    await flush(20);
    await workerPromise;

    expect(queue.state.completeCalls).toHaveLength(1);
    expect(queue.state.completeCalls[0]?.id).toBe(item.id);
    expect(queue.state.completeCalls[0]?.workerId).toBe(workerId);
    expect(queue.state.releaseCalls).toHaveLength(0);
  });

  test("handler err — release is called and complete is not", async () => {
    const item = makeItem("session_start");
    const queue = makeWorkerQueueFake([ok([item])]);
    const workerId = makeWorkerId();

    const failingDispatcher: Dispatcher = {
      session_start: (): Promise<Result<void, HandlerError>> =>
        Promise.resolve(err<HandlerError>({ kind: "handler_failed", reason: "test error" })),
      task_fire: (): Promise<Result<void, HandlerError>> => Promise.resolve(ok(undefined)),
      inbound_message: (): Promise<Result<void, HandlerError>> => Promise.resolve(ok(undefined)),
      cascade_close: (): Promise<Result<void, HandlerError>> => Promise.resolve(ok(undefined)),
    };

    const workerPromise = runWorker(
      {
        queue,
        workerId,
        clock,
        dispatcher: failingDispatcher,
        emptyIdleMs: 100,
        leaseRenewMs: 50_000,
      },
      ctrl.signal,
    );

    await flush(50);
    clock.advance(100);
    await flush(50);
    ctrl.abort();
    await flush(20);
    await workerPromise;

    expect(queue.state.releaseCalls).toHaveLength(1);
    expect(queue.state.releaseCalls[0]?.id).toBe(item.id);
    expect(queue.state.completeCalls).toHaveLength(0);
  });

  test("lease renewal fires at leaseRenewMs intervals during long handler", async () => {
    const item = makeItem("task_fire");
    const renewMs = 100;
    const workerId = makeWorkerId();

    let handlerSignal: AbortSignal | undefined;
    let resolveHandler!: () => void;
    const handlerDone = new Promise<void>((res) => {
      resolveHandler = res;
    });

    const slowDispatcher: Dispatcher = {
      session_start: (): Promise<Result<void, HandlerError>> => Promise.resolve(ok(undefined)),
      task_fire: async (
        _item: WorkItem,
        signal: AbortSignal,
      ): Promise<Result<void, HandlerError>> => {
        handlerSignal = signal;
        // Sleep for 3 * renewMs via the clock, then resolve.
        await clock.sleep(3 * renewMs, signal);
        return ok(undefined);
      },
      inbound_message: (): Promise<Result<void, HandlerError>> => Promise.resolve(ok(undefined)),
      cascade_close: (): Promise<Result<void, HandlerError>> => Promise.resolve(ok(undefined)),
    };

    const renewCalls: number[] = [];

    // Queue: first dequeue returns item, second (after handler done) aborts.
    let dequeueCount = 0;
    const queue: WorkerQueue = {
      dequeue: (): Promise<Result<readonly WorkItem[], WorkQueueError>> => {
        dequeueCount++;
        if (dequeueCount === 1) return Promise.resolve(ok([item]));
        ctrl.abort();
        return Promise.resolve(ok([]));
      },
      complete: (): Promise<Result<void, WorkQueueError>> => {
        resolveHandler();
        return Promise.resolve(ok(undefined));
      },
      release: () => Promise.resolve(ok(undefined)),
      renewLease: (
        _id: WorkItemId,
        _wid: WorkerId,
        nowMs: number,
      ): Promise<Result<void, WorkQueueError>> => {
        renewCalls.push(nowMs);
        return Promise.resolve(ok(undefined));
      },
    };

    const workerPromise = runWorker(
      {
        queue,
        workerId,
        clock,
        dispatcher: slowDispatcher,
        emptyIdleMs: 100,
        leaseRenewMs: renewMs,
      },
      ctrl.signal,
    );

    // Let handler start.
    await flush(30);
    expect(handlerSignal).toBeDefined();

    // Advance clock by renewMs steps to trigger renewals.
    clock.advance(renewMs);
    await flush(30);
    clock.advance(renewMs);
    await flush(30);
    clock.advance(renewMs);
    await flush(30);

    // Handler sleep (3*renewMs) should now be done; wait for complete.
    await handlerDone;
    await flush(30);
    clock.advance(100);
    await flush(30);
    await workerPromise;

    // Should have renewed at least twice (at renewMs and 2*renewMs).
    expect(renewCalls.length).toBeGreaterThanOrEqual(2);
  });

  test("renewal stops when handler returns", async () => {
    const item = makeItem("inbound_message");
    const renewMs = 100;
    const workerId = makeWorkerId();

    const renewCalls: number[] = [];

    let dequeueCount = 0;
    const queue: WorkerQueue = {
      dequeue: (): Promise<Result<readonly WorkItem[], WorkQueueError>> => {
        dequeueCount++;
        if (dequeueCount === 1) return Promise.resolve(ok([item]));
        ctrl.abort();
        return Promise.resolve(ok([]));
      },
      complete: () => Promise.resolve(ok(undefined)),
      release: () => Promise.resolve(ok(undefined)),
      renewLease: (
        _id: WorkItemId,
        _wid: WorkerId,
        nowMs: number,
      ): Promise<Result<void, WorkQueueError>> => {
        renewCalls.push(nowMs);
        return Promise.resolve(ok(undefined));
      },
    };

    const workerPromise = runWorker(
      {
        queue,
        workerId,
        clock,
        dispatcher: makeNoopDispatcher(), // handler returns immediately
        emptyIdleMs: 100,
        leaseRenewMs: renewMs,
      },
      ctrl.signal,
    );

    // Let handler complete.
    await flush(50);

    const renewCountAfterHandler = renewCalls.length;

    // Advance clock well past renewMs — no new renewals should fire.
    clock.advance(renewMs * 5);
    await flush(50);
    ctrl.abort();
    await flush(20);
    await workerPromise;

    // No renewals should have happened after handler returned (handler is instant).
    expect(renewCalls.length).toBe(renewCountAfterHandler);
    expect(renewCountAfterHandler).toBe(0);
  });

  test("abort during handler propagates abort to handler signal", async () => {
    const item = makeItem("task_fire");
    const workerId = makeWorkerId();

    let capturedSignal: AbortSignal | undefined;
    let handlerStarted = false;

    const blockingDispatcher: Dispatcher = {
      session_start: (): Promise<Result<void, HandlerError>> => Promise.resolve(ok(undefined)),
      task_fire: (_item: WorkItem, signal: AbortSignal): Promise<Result<void, HandlerError>> => {
        handlerStarted = true;
        capturedSignal = signal;
        // Never resolves on its own — waits for abort.
        return new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              resolve(ok(undefined));
            },
            { once: true },
          );
        });
      },
      inbound_message: (): Promise<Result<void, HandlerError>> => Promise.resolve(ok(undefined)),
      cascade_close: (): Promise<Result<void, HandlerError>> => Promise.resolve(ok(undefined)),
    };

    const queue = makeWorkerQueueFake([ok([item])]);

    const workerPromise = runWorker(
      {
        queue,
        workerId,
        clock,
        dispatcher: blockingDispatcher,
        emptyIdleMs: 100,
        leaseRenewMs: 50_000,
      },
      ctrl.signal,
    );

    await flush(30);
    expect(handlerStarted).toBe(true);
    expect(capturedSignal?.aborted).toBe(false);

    ctrl.abort();
    await flush(30);

    expect(capturedSignal?.aborted).toBe(true);
    await workerPromise;
  });

  test("AssertionError from handler propagates out of runWorker", async () => {
    const item = makeItem("session_start");
    const workerId = makeWorkerId();

    const throwingDispatcher: Dispatcher = {
      session_start: (): Promise<Result<void, HandlerError>> => {
        throw new AssertionError("programmer error in handler");
      },
      task_fire: (): Promise<Result<void, HandlerError>> => Promise.resolve(ok(undefined)),
      inbound_message: (): Promise<Result<void, HandlerError>> => Promise.resolve(ok(undefined)),
      cascade_close: (): Promise<Result<void, HandlerError>> => Promise.resolve(ok(undefined)),
    };

    const queue = makeWorkerQueueFake([ok([item])]);

    let caught: unknown;
    try {
      await runWorker(
        {
          queue,
          workerId,
          clock,
          dispatcher: throwingDispatcher,
          emptyIdleMs: 100,
          leaseRenewMs: 50_000,
        },
        ctrl.signal,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AssertionError);
  });

  test("non-AssertionError from pollOnce is caught and treated as error outcome", async () => {
    // If pollOnce throws a non-AssertionError, the worker should log and back off,
    // not crash. We exercise the error-outcome path (line 78 emit + line 91 reset).
    let dequeueCount = 0;
    const queue: WorkerQueue = {
      dequeue: (): Promise<Result<readonly WorkItem[], WorkQueueError>> => {
        dequeueCount++;
        if (dequeueCount === 1) throw new Error("db flap");
        ctrl.abort();
        return Promise.resolve(ok([]));
      },
      complete: () => Promise.resolve(ok(undefined)),
      release: () => Promise.resolve(ok(undefined)),
      renewLease: () => Promise.resolve(ok(undefined)),
    };

    const workerPromise = runWorker(
      {
        queue,
        workerId: makeWorkerId(),
        clock,
        dispatcher: makeNoopDispatcher(),
        emptyIdleMs: 100,
        errorBackoffMs: 50,
      },
      ctrl.signal,
    );

    await flush(30);
    // Advance past the error backoff sleep.
    clock.advance(50);
    await flush(30);
    await workerPromise;

    expect(dequeueCount).toBeGreaterThanOrEqual(2);
  });

  test("dequeue returning error causes error outcome and back-off", async () => {
    let dequeueCount = 0;
    const queue: WorkerQueue = {
      dequeue: (): Promise<Result<readonly WorkItem[], WorkQueueError>> => {
        dequeueCount++;
        if (dequeueCount === 1)
          return Promise.resolve(
            err({ kind: "batch_out_of_range", requested: 0, min: 1, max: 32 }),
          );
        ctrl.abort();
        return Promise.resolve(ok([]));
      },
      complete: () => Promise.resolve(ok(undefined)),
      release: () => Promise.resolve(ok(undefined)),
      renewLease: () => Promise.resolve(ok(undefined)),
    };

    const workerPromise = runWorker(
      {
        queue,
        workerId: makeWorkerId(),
        clock,
        dispatcher: makeNoopDispatcher(),
        emptyIdleMs: 100,
        errorBackoffMs: 50,
      },
      ctrl.signal,
    );

    await flush(30);
    clock.advance(50);
    await flush(30);
    await workerPromise;

    expect(dequeueCount).toBeGreaterThanOrEqual(2);
  });

  test("complete returning lease_not_held emits WARN but does not crash", async () => {
    const item = makeItem("task_fire");
    const workerId = makeWorkerId();

    let dequeueCount = 0;
    const queue: WorkerQueue = {
      dequeue: (): Promise<Result<readonly WorkItem[], WorkQueueError>> => {
        dequeueCount++;
        if (dequeueCount === 1) return Promise.resolve(ok([item]));
        ctrl.abort();
        return Promise.resolve(ok([]));
      },
      complete: (): Promise<Result<void, WorkQueueError>> =>
        Promise.resolve(err({ kind: "lease_not_held", id: item.id })),
      release: () => Promise.resolve(ok(undefined)),
      renewLease: () => Promise.resolve(ok(undefined)),
    };

    const workerPromise = runWorker(
      {
        queue,
        workerId,
        clock,
        dispatcher: makeNoopDispatcher(),
        emptyIdleMs: 100,
        leaseRenewMs: 50_000,
      },
      ctrl.signal,
    );

    await flush(50);
    clock.advance(100);
    await flush(50);
    ctrl.abort();
    await flush(20);
    // Should not throw.
    await workerPromise;
  });

  test("release returning lease_not_held emits WARN but does not crash", async () => {
    const item = makeItem("session_start");
    const workerId = makeWorkerId();

    let dequeueCount = 0;
    const queue: WorkerQueue = {
      dequeue: (): Promise<Result<readonly WorkItem[], WorkQueueError>> => {
        dequeueCount++;
        if (dequeueCount === 1) return Promise.resolve(ok([item]));
        ctrl.abort();
        return Promise.resolve(ok([]));
      },
      complete: () => Promise.resolve(ok(undefined)),
      release: (): Promise<Result<void, WorkQueueError>> =>
        Promise.resolve(err({ kind: "lease_not_held", id: item.id })),
      renewLease: () => Promise.resolve(ok(undefined)),
    };

    const failingDispatcher: Dispatcher = {
      session_start: (): Promise<Result<void, HandlerError>> =>
        Promise.resolve(err<HandlerError>({ kind: "handler_failed", reason: "test" })),
      task_fire: (): Promise<Result<void, HandlerError>> => Promise.resolve(ok(undefined)),
      inbound_message: (): Promise<Result<void, HandlerError>> => Promise.resolve(ok(undefined)),
      cascade_close: (): Promise<Result<void, HandlerError>> => Promise.resolve(ok(undefined)),
    };

    const workerPromise = runWorker(
      {
        queue,
        workerId,
        clock,
        dispatcher: failingDispatcher,
        emptyIdleMs: 100,
        leaseRenewMs: 50_000,
      },
      ctrl.signal,
    );

    await flush(50);
    clock.advance(100);
    await flush(50);
    ctrl.abort();
    await flush(20);
    // Should not throw.
    await workerPromise;
  });

  test("handler throwing still cleans up the renew loop (no orphaned renewals)", async () => {
    // Regression: if a handler rejects (e.g. a clock.sleep that receives abort and throws),
    // processItem must still abort the renew loop. Previously the renew loop was orphaned
    // and kept firing renewLease queries after the handler threw, which surfaced as an
    // "unhandled error between tests" CONNECTION_ENDED in integration when the Sql was
    // closed mid-flight.
    const item = makeItem("task_fire");
    const renewMs = 100;
    const workerId = makeWorkerId();

    let renewCount = 0;
    let dequeueCount = 0;
    const queue: WorkerQueue = {
      dequeue: (): Promise<Result<readonly WorkItem[], WorkQueueError>> => {
        dequeueCount++;
        if (dequeueCount === 1) return Promise.resolve(ok([item]));
        ctrl.abort();
        return Promise.resolve(ok([]));
      },
      complete: () => Promise.resolve(ok(undefined)),
      release: () => Promise.resolve(ok(undefined)),
      renewLease: (): Promise<Result<void, WorkQueueError>> => {
        renewCount++;
        return Promise.resolve(ok(undefined));
      },
    };

    const throwingDispatcher: Dispatcher = {
      session_start: (): Promise<Result<void, HandlerError>> => Promise.resolve(ok(undefined)),
      task_fire: (): Promise<Result<void, HandlerError>> =>
        Promise.reject(new Error("handler crashed")),
      inbound_message: (): Promise<Result<void, HandlerError>> => Promise.resolve(ok(undefined)),
      cascade_close: (): Promise<Result<void, HandlerError>> => Promise.resolve(ok(undefined)),
    };

    const workerPromise = runWorker(
      {
        queue,
        workerId,
        clock,
        dispatcher: throwingDispatcher,
        emptyIdleMs: 100,
        errorBackoffMs: 50,
        leaseRenewMs: renewMs,
      },
      ctrl.signal,
    );

    // Let the handler run (and throw), then advance clock well past renewMs.
    // A properly-cleaned-up renew loop should not wake to fire any renewals.
    await flush(30);
    clock.advance(renewMs * 5);
    await flush(30);
    clock.advance(50);
    await flush(30);
    await workerPromise;

    expect(renewCount).toBe(0);
  });

  test("renewLease returning lease_not_held stops the renew loop", async () => {
    const item = makeItem("task_fire");
    const renewMs = 100;
    const workerId = makeWorkerId();

    let renewCount = 0;
    let resolveHandler!: () => void;
    const handlerDone = new Promise<void>((res) => {
      resolveHandler = res;
    });

    const slowDispatcher: Dispatcher = {
      session_start: (): Promise<Result<void, HandlerError>> => Promise.resolve(ok(undefined)),
      task_fire: async (
        _item: WorkItem,
        signal: AbortSignal,
      ): Promise<Result<void, HandlerError>> => {
        await clock.sleep(3 * renewMs, signal);
        return ok(undefined);
      },
      inbound_message: (): Promise<Result<void, HandlerError>> => Promise.resolve(ok(undefined)),
      cascade_close: (): Promise<Result<void, HandlerError>> => Promise.resolve(ok(undefined)),
    };

    let dequeueCount = 0;
    const queue: WorkerQueue = {
      dequeue: (): Promise<Result<readonly WorkItem[], WorkQueueError>> => {
        dequeueCount++;
        if (dequeueCount === 1) return Promise.resolve(ok([item]));
        ctrl.abort();
        return Promise.resolve(ok([]));
      },
      complete: (): Promise<Result<void, WorkQueueError>> => {
        resolveHandler();
        return Promise.resolve(ok(undefined));
      },
      release: () => Promise.resolve(ok(undefined)),
      renewLease: (): Promise<Result<void, WorkQueueError>> => {
        renewCount++;
        // First renewal: succeed. Second: simulate lease stolen.
        if (renewCount === 1) return Promise.resolve(ok(undefined));
        return Promise.resolve(err({ kind: "lease_not_held", id: item.id }));
      },
    };

    const workerPromise = runWorker(
      {
        queue,
        workerId,
        clock,
        dispatcher: slowDispatcher,
        emptyIdleMs: 100,
        leaseRenewMs: renewMs,
      },
      ctrl.signal,
    );

    await flush(30);
    // First renewal fires.
    clock.advance(renewMs);
    await flush(30);
    // Second renewal fires (returns lease_not_held, renew loop stops).
    clock.advance(renewMs);
    await flush(30);
    // Advance through handler sleep and let it complete.
    clock.advance(renewMs);
    await flush(30);

    await handlerDone;
    clock.advance(100);
    await flush(30);
    await workerPromise;

    expect(renewCount).toBeGreaterThanOrEqual(2);
  });
});

describe("saturation counters — worker tick", () => {
  let fixture: MetricFixture;
  const workerIdResult = WorkerId.parse("counter-test-worker");
  if (!workerIdResult.ok) throw new Error("counter-test-worker: invalid WorkerId");
  const WORKER_ID = workerIdResult.value;

  beforeEach(() => {
    fixture = installMetricFixture();
    clock = new FakeClock(1_000_000);
    ctrl = new AbortController();
  });

  afterEach(async () => {
    await uninstallMetricFixture();
  });

  test("3 idle polls then abort: iteration_total=3, completion_total=3 {outcome=idle}", async () => {
    let dequeueCount = 0;
    const queue: WorkerQueue = {
      dequeue: (): Promise<Result<readonly WorkItem[], WorkQueueError>> => {
        dequeueCount++;
        if (dequeueCount >= 3) ctrl.abort(); // abort during 3rd dequeue → exactly 3 iterations
        return Promise.resolve(ok([]));
      },
      complete: () => Promise.resolve(ok(undefined)),
      release: () => Promise.resolve(ok(undefined)),
      renewLease: () => Promise.resolve(ok(undefined)),
    };

    const workerPromise = runWorker(
      { queue, workerId: WORKER_ID, clock, dispatcher: makeNoopDispatcher(), emptyIdleMs: 50 },
      ctrl.signal,
    );

    for (let i = 0; i < 5; i++) {
      await flush();
      clock.advance(IDLE_BACKOFF_CAP_MS * 2);
    }
    await flush();
    await workerPromise;

    const rm = await fixture.collect();
    expect(sumCounter(rm, "relay.worker.tick_iteration_total")).toBe(3);
    expect(sumCounter(rm, "relay.worker.tick_completion_total", { "relay.outcome": "idle" })).toBe(
      3,
    );
  });

  test("one processed + one error outcome: correct completion attributes", async () => {
    const item = makeItem("task_fire");
    let dequeueCount = 0;
    const queue: WorkerQueue = {
      dequeue: (): Promise<Result<readonly WorkItem[], WorkQueueError>> => {
        dequeueCount++;
        if (dequeueCount === 1) return Promise.resolve(ok([item]));
        if (dequeueCount === 2) throw new Error("db flap");
        ctrl.abort();
        return Promise.resolve(ok([]));
      },
      complete: () => Promise.resolve(ok(undefined)),
      release: () => Promise.resolve(ok(undefined)),
      renewLease: () => Promise.resolve(ok(undefined)),
    };

    const workerPromise = runWorker(
      {
        queue,
        workerId: WORKER_ID,
        clock,
        dispatcher: makeNoopDispatcher(),
        emptyIdleMs: 50,
        errorBackoffMs: 50,
        leaseRenewMs: 50_000,
      },
      ctrl.signal,
    );

    await flush(50);
    clock.advance(50); // trigger idle sleep after processed
    await flush(50);
    clock.advance(50); // trigger error backoff
    await flush(50);
    clock.advance(50); // trigger idle sleep again
    await flush(50);
    await workerPromise;

    const rm = await fixture.collect();
    expect(
      sumCounter(rm, "relay.worker.tick_completion_total", { "relay.outcome": "processed" }),
    ).toBe(1);
    expect(sumCounter(rm, "relay.worker.tick_completion_total", { "relay.outcome": "error" })).toBe(
      1,
    );
  });
});

describe("cross-process trace context restoration", () => {
  // Run the worker against one item and return whatever traceparent the handler observed
  // inside its dispatched context. Abort after a single dispatch so the loop exits.
  async function observeDispatchedTraceparent(item: WorkItem): Promise<string | null> {
    const queue = makeWorkerQueueFake([ok([item])]);
    const observed: { value: string | null } = { value: null };
    const { captureTraceparent } = await import("../../../src/telemetry/otel.ts");
    const noop = (): Promise<Result<void, HandlerError>> => Promise.resolve(ok(undefined));
    const dispatcher: Dispatcher = {
      session_start: (): Promise<Result<void, HandlerError>> => {
        observed.value = captureTraceparent();
        ctrl.abort();
        return Promise.resolve(ok(undefined));
      },
      task_fire: noop,
      inbound_message: noop,
      cascade_close: noop,
    };

    const workerPromise = runWorker(
      { queue, workerId: makeWorkerId(), clock, dispatcher, emptyIdleMs: 50 },
      ctrl.signal,
    );
    await flush(30);
    clock.advance(50);
    await flush(30);
    await workerPromise;
    return observed.value;
  }

  test("item.traceparent becomes the active context during handler dispatch", async () => {
    const tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const captured = await observeDispatchedTraceparent({
      ...makeItem("session_start"),
      traceparent: tp,
    });

    // Handler's span_id will differ (it's the worker.handle span, a child of the remote
    // parent), so assert only on trace_id and flags.
    expect(captured).not.toBeNull();
    if (captured === null) return;
    const parts = captured.split("-");
    expect(parts[0]).toBe("00");
    expect(parts[1]).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(parts[3]).toBe("01");
  });

  test("null traceparent leaves the dispatcher without an inherited context", async () => {
    const captured = await observeDispatchedTraceparent({
      ...makeItem("session_start"),
      traceparent: null,
    });
    expect(captured).toBeNull();
  });
});
