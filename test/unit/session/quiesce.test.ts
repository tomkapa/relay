// Unit tests for quiesceSession — RELAY-146.
// TDD: written before the implementation.

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { assert } from "../../../src/core/assert.ts";
import { FakeClock } from "../../../src/core/clock.ts";
import {
  AgentId,
  ChainId,
  Depth,
  SessionId,
  TenantId,
  type AgentId as AgentIdBrand,
  type ChainId as ChainIdBrand,
  type Depth as DepthBrand,
  type SessionId as SessionIdBrand,
  type TenantId as TenantIdBrand,
} from "../../../src/ids.ts";
import { quiesceSession } from "../../../src/session/quiesce.ts";

type FakeRow = Record<string, unknown>;

// Builds a Sql mock that returns each element of `responses` in sequence.
function makeFakeSql(responses: FakeRow[][]): Sql {
  let idx = 0;
  const tag = (): Promise<FakeRow[]> => {
    const resp = responses[idx];
    idx++;
    return Promise.resolve(resp ?? []);
  };
  return tag as unknown as Sql;
}

function makeIds(): {
  sessionId: SessionIdBrand;
  agentId: AgentIdBrand;
  tenantId: TenantIdBrand;
  chainId: ChainIdBrand;
  depth: DepthBrand;
} {
  const s = SessionId.parse(randomUUID());
  const a = AgentId.parse(randomUUID());
  const t = TenantId.parse(randomUUID());
  const c = ChainId.parse(randomUUID());
  const d = Depth.parse(1);
  assert(s.ok && a.ok && t.ok && c.ok && d.ok, "makeIds: invalid fixture uuid");
  return {
    sessionId: s.value,
    agentId: a.value,
    tenantId: t.value,
    chainId: c.value,
    depth: d.value,
  };
}

describe("quiesceSession", () => {
  test("returns session_already_terminal when closed_at is set", async () => {
    const { sessionId, agentId, tenantId, chainId, depth } = makeIds();
    const closedAt = new Date(1_500_000);
    const clock = new FakeClock(2_000_000);

    const sql = makeFakeSql([
      [
        {
          tenant_id: tenantId,
          closed_at: closedAt,
          parent_session_id: null,
        },
      ],
    ]);

    const result = await quiesceSession(sql, clock, {
      sessionId,
      tenantId,
      agentId,
      chainId,
      depth,
      reason: { kind: "loop_end_no_pending" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("session_already_terminal");
    if (result.error.kind !== "session_already_terminal") return;
    expect(result.error.sessionId).toBe(sessionId);
    expect(result.error.closedAt).toEqual(closedAt);
  });

  test("returns session_not_found when session row absent", async () => {
    const { sessionId, agentId, tenantId, chainId, depth } = makeIds();
    const clock = new FakeClock(2_000_000);

    const sql = makeFakeSql([[]]);

    const result = await quiesceSession(sql, clock, {
      sessionId,
      tenantId,
      agentId,
      chainId,
      depth,
      reason: { kind: "loop_end_no_pending" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("session_not_found");
  });

  test("returns tenant_mismatch when row tenant differs from spec", async () => {
    const { sessionId, agentId, tenantId, chainId, depth } = makeIds();
    const otherTenantResult = TenantId.parse(randomUUID());
    assert(otherTenantResult.ok, "fixture: invalid TenantId");
    const otherTenant = otherTenantResult.value;
    const clock = new FakeClock(2_000_000);

    const sql = makeFakeSql([
      [{ tenant_id: otherTenant, closed_at: null, parent_session_id: null }],
    ]);

    const result = await quiesceSession(sql, clock, {
      sessionId,
      tenantId,
      agentId,
      chainId,
      depth,
      reason: { kind: "loop_end_no_pending" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("tenant_mismatch");
    if (result.error.kind !== "tenant_mismatch") return;
    expect(result.error.expected).toBe(tenantId);
    expect(result.error.got).toBe(otherTenant);
  });

  test("succeeds for open session with no pending ask", async () => {
    const { sessionId, agentId, tenantId, chainId, depth } = makeIds();
    const clock = new FakeClock(2_000_000);

    const sql = makeFakeSql([
      // session lookup
      [{ tenant_id: tenantId, closed_at: null, parent_session_id: null }],
      // readMostRecentUnresolved → no pending
      [],
    ]);

    const result = await quiesceSession(sql, clock, {
      sessionId,
      tenantId,
      agentId,
      chainId,
      depth,
      reason: { kind: "loop_end_no_pending" },
    });

    expect(result.ok).toBe(true);
  });
});
