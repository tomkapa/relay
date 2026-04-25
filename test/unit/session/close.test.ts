// Unit tests for session close. Uses fake Sql and FakeClock; OTel is a no-op in test mode.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { assert, AssertionError } from "../../../src/core/assert.ts";
import { FakeClock } from "../../../src/core/clock.ts";
import { __clearRegistryForTesting, registerHook } from "../../../src/hook/registry.ts";
import { HOOK_EVENT } from "../../../src/hook/types.ts";
import { HookRecordId } from "../../../src/ids.ts";
import {
  AgentId as AgentIdParser,
  SessionId as SessionIdParser,
  TenantId as TenantIdParser,
} from "../../../src/ids.ts";
import type { AgentId, SessionId, TenantId } from "../../../src/ids.ts";
import { closeSession, emitSessionSyncClose, isClosed } from "../../../src/session/close.ts";

type FakeRow = Record<string, unknown>;

function makeFakeSql(responses: FakeRow[][]): Sql {
  let idx = 0;
  const tag = (): Promise<FakeRow[]> => {
    const resp = responses[idx];
    idx++;
    return Promise.resolve(resp ?? []);
  };
  return tag as unknown as Sql;
}

function makeIds(): { sessionId: SessionId; agentId: AgentId; tenantId: TenantId } {
  const s = SessionIdParser.parse(randomUUID());
  const a = AgentIdParser.parse(randomUUID());
  const t = TenantIdParser.parse(randomUUID());
  assert(s.ok && a.ok && t.ok, "makeIds: randomUUID produced invalid ids");
  return { sessionId: s.value, agentId: a.value, tenantId: t.value };
}

function makeHookRecordId(tag: string) {
  const r = HookRecordId.parse(tag);
  assert(r.ok, "fixture: invalid HookRecordId");
  return r.value;
}

let clock: FakeClock;
let ids: ReturnType<typeof makeIds>;

beforeEach(() => {
  clock = new FakeClock(2_000_000);
  ids = makeIds();
  __clearRegistryForTesting();
});

afterEach(() => {
  __clearRegistryForTesting();
});

describe("closeSession", () => {
  test('closes an open session and returns {kind:"closed"}', async () => {
    const { sessionId, agentId, tenantId } = ids;
    const nowMs = clock.now();
    const sql = makeFakeSql([
      [
        {
          tenant_id: tenantId,
          closed_at: null,
          created_at: new Date(1_000_000),
          envelope_id: null,
        },
      ],
      [{ closed_at: new Date(nowMs) }],
    ]);

    const result = await closeSession(sql, clock, {
      sessionId,
      agentId,
      tenantId,
      reason: { kind: "end_turn" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("closed");
    expect(result.value.at).toEqual(new Date(nowMs));
  });

  test('returns {kind:"already_closed"} on second call — idempotent', async () => {
    const { sessionId, agentId, tenantId } = ids;
    const alreadyAt = new Date(1_500_000);
    const sql = makeFakeSql([
      [{ tenant_id: tenantId, closed_at: alreadyAt, created_at: new Date(1_000_000) }],
      [],
    ]);

    const result = await closeSession(sql, clock, {
      sessionId,
      agentId,
      tenantId,
      reason: { kind: "end_turn" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("already_closed");
    expect(result.value.at).toEqual(alreadyAt);
  });

  test("returns session_not_found for missing session", async () => {
    const { sessionId, agentId, tenantId } = ids;
    const sql = makeFakeSql([[]]);

    const result = await closeSession(sql, clock, {
      sessionId,
      agentId,
      tenantId,
      reason: { kind: "end_turn" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("session_not_found");
    if (result.error.kind !== "session_not_found") return;
    expect(result.error.sessionId).toBe(sessionId);
  });

  test("returns tenant_mismatch when row tenant differs from spec", async () => {
    const { sessionId, agentId, tenantId } = ids;
    const otherTenant = TenantIdParser.parse(randomUUID());
    assert(otherTenant.ok, "fixture: randomUUID produced invalid TenantId");

    const sql = makeFakeSql([
      [{ tenant_id: otherTenant.value, closed_at: null, created_at: new Date(1_000_000) }],
    ]);

    const result = await closeSession(sql, clock, {
      sessionId,
      agentId,
      tenantId,
      reason: { kind: "end_turn" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("tenant_mismatch");
    if (result.error.kind !== "tenant_mismatch") return;
    expect(result.error.expected).toBe(tenantId);
    expect(result.error.got).toBe(otherTenant.value);
  });

  test('hook deny does not unwind close — outcome is still {kind:"closed"}', async () => {
    const { sessionId, agentId, tenantId } = ids;
    const nowMs = clock.now();
    // Fake SQL: lookup, update, agents check (in insertHookAudit), audit row INSERT, pending INSERT
    const sql = makeFakeSql([
      [
        {
          tenant_id: tenantId,
          closed_at: null,
          created_at: new Date(1_000_000),
          envelope_id: null,
        },
      ],
      [{ closed_at: new Date(nowMs) }],
      [{ tenant_id: tenantId }], // insertHookAudit: SELECT agents
      [
        {
          // insertHookAudit: INSERT RETURNING
          id: "00000000-0000-4000-8000-000000000001",
          hook_id: "system/session_end/test-deny",
          layer: "system",
          event: "session_end",
          matcher_result: true,
          decision: "deny",
          reason: "policy violation",
          latency_ms: 0,
          tenant_id: String(tenantId),
          session_id: String(sessionId),
          agent_id: String(agentId),
          turn_id: null,
          tool_name: null,
          created_at: new Date(nowMs),
        },
      ],
      [], // enqueuePendingSystemMessage: INSERT (no RETURNING)
    ]);

    registerHook({
      id: makeHookRecordId("system/session_end/test-deny"),
      layer: "system",
      event: HOOK_EVENT.SessionEnd,
      matcher: () => true,
      decision: () => Promise.resolve({ decision: "deny", reason: "policy violation" }),
    });

    const result = await closeSession(sql, clock, {
      sessionId,
      agentId,
      tenantId,
      reason: { kind: "end_turn" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("closed");
  });

  test("hook is not called on already_closed path", async () => {
    const { sessionId, agentId, tenantId } = ids;
    let matcherCalled = false;
    const sql = makeFakeSql([
      [{ tenant_id: tenantId, closed_at: new Date(1_500_000), created_at: new Date(1_000_000) }],
      [],
    ]);

    // Register a tracking hook — should NOT be called since the session is already_closed.
    registerHook({
      id: makeHookRecordId("system/session_end/track"),
      layer: "system",
      event: HOOK_EVENT.SessionEnd,
      matcher: () => {
        matcherCalled = true;
        return true;
      },
      decision: () => Promise.resolve({ decision: "approve" }),
    });

    await closeSession(sql, clock, {
      sessionId,
      agentId,
      tenantId,
      reason: { kind: "end_turn" },
    });

    expect(matcherCalled).toBe(false);
  });

  test("turn_cap_exceeded reason closes the session", async () => {
    const { sessionId, agentId, tenantId } = ids;
    const nowMs = clock.now();
    const sql = makeFakeSql([
      [
        {
          tenant_id: tenantId,
          closed_at: null,
          created_at: new Date(1_000_000),
          envelope_id: null,
        },
      ],
      [{ closed_at: new Date(nowMs) }],
    ]);

    const result = await closeSession(sql, clock, {
      sessionId,
      agentId,
      tenantId,
      reason: { kind: "turn_cap_exceeded", max: 500 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("closed");
  });

  test("throws AssertionError for empty sessionId", () => {
    const { agentId, tenantId } = ids;
    const emptySessionId = "" as SessionId;
    const sql = makeFakeSql([]);

    expect(() =>
      closeSession(sql, clock, {
        sessionId: emptySessionId,
        agentId,
        tenantId,
        reason: { kind: "end_turn" },
      }),
    ).toThrow(AssertionError);
  });
});

describe("emitSessionSyncClose", () => {
  test("no-op when envelopeId is null", async () => {
    const { sessionId } = ids;
    let notifyCalled = false;
    const sql = makeFakeSql([]);
    (sql as unknown as Record<string, unknown>)["notify"] = () => {
      notifyCalled = true;
      return Promise.resolve();
    };
    await emitSessionSyncClose(sql, { sessionId, reason: "end_turn", envelopeId: null });
    expect(notifyCalled).toBe(false);
  });

  test("closeSession outcome is still 'closed' even when notify fails", async () => {
    const { sessionId, agentId, tenantId } = ids;
    const nowMs = clock.now();
    // closeSession now fetches envelopeId in the same lookup query.
    const sql = makeFakeSql([
      [
        {
          tenant_id: tenantId,
          closed_at: null,
          created_at: new Date(1_000_000),
          envelope_id: "00000000-0000-4000-8000-000000000001",
        },
      ],
      [{ closed_at: new Date(nowMs) }],
    ]);
    // sql.notify throws to simulate failure — close must still succeed.
    (sql as unknown as Record<string, unknown>)["notify"] = () => {
      throw new Error("notify connection error");
    };

    const result = await closeSession(sql, clock, {
      sessionId,
      agentId,
      tenantId,
      reason: { kind: "end_turn" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("closed");
  });
});

describe("isClosed", () => {
  test("returns false for non-existent session", async () => {
    const { sessionId } = ids;
    const sql = makeFakeSql([[]]);
    expect(await isClosed(sql, sessionId)).toBe(false);
  });

  test("returns false for open session (closed_at is null)", async () => {
    const { sessionId } = ids;
    const sql = makeFakeSql([[{ closed_at: null }]]);
    expect(await isClosed(sql, sessionId)).toBe(false);
  });

  test("returns true for closed session", async () => {
    const { sessionId } = ids;
    const sql = makeFakeSql([[{ closed_at: new Date(1_000_000) }]]);
    expect(await isClosed(sql, sessionId)).toBe(true);
  });
});
