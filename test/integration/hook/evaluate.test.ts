// Integration tests for evaluateHook. Real Postgres per CLAUDE.md §3.
// Uses integration (not unit) because evaluateHook writes audit rows that require agent FK.
// Skipped when INTEGRATION_DATABASE_URL is unset.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { AssertionError, assert } from "../../../src/core/assert.ts";
import { FakeClock } from "../../../src/core/clock.ts";
import { migrate } from "../../../src/db/migrate-apply.ts";
import { evaluateHook } from "../../../src/hook/evaluate.ts";
import { MAX_DENY_REASON_CHARS } from "../../../src/hook/limits.ts";
import type { HookDecision } from "../../../src/hook/types.ts";
import { AgentId, SessionId, TenantId } from "../../../src/ids.ts";
import type {
  AgentId as AgentIdType,
  SessionId as SessionIdType,
  TenantId as TenantIdType,
} from "../../../src/ids.ts";
import {
  DB_URL,
  HOOK_TIMEOUT_MS,
  MIGRATIONS_DIR,
  describeOrSkip,
  insertAgent,
  insertSession,
  resetDb,
} from "../helpers.ts";

let sqlRef: Sql | undefined;

function requireSql(): Sql {
  assert(sqlRef !== undefined, "integration test: sql initialized by beforeAll");
  return sqlRef;
}

function parseAgent(raw: string): AgentIdType {
  const r = AgentId.parse(raw);
  assert(r.ok, "fixture: invalid AgentId");
  return r.value;
}

function parseTenant(raw: string): TenantIdType {
  const r = TenantId.parse(raw);
  assert(r.ok, "fixture: invalid TenantId");
  return r.value;
}

function parseSession(raw: string): SessionIdType {
  const r = SessionId.parse(raw);
  assert(r.ok, "fixture: invalid SessionId");
  return r.value;
}

type AuditRow = { id: string; decision: string; reason: string | null; latency_ms: number };
type PendingRow = { id: string; content: string; hook_audit_id: string };

async function setup(
  sql: Sql,
): Promise<{ agentId: AgentIdType; tenantId: TenantIdType; sessionId: SessionIdType }> {
  const agentRaw = randomUUID();
  const tenantRaw = randomUUID();
  const sessionRaw = randomUUID();
  await insertAgent(sql, agentRaw, tenantRaw);
  await insertSession(sql, sessionRaw, agentRaw, tenantRaw);
  return {
    agentId: parseAgent(agentRaw),
    tenantId: parseTenant(tenantRaw),
    sessionId: parseSession(sessionRaw),
  };
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
  const s = requireSql();
  await s.unsafe(
    "TRUNCATE TABLE hook_audit, pending_system_messages, turns, sessions, tasks, agents CASCADE",
  );
});

describeOrSkip("evaluateHook (integration)", () => {
  test(
    "approve: writes audit row with decision=approve, reason null, no pending row",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId, tenantId, sessionId } = await setup(sql);

      const decide = (): Promise<HookDecision> => {
        clock.advance(10);
        return Promise.resolve({ decision: "approve" });
      };

      const decision = await evaluateHook(sql, clock, {
        hookId: "system/session-start/stub",
        layer: "system",
        event: "session_start",
        matcherResult: true,
        tenantId,
        agentId,
        sessionId,
        turnId: null,
        toolName: null,
        decide,
      });

      expect(decision.decision).toBe("approve");

      const auditRows = await sql<
        AuditRow[]
      >`SELECT id, decision, reason, latency_ms FROM hook_audit`;
      expect(auditRows.length).toBe(1);
      const auditRow = auditRows[0];
      assert(auditRow !== undefined, "expected audit row");
      expect(auditRow["decision"]).toBe("approve");
      expect(auditRow["reason"]).toBeNull();
      expect(auditRow["latency_ms"]).toBeGreaterThanOrEqual(0);

      const pendingRows = await sql`SELECT id FROM pending_system_messages`;
      expect(pendingRows.length).toBe(0);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "deny with sessionId: writes audit row + pending row with correct content",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId, tenantId, sessionId } = await setup(sql);

      const decision = await evaluateHook(sql, clock, {
        hookId: "system/session-start/stub",
        layer: "system",
        event: "session_start",
        matcherResult: true,
        tenantId,
        agentId,
        sessionId,
        turnId: null,
        toolName: null,
        decide: () => Promise.resolve({ decision: "deny", reason: "rate limit exceeded" }),
      });

      expect(decision.decision).toBe("deny");

      const auditRows = await sql<AuditRow[]>`SELECT id, decision, reason FROM hook_audit`;
      expect(auditRows.length).toBe(1);
      const auditRow = auditRows[0];
      assert(auditRow !== undefined, "expected audit row");
      expect(auditRow["decision"]).toBe("deny");
      expect(auditRow["reason"]).toBe("rate limit exceeded");

      const pendingRows = await sql<
        PendingRow[]
      >`SELECT id, content, hook_audit_id FROM pending_system_messages`;
      expect(pendingRows.length).toBe(1);
      const pendingRow = pendingRows[0];
      assert(pendingRow !== undefined, "expected pending row");
      expect(pendingRow["content"]).toMatch(/^\[relay:hook_deny session_start\]/);
      expect(pendingRow["content"]).toContain("rate limit exceeded");
      expect(pendingRow["hook_audit_id"]).toBe(auditRow["id"]);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "deny with sessionId=null: writes audit row but NO pending row",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const agentRaw = randomUUID();
      const tenantRaw = randomUUID();
      await insertAgent(sql, agentRaw, tenantRaw);
      const agentId = parseAgent(agentRaw);
      const tenantId = parseTenant(tenantRaw);

      const decision = await evaluateHook(sql, clock, {
        hookId: "system/session-start/stub",
        layer: "system",
        event: "session_start",
        matcherResult: true,
        tenantId,
        agentId,
        sessionId: null,
        turnId: null,
        toolName: null,
        decide: () => Promise.resolve({ decision: "deny", reason: "depth exceeded" }),
      });

      expect(decision.decision).toBe("deny");

      const auditRows = await sql`SELECT id FROM hook_audit`;
      expect(auditRows.length).toBe(1);

      const pendingRows = await sql`SELECT id FROM pending_system_messages`;
      expect(pendingRows.length).toBe(0);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "latency_ms is populated from clock monotonic delta",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId, tenantId, sessionId } = await setup(sql);

      await evaluateHook(sql, clock, {
        hookId: "system/session-start/stub",
        layer: "system",
        event: "session_start",
        matcherResult: true,
        tenantId,
        agentId,
        sessionId,
        turnId: null,
        toolName: null,
        decide: () => {
          clock.advance(42);
          return Promise.resolve({ decision: "approve" });
        },
      });

      const rows = await sql<{ latency_ms: number }[]>`SELECT latency_ms FROM hook_audit`;
      const row = rows[0];
      assert(row !== undefined, "expected audit row");
      expect(row["latency_ms"]).toBe(42);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "deny without reason throws AssertionError",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId, tenantId, sessionId } = await setup(sql);

      let caught: unknown;
      try {
        await evaluateHook(sql, clock, {
          hookId: "system/session-start/stub",
          layer: "system",
          event: "session_start",
          matcherResult: true,
          tenantId,
          agentId,
          sessionId,
          turnId: null,
          toolName: null,
          decide: () => Promise.resolve({ decision: "deny", reason: "" }),
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(AssertionError);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "deny with reason over cap throws AssertionError",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId, tenantId, sessionId } = await setup(sql);

      const longReason = "x".repeat(MAX_DENY_REASON_CHARS + 1);
      let caught: unknown;
      try {
        await evaluateHook(sql, clock, {
          hookId: "system/session-start/stub",
          layer: "system",
          event: "session_start",
          matcherResult: true,
          tenantId,
          agentId,
          sessionId,
          turnId: null,
          toolName: null,
          decide: () => Promise.resolve({ decision: "deny", reason: longReason }),
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(AssertionError);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "pre_tool_use deny includes tool name in pending content",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId, tenantId, sessionId } = await setup(sql);

      await evaluateHook(sql, clock, {
        hookId: "system/pre-tool-use/stub",
        layer: "system",
        event: "pre_tool_use",
        matcherResult: true,
        tenantId,
        agentId,
        sessionId,
        turnId: null,
        toolName: "bash",
        decide: () => Promise.resolve({ decision: "deny", reason: "tool blocked" }),
      });

      const pending = await sql<{ content: string }[]>`SELECT content FROM pending_system_messages`;
      const row = pending[0];
      assert(row !== undefined, "expected pending row");
      expect(row["content"]).toContain("pre_tool_use[bash]");
    },
    HOOK_TIMEOUT_MS,
  );
});
