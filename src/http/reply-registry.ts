// In-memory registry keyed by EnvelopeId for sync-response dispatch.
// Each POST /trigger registers a waiter here; the Postgres LISTEN callback resolves it.
// Bounded by MAX_PENDING_SYNC_WAITERS (static allocation per CLAUDE.md §9).

import { assert } from "../core/assert.ts";
import type { Clock } from "../core/clock.ts";
import { err, ok, type Result } from "../core/result.ts";
import type { EnvelopeId, SessionId } from "../ids.ts";
import { upDownCounter } from "../telemetry/otel.ts";
import { MAX_PENDING_SYNC_WAITERS } from "./limits.ts";

// Hoisted so register/settle pay a direct reference, not a string lookup on every call.
const pendingWaiters = upDownCounter("relay.http.trigger.pending_sync_waiters");

export type SyncOutcome =
  | {
      readonly kind: "closed";
      readonly sessionId: SessionId;
      readonly reason: "end_turn" | "turn_cap_exceeded";
    }
  | { readonly kind: "timeout"; readonly waitedMs: number };

export type RegistryCapacityError = {
  readonly kind: "sync_capacity_exhausted";
  readonly cap: number;
};

type Deferred = {
  readonly resolve: (outcome: SyncOutcome) => void;
  readonly registeredAt: number;
};

export interface ReplyRegistry {
  /** Register a waiter before enqueue. Returns the deferred promise, or a typed error if at capacity. Throws AssertionError on duplicate envelopeId (programmer error). */
  register(envelopeId: EnvelopeId): Result<Promise<SyncOutcome>, RegistryCapacityError>;
  /** Resolve a waiting request. No-op if unknown (normal on other replicas). */
  resolve(envelopeId: EnvelopeId, outcome: SyncOutcome): void;
  /** Drop a waiter, settling the promise with a timeout outcome for GC hygiene. No-op if unknown. */
  drop(envelopeId: EnvelopeId): void;
  /** Count of currently pending waiters — drives the saturation gauge. */
  pending(): number;
}

export function makeReplyRegistry(clock: Clock): ReplyRegistry {
  const map = new Map<EnvelopeId, Deferred>();

  function settle(envelopeId: EnvelopeId, outcome: SyncOutcome): void {
    const entry = map.get(envelopeId);
    if (!entry) return;
    entry.resolve(outcome);
    map.delete(envelopeId);
    pendingWaiters.add(-1);
  }

  return {
    register(envelopeId) {
      if (map.size >= MAX_PENDING_SYNC_WAITERS) {
        return err({ kind: "sync_capacity_exhausted", cap: MAX_PENDING_SYNC_WAITERS });
      }
      assert(!map.has(envelopeId), "ReplyRegistry.register: duplicate envelopeId", {
        envelopeId,
      });

      let resolve!: (outcome: SyncOutcome) => void;
      const promise = new Promise<SyncOutcome>((r) => {
        resolve = r;
      });
      map.set(envelopeId, { resolve, registeredAt: clock.monotonic() });
      pendingWaiters.add(1);
      return ok(promise);
    },

    resolve(envelopeId, outcome) {
      settle(envelopeId, outcome);
    },

    drop(envelopeId) {
      const entry = map.get(envelopeId);
      if (!entry) return;
      const waitedMs = clock.monotonic() - entry.registeredAt;
      settle(envelopeId, { kind: "timeout", waitedMs });
    },

    pending() {
      return map.size;
    },
  };
}
