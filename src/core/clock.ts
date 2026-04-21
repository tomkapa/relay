// Production code takes a Clock rather than calling Date.now / performance.now / setTimeout.
// Tests pass FakeClock; production passes RealClock. See CLAUDE.md §11.

export interface Clock {
  // Wall-clock time in epoch milliseconds.
  now(): number;
  // Monotonic time in milliseconds — for measuring durations across pauses.
  monotonic(): number;
  // Returns a promise that resolves after `ms` milliseconds.
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason as Error);
        return;
      }
      const handle = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(handle);
        reject(signal?.reason as Error);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

// FakeClock — deterministic. `advance(ms)` wakes all pending sleeps whose deadline has passed.
export class FakeClock implements Clock {
  private wallMs: number;
  private monoMs = 0;
  private nextSleepId = 0;
  private readonly pending = new Map<number, { deadline: number; resolve: () => void }>();

  public constructor(startEpochMs = 0) {
    this.wallMs = startEpochMs;
  }

  public now(): number {
    return this.wallMs;
  }

  public monotonic(): number {
    return this.monoMs;
  }

  public async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason as Error;
    const id = this.nextSleepId++;
    const deadline = this.monoMs + ms;
    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, { deadline, resolve });
      signal?.addEventListener(
        "abort",
        () => {
          this.pending.delete(id);
          reject(signal.reason as Error);
        },
        { once: true },
      );
    });
  }

  // Advance both wall-clock and monotonic time by `ms`. Resolves any sleeps whose deadline passes.
  public advance(ms: number): void {
    if (ms < 0) throw new Error("FakeClock.advance: ms must be non-negative");
    this.wallMs += ms;
    this.monoMs += ms;
    for (const [id, entry] of this.pending) {
      if (entry.deadline <= this.monoMs) {
        this.pending.delete(id);
        entry.resolve();
      }
    }
  }

  public pendingSleeps(): number {
    return this.pending.size;
  }
}
