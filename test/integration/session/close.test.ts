// Integration tests for closeSession and isClosed. Real Postgres per CLAUDE.md §3.
// Skipped when INTEGRATION_DATABASE_URL is unset so `bun test` stays green locally.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { assert } from "../../../src/core/assert.ts";
import { FakeClock } from "../../../src/core/clock.ts";
import { migrate } from "../../../src/db/migrate-apply.ts";
import {
  AgentId as AgentIdParser,
  SessionId as SessionIdParser,
  TenantId as TenantIdParser,
} from "../../../src/ids.ts";
import type { AgentId, SessionId, TenantId } from "../../../src/ids.ts";
import {
  closeSession,
  isClosed,
  type HookResult,
  type SessionEndPayload,
} from "../../../src/session/close.ts";
import { DB_URL, HOOK_TIMEOUT_MS, MIGRATIONS_DIR, describeOrSkip, resetDb } from "../helpers.ts";

let sqlRef: Sql | undefined;

function requireSql(): Sql {
  assert(sqlRef !== undefined, "integration test: sql initialized by beforeAll");
  return sqlRef;
}

function makeTenant(): TenantId {
  const r = TenantIdParser.parse(randomUUID());
  assert(r.ok, "fixture: randomUUID produced invalid TenantId");
  return r.value;
}

async function insertAgent(sql: Sql, tenantId: TenantId): Promise<AgentId> {
  const raw = randomUUID();
  await sql`
    INSERT INTO agents (id, tenant_id, system_prompt)
    VALUES (${raw}, ${tenantId}, 'test agent')
  `;
  const r = AgentIdParser.parse(raw);
  assert(r.ok, "fixture: randomUUID produced invalid AgentId");
  return r.value;
}

async function insertSession(sql: Sql, agentId: AgentId, tenantId: TenantId): Promise<SessionId> {
  const raw = randomUUID();
  const chainId = randomUUID();
  await sql`
    INSERT INTO sessions (id, agent_id, tenant_id, originating_trigger, chain_id, depth, created_at, updated_at)
    VALUES (${raw}, ${agentId}, ${tenantId}, '{"kind":"test"}'::jsonb, ${chainId}, 0, now(), now())
  `;
  const r = SessionIdParser.parse(raw);
  assert(r.ok, "fixture: randomUUID produced invalid SessionId");
  return r.value;
}

beforeAll(async () => {
  if (!DB_URL) return;
  const s = postgres(DB_URL, { max: 4, idle_timeout: 2 });
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
  await requireSql()`TRUNCATE TABLE agents CASCADE`;
});

describeOrSkip("closeSession (integration)", () => {
  test(
    'closes an open session — sets closed_at and returns {kind:"closed"}',
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(Date.now());
      const tenantId = makeTenant();
      const agentId = await insertAgent(sql, tenantId);
      const sessionId = await insertSession(sql, agentId, tenantId);

      const result = await closeSession(sql, clock, {
        sessionId,
        agentId,
        tenantId,
        reason: { kind: "end_turn" },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.kind).toBe("closed");

      const rows = await sql<{ closed_at: Date | null }[]>`
        SELECT closed_at FROM sessions WHERE id = ${sessionId}
      `;
      expect(rows[0]?.closed_at).not.toBeNull();
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    'second call on same session returns {kind:"already_closed"} with unchanged closed_at',
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(Date.now());
      const tenantId = makeTenant();
      const agentId = await insertAgent(sql, tenantId);
      const sessionId = await insertSession(sql, agentId, tenantId);

      const first = await closeSession(sql, clock, {
        sessionId,
        agentId,
        tenantId,
        reason: { kind: "end_turn" },
      });
      assert(first.ok && first.value.kind === "closed", "first close must succeed");
      const firstAt = first.value.at;

      clock.advance(5_000);
      const second = await closeSession(sql, clock, {
        sessionId,
        agentId,
        tenantId,
        reason: { kind: "end_turn" },
      });

      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.kind).toBe("already_closed");
      expect(second.value.at.getTime()).toBe(firstAt.getTime());
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    'concurrent close — exactly one returns {kind:"closed"}, other {kind:"already_closed"}',
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(Date.now());
      const tenantId = makeTenant();
      const agentId = await insertAgent(sql, tenantId);
      const sessionId = await insertSession(sql, agentId, tenantId);

      const [r1, r2] = await Promise.all([
        closeSession(sql, clock, { sessionId, agentId, tenantId, reason: { kind: "end_turn" } }),
        closeSession(sql, clock, { sessionId, agentId, tenantId, reason: { kind: "end_turn" } }),
      ]);

      assert(r1.ok && r2.ok, "both results must be ok");
      const kinds = [r1.value.kind, r2.value.kind].sort();
      expect(kinds).toEqual(["already_closed", "closed"]);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "isClosed returns false before close, true after",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(Date.now());
      const tenantId = makeTenant();
      const agentId = await insertAgent(sql, tenantId);
      const sessionId = await insertSession(sql, agentId, tenantId);

      expect(await isClosed(sql, sessionId)).toBe(false);

      const result = await closeSession(sql, clock, {
        sessionId,
        agentId,
        tenantId,
        reason: { kind: "end_turn" },
      });
      assert(result.ok, "close must succeed");

      expect(await isClosed(sql, sessionId)).toBe(true);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "isClosed returns false for non-existent session",
    async () => {
      const sql = requireSql();
      const fakeSessionId = SessionIdParser.parse(randomUUID());
      assert(fakeSessionId.ok, "fixture: randomUUID produced invalid SessionId");
      expect(await isClosed(sql, fakeSessionId.value)).toBe(false);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "tenant mismatch — returns error, closed_at stays NULL",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(Date.now());
      const tenantId = makeTenant();
      const wrongTenantId = makeTenant();
      const agentId = await insertAgent(sql, tenantId);
      const sessionId = await insertSession(sql, agentId, tenantId);

      const result = await closeSession(sql, clock, {
        sessionId,
        agentId,
        tenantId: wrongTenantId,
        reason: { kind: "end_turn" },
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("tenant_mismatch");

      const rows = await sql<{ closed_at: Date | null }[]>`
        SELECT closed_at FROM sessions WHERE id = ${sessionId}
      `;
      expect(rows[0]?.closed_at).toBeNull();
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "hook deny does not unwind close — closed_at is committed",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(Date.now());
      const tenantId = makeTenant();
      const agentId = await insertAgent(sql, tenantId);
      const sessionId = await insertSession(sql, agentId, tenantId);
      const denyHook: (payload: SessionEndPayload) => Promise<HookResult> = () =>
        Promise.resolve({ decision: "deny", reason: "test policy" });

      const result = await closeSession(
        sql,
        clock,
        { sessionId, agentId, tenantId, reason: { kind: "end_turn" } },
        denyHook,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.kind).toBe("closed");

      const rows = await sql<{ closed_at: Date | null }[]>`
        SELECT closed_at FROM sessions WHERE id = ${sessionId}
      `;
      expect(rows[0]?.closed_at).not.toBeNull();
    },
    HOOK_TIMEOUT_MS,
  );
});
