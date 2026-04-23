// Unit tests for ReplyRegistry. No external deps — purely in-memory state machine.

import { beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { assert, AssertionError } from "../../../src/core/assert.ts";
import { FakeClock } from "../../../src/core/clock.ts";
import { EnvelopeId, SessionId } from "../../../src/ids.ts";
import { makeReplyRegistry, type SyncOutcome } from "../../../src/http/reply-registry.ts";
import { MAX_PENDING_SYNC_WAITERS } from "../../../src/http/limits.ts";
import { _setMeterForTest } from "../../../src/telemetry/otel.ts";

function makeEnvelopeId() {
  const r = EnvelopeId.parse(randomUUID());
  assert(r.ok, "fixture: randomUUID produced invalid EnvelopeId");
  return r.value;
}

function makeSessionId() {
  const r = SessionId.parse(randomUUID());
  assert(r.ok, "fixture: randomUUID produced invalid SessionId");
  return r.value;
}

const closedOutcome: SyncOutcome = {
  kind: "closed",
  sessionId: makeSessionId(),
  reason: "end_turn",
};

beforeEach(() => {
  // Use a no-op meter so upDownCounter calls don't fail in unit tests.
  _setMeterForTest(undefined);
});

describe("ReplyRegistry", () => {
  test("register then resolve — promise resolves with outcome", async () => {
    const registry = makeReplyRegistry(new FakeClock());
    const id = makeEnvelopeId();
    const result = registry.register(id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const promise = result.value;

    registry.resolve(id, closedOutcome);
    const outcome = await promise;
    expect(outcome).toEqual(closedOutcome);
  });

  test("register then drop — promise resolves with timeout outcome", async () => {
    const registry = makeReplyRegistry(new FakeClock());
    const id = makeEnvelopeId();
    const result = registry.register(id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const promise = result.value;

    registry.drop(id);
    const outcome = await promise;
    expect(outcome.kind).toBe("timeout");
    if (outcome.kind !== "timeout") return;
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(0);
  });

  test("duplicate register throws AssertionError", () => {
    const registry = makeReplyRegistry(new FakeClock());
    const id = makeEnvelopeId();
    const result = registry.register(id);
    expect(result.ok).toBe(true);

    expect(() => registry.register(id)).toThrow(AssertionError);
  });

  test("register at MAX_PENDING_SYNC_WAITERS returns capacity_exhausted", () => {
    const registry = makeReplyRegistry(new FakeClock());
    // Fill to capacity (using unique IDs).
    for (let i = 0; i < MAX_PENDING_SYNC_WAITERS; i++) {
      const r = registry.register(makeEnvelopeId());
      expect(r.ok).toBe(true);
    }
    const overflow = registry.register(makeEnvelopeId());
    expect(overflow.ok).toBe(false);
    if (overflow.ok) return;
    expect(overflow.error.kind).toBe("sync_capacity_exhausted");
    expect(overflow.error.cap).toBe(MAX_PENDING_SYNC_WAITERS);
  });

  test("resolve unknown envelopeId is a no-op", () => {
    const registry = makeReplyRegistry(new FakeClock());
    const id = makeEnvelopeId();
    expect(() => {
      registry.resolve(id, closedOutcome);
    }).not.toThrow();
    expect(registry.pending()).toBe(0);
  });

  test("drop unknown envelopeId is a no-op", () => {
    const registry = makeReplyRegistry(new FakeClock());
    const id = makeEnvelopeId();
    expect(() => {
      registry.drop(id);
    }).not.toThrow();
    expect(registry.pending()).toBe(0);
  });

  test("pending() reflects register / resolve / drop arithmetic", () => {
    const registry = makeReplyRegistry(new FakeClock());
    expect(registry.pending()).toBe(0);

    const a = makeEnvelopeId();
    const b = makeEnvelopeId();
    const c = makeEnvelopeId();

    registry.register(a);
    registry.register(b);
    registry.register(c);
    expect(registry.pending()).toBe(3);

    registry.resolve(a, closedOutcome);
    expect(registry.pending()).toBe(2);

    registry.drop(b);
    expect(registry.pending()).toBe(1);

    registry.resolve(c, closedOutcome);
    expect(registry.pending()).toBe(0);
  });

  test("second resolve on same id after first resolve is a no-op", async () => {
    const registry = makeReplyRegistry(new FakeClock());
    const id = makeEnvelopeId();
    const result = registry.register(id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const promise = result.value;

    registry.resolve(id, closedOutcome);
    expect(registry.pending()).toBe(0);

    const outcome = await promise;
    expect(outcome).toEqual(closedOutcome);

    // Second resolve is a no-op; pending stays at 0.
    registry.resolve(id, { kind: "closed", sessionId: makeSessionId(), reason: "end_turn" });
    expect(registry.pending()).toBe(0);
  });
});
