// Unit tests for startSyncListener. Uses a fake sql.listen that replays payloads.

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { assert } from "../../../src/core/assert.ts";
import { FakeClock } from "../../../src/core/clock.ts";
import { EnvelopeId, SessionId } from "../../../src/ids.ts";
import { makeReplyRegistry } from "../../../src/http/reply-registry.ts";
import { startSyncListener, SYNC_CHANNEL } from "../../../src/http/sync-listener.ts";
import { _setMeterForTest } from "../../../src/telemetry/otel.ts";

_setMeterForTest(undefined);

type ListenCallback = (payload: string) => void;

function makeFakeSql(onListen?: (channel: string, cb: ListenCallback) => void): {
  sql: Sql;
  fireNotify: (payload: string) => void;
  unlistenCalled: () => boolean;
} {
  let captured: ListenCallback | null = null;
  let _unlistenCalled = false;

  const sql = {
    listen: (channel: string, cb: ListenCallback) => {
      captured = cb;
      onListen?.(channel, cb);
      return Promise.resolve({
        unlisten: () => {
          _unlistenCalled = true;
          return Promise.resolve();
        },
      });
    },
  } as unknown as Sql;

  return {
    sql,
    fireNotify: (payload: string) => {
      assert(captured !== null, "fireNotify: no listen callback registered");
      captured(payload);
    },
    unlistenCalled: () => _unlistenCalled,
  };
}

function validPayload(
  envelopeId = randomUUID(),
  sessionId = randomUUID(),
  reason: "end_turn" | "turn_cap_exceeded" = "end_turn",
): string {
  return JSON.stringify({ envelopeId, sessionId, reason });
}

describe("startSyncListener", () => {
  test("listens on session_sync_close channel", async () => {
    let listenedChannel = "";
    const { sql } = makeFakeSql((channel) => {
      listenedChannel = channel;
    });
    const registry = makeReplyRegistry(new FakeClock());
    await startSyncListener(sql, registry);
    expect(listenedChannel).toBe(SYNC_CHANNEL);
  });

  test("valid payload calls registry.resolve with correct outcome", async () => {
    const { sql, fireNotify } = makeFakeSql();
    const registry = makeReplyRegistry(new FakeClock());
    await startSyncListener(sql, registry);

    const envId = randomUUID();
    const sessId = randomUUID();
    const envResult = EnvelopeId.parse(envId);
    const sessResult = SessionId.parse(sessId);
    assert(envResult.ok && sessResult.ok, "fixture: invalid IDs");

    const deferred = registry.register(envResult.value);
    expect(deferred.ok).toBe(true);
    if (!deferred.ok) return;

    fireNotify(validPayload(envId, sessId, "end_turn"));

    const outcome = await deferred.value;
    expect(outcome.kind).toBe("closed");
    if (outcome.kind !== "closed") return;
    expect(outcome.sessionId).toBe(sessResult.value);
    expect(outcome.reason).toBe("end_turn");
  });

  test("turn_cap_exceeded reason is correctly propagated", async () => {
    const { sql, fireNotify } = makeFakeSql();
    const registry = makeReplyRegistry(new FakeClock());
    await startSyncListener(sql, registry);

    const envId = randomUUID();
    const sessId = randomUUID();
    const envResult = EnvelopeId.parse(envId);
    assert(envResult.ok, "fixture: invalid EnvelopeId");

    const deferred = registry.register(envResult.value);
    expect(deferred.ok).toBe(true);
    if (!deferred.ok) return;

    fireNotify(validPayload(envId, sessId, "turn_cap_exceeded"));
    const outcome = await deferred.value;
    expect(outcome.kind).toBe("closed");
    if (outcome.kind !== "closed") return;
    expect(outcome.reason).toBe("turn_cap_exceeded");
  });

  test("malformed JSON payload — registry is untouched", async () => {
    const { sql, fireNotify } = makeFakeSql();
    const registry = makeReplyRegistry(new FakeClock());
    await startSyncListener(sql, registry);

    fireNotify("not-valid-json{{{");
    expect(registry.pending()).toBe(0);
  });

  test("invalid payload schema — registry is untouched", async () => {
    const { sql, fireNotify } = makeFakeSql();
    const registry = makeReplyRegistry(new FakeClock());
    await startSyncListener(sql, registry);

    fireNotify(JSON.stringify({ envelopeId: "not-a-uuid", sessionId: randomUUID() }));
    expect(registry.pending()).toBe(0);
  });

  test("stop() calls unlisten", async () => {
    const { sql, unlistenCalled } = makeFakeSql();
    const registry = makeReplyRegistry(new FakeClock());
    const listener = await startSyncListener(sql, registry);

    expect(unlistenCalled()).toBe(false);
    await listener.stop();
    expect(unlistenCalled()).toBe(true);
  });
});
