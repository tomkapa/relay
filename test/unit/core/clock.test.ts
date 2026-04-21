import { describe, expect, test } from "bun:test";
import { FakeClock, realClock } from "../../../src/core/clock.ts";

describe("FakeClock", () => {
  test("now() advances with advance()", () => {
    const clock = new FakeClock(1000);
    expect(clock.now()).toBe(1000);
    clock.advance(250);
    expect(clock.now()).toBe(1250);
  });

  test("monotonic() starts at 0 and advances independently of wall clock", () => {
    const clock = new FakeClock(1_700_000_000_000);
    expect(clock.monotonic()).toBe(0);
    clock.advance(42);
    expect(clock.monotonic()).toBe(42);
  });

  test("sleep(ms) resolves when advance() passes the deadline", async () => {
    const clock = new FakeClock();
    let resolved = false;
    const p = clock.sleep(100).then(() => {
      resolved = true;
    });

    expect(clock.pendingSleeps()).toBe(1);
    clock.advance(50);
    await Promise.resolve();
    expect(resolved).toBe(false);

    clock.advance(60);
    await p;
    expect(resolved).toBe(true);
    expect(clock.pendingSleeps()).toBe(0);
  });

  test("sleep(ms) rejects if signal is already aborted", async () => {
    const clock = new FakeClock();
    const ctrl = new AbortController();
    ctrl.abort(new Error("cancelled"));
    let caught: Error | undefined;
    try {
      await clock.sleep(10, ctrl.signal);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toBe("cancelled");
  });

  test("advance(ms) rejects negative values", () => {
    const clock = new FakeClock();
    expect(() => {
      clock.advance(-1);
    }).toThrow();
  });

  test("sleep(ms) rejects when aborted mid-wait", async () => {
    const clock = new FakeClock();
    const ctrl = new AbortController();
    let caught: Error | undefined;
    const p = clock.sleep(1_000, ctrl.signal).catch((e: unknown) => {
      caught = e as Error;
    });
    expect(clock.pendingSleeps()).toBe(1);
    ctrl.abort(new Error("cancelled"));
    await p;
    expect(caught?.message).toBe("cancelled");
    expect(clock.pendingSleeps()).toBe(0);
  });
});

describe("realClock", () => {
  test("now() returns current wall-clock ms", () => {
    const before = Date.now();
    const seen = realClock.now();
    const after = Date.now();
    expect(seen).toBeGreaterThanOrEqual(before);
    expect(seen).toBeLessThanOrEqual(after);
  });

  test("monotonic() is non-decreasing across sequential calls", () => {
    const a = realClock.monotonic();
    const b = realClock.monotonic();
    expect(b).toBeGreaterThanOrEqual(a);
  });

  test("sleep(ms) resolves after at least that many ms", async () => {
    const start = realClock.monotonic();
    await realClock.sleep(10);
    const elapsed = realClock.monotonic() - start;
    // Allow a little slack for timer resolution; the floor is what matters.
    expect(elapsed).toBeGreaterThanOrEqual(9);
  });

  test("sleep(ms) rejects if signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("pre-aborted"));
    let caught: Error | undefined;
    try {
      await realClock.sleep(1_000, ctrl.signal);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toBe("pre-aborted");
  });

  test("sleep(ms) rejects when aborted mid-wait", async () => {
    const ctrl = new AbortController();
    const p = realClock.sleep(10_000, ctrl.signal);
    setTimeout(() => {
      ctrl.abort(new Error("mid-abort"));
    }, 5);
    let caught: Error | undefined;
    try {
      await p;
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toBe("mid-abort");
  });
});
