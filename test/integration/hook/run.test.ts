// Integration tests for runHooks. Real Postgres per CLAUDE.md §3.
// Skipped when INTEGRATION_DATABASE_URL is unset.

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { assert } from "../../../src/core/assert.ts";
import { FakeClock } from "../../../src/core/clock.ts";
import { migrate } from "../../../src/db/migrate-apply.ts";
import { __clearRegistryForTesting, registerHook } from "../../../src/hook/registry.ts";
import { runHooks } from "../../../src/hook/run.ts";
import { HOOK_EVENT } from "../../../src/hook/types.ts";
import { AgentId, HookRecordId, SessionId, TenantId } from "../../../src/ids.ts";
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

function hookId(tag: string) {
  const r = HookRecordId.parse(tag);
  assert(r.ok, `fixture: invalid HookRecordId: ${tag}`);
  return r.value;
}

async function setup(sql: Sql): Promise<{
  agentId: AgentIdType;
  tenantId: TenantIdType;
  sessionId: SessionIdType;
}> {
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

type AuditRow = {
  id: string;
  decision: string;
  reason: string | null;
  hook_id: string;
  layer: string;
  matcher_result: boolean;
};
type PendingRow = { id: string; content: string; hook_audit_id: string };

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
  __clearRegistryForTesting();
});

afterEach(() => {
  __clearRegistryForTesting();
});

describeOrSkip("runHooks (integration)", () => {
  test(
    "empty registry: returns approve, 0 audit rows",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId, tenantId, sessionId } = await setup(sql);

      const aggregate = await runHooks(
        sql,
        clock,
        {
          tenantId,
          agentId,
          sessionId,
          turnId: null,
          toolName: null,
          event: HOOK_EVENT.SessionStart,
        },
        {},
      );

      expect(aggregate.decision).toBe("approve");
      const rows = await sql`SELECT id FROM hook_audit`;
      expect(rows.length).toBe(0);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "single rule, matcher false: returns approve, 0 audit rows",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId, tenantId, sessionId } = await setup(sql);

      registerHook({
        id: hookId("system/session_start/always-reject"),
        layer: "system",
        event: HOOK_EVENT.SessionStart,
        matcher: () => false,
        decision: () => Promise.resolve({ decision: "approve" }),
      });

      const aggregate = await runHooks(
        sql,
        clock,
        {
          tenantId,
          agentId,
          sessionId,
          turnId: null,
          toolName: null,
          event: HOOK_EVENT.SessionStart,
        },
        {},
      );

      expect(aggregate.decision).toBe("approve");
      const rows = await sql`SELECT id FROM hook_audit`;
      expect(rows.length).toBe(0);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "single rule, matcher true, decision approve: 1 audit row decision=approve",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId, tenantId, sessionId } = await setup(sql);

      registerHook({
        id: hookId("system/session_start/always-approve"),
        layer: "system",
        event: HOOK_EVENT.SessionStart,
        matcher: () => true,
        decision: () => Promise.resolve({ decision: "approve" }),
      });

      const aggregate = await runHooks(
        sql,
        clock,
        {
          tenantId,
          agentId,
          sessionId,
          turnId: null,
          toolName: null,
          event: HOOK_EVENT.SessionStart,
        },
        {},
      );

      expect(aggregate.decision).toBe("approve");
      const rows = await sql<AuditRow[]>`SELECT id, decision, reason FROM hook_audit`;
      expect(rows.length).toBe(1);
      expect(rows[0]?.decision).toBe("approve");
      expect(rows[0]?.reason).toBeNull();
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "single rule, matcher true, decision deny: 1 audit row + 1 pending row, returns deny",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId, tenantId, sessionId } = await setup(sql);

      registerHook({
        id: hookId("system/session_start/deny-all"),
        layer: "system",
        event: HOOK_EVENT.SessionStart,
        matcher: () => true,
        decision: () => Promise.resolve({ decision: "deny", reason: "blocked by rule" }),
      });

      const aggregate = await runHooks(
        sql,
        clock,
        {
          tenantId,
          agentId,
          sessionId,
          turnId: null,
          toolName: null,
          event: HOOK_EVENT.SessionStart,
        },
        {},
      );

      expect(aggregate.decision).toBe("deny");
      if (aggregate.decision === "deny") expect(aggregate.reason).toBe("blocked by rule");

      const auditRows = await sql<AuditRow[]>`SELECT id, decision, reason FROM hook_audit`;
      expect(auditRows.length).toBe(1);
      expect(auditRows[0]?.decision).toBe("deny");
      expect(auditRows[0]?.reason).toBe("blocked by rule");

      const pendingRows = await sql<PendingRow[]>`SELECT id FROM pending_system_messages`;
      expect(pendingRows.length).toBe(1);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "single rule, matcher true, decision modify: 1 audit row decision=modify, returns modify",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId, tenantId, sessionId } = await setup(sql);

      registerHook<{ value: number }>({
        id: hookId("system/pre_tool_use/modify-payload"),
        layer: "system",
        event: HOOK_EVENT.PreToolUse,
        matcher: () => true,
        decision: (p) => Promise.resolve({ decision: "modify", payload: { value: p.value + 1 } }),
      });

      const aggregate = await runHooks<{ value: number }>(
        sql,
        clock,
        {
          tenantId,
          agentId,
          sessionId,
          turnId: null,
          toolName: "test_tool",
          event: HOOK_EVENT.PreToolUse,
        },
        { value: 41 },
      );

      expect(aggregate.decision).toBe("modify");
      if (aggregate.decision === "modify") expect(aggregate.payload).toEqual({ value: 42 });

      const auditRows = await sql<AuditRow[]>`SELECT id, decision FROM hook_audit`;
      expect(auditRows.length).toBe(1);
      expect(auditRows[0]?.decision).toBe("modify");

      const pendingRows = await sql`SELECT id FROM pending_system_messages`;
      expect(pendingRows.length).toBe(0);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "two rules, both approve: 2 audit rows, returns approve",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId, tenantId, sessionId } = await setup(sql);

      registerHook({
        id: hookId("system/session_start/approve-1"),
        layer: "system",
        event: HOOK_EVENT.SessionStart,
        matcher: () => true,
        decision: () => Promise.resolve({ decision: "approve" }),
      });
      registerHook({
        id: hookId("system/session_start/approve-2"),
        layer: "system",
        event: HOOK_EVENT.SessionStart,
        matcher: () => true,
        decision: () => Promise.resolve({ decision: "approve" }),
      });

      const aggregate = await runHooks(
        sql,
        clock,
        {
          tenantId,
          agentId,
          sessionId,
          turnId: null,
          toolName: null,
          event: HOOK_EVENT.SessionStart,
        },
        {},
      );

      expect(aggregate.decision).toBe("approve");
      const rows = await sql`SELECT id FROM hook_audit`;
      expect(rows.length).toBe(2);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "two rules, first denies: 1 audit row, second never runs, returns deny",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId, tenantId, sessionId } = await setup(sql);

      let secondRan = false;
      registerHook({
        id: hookId("system/session_start/deny-first"),
        layer: "system",
        event: HOOK_EVENT.SessionStart,
        matcher: () => true,
        decision: () => Promise.resolve({ decision: "deny", reason: "first deny" }),
      });
      registerHook({
        id: hookId("system/session_start/should-not-run"),
        layer: "system",
        event: HOOK_EVENT.SessionStart,
        matcher: () => {
          secondRan = true;
          return true;
        },
        decision: () => Promise.resolve({ decision: "approve" }),
      });

      const aggregate = await runHooks(
        sql,
        clock,
        {
          tenantId,
          agentId,
          sessionId,
          turnId: null,
          toolName: null,
          event: HOOK_EVENT.SessionStart,
        },
        {},
      );

      expect(aggregate.decision).toBe("deny");
      expect(secondRan).toBe(false);
      const rows = await sql`SELECT id FROM hook_audit`;
      expect(rows.length).toBe(1);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "three rules: modify → modify → deny: 3 audit rows, modify chains, aggregate is deny",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId, tenantId, sessionId } = await setup(sql);

      registerHook<{ v: number }>({
        id: hookId("system/pre_tool_use/modify-a"),
        layer: "system",
        event: HOOK_EVENT.PreToolUse,
        matcher: () => true,
        decision: (p) => Promise.resolve({ decision: "modify", payload: { v: p.v + 10 } }),
      });
      registerHook<{ v: number }>({
        id: hookId("system/pre_tool_use/modify-b"),
        layer: "system",
        event: HOOK_EVENT.PreToolUse,
        matcher: () => true,
        decision: (p) => Promise.resolve({ decision: "modify", payload: { v: p.v + 100 } }),
      });
      registerHook<{ v: number }>({
        id: hookId("system/pre_tool_use/deny-c"),
        layer: "system",
        event: HOOK_EVENT.PreToolUse,
        matcher: () => true,
        decision: () => Promise.resolve({ decision: "deny", reason: "final deny" }),
      });

      const aggregate = await runHooks<{ v: number }>(
        sql,
        clock,
        {
          tenantId,
          agentId,
          sessionId,
          turnId: null,
          toolName: "test_tool",
          event: HOOK_EVENT.PreToolUse,
        },
        { v: 1 },
      );

      expect(aggregate.decision).toBe("deny");
      if (aggregate.decision === "deny") expect(aggregate.reason).toBe("final deny");

      const rows = await sql`SELECT id FROM hook_audit`;
      expect(rows.length).toBe(3);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "three rules: modify → approve → modify: 3 audit rows, final payload is last modify",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId, tenantId, sessionId } = await setup(sql);

      registerHook<{ v: number }>({
        id: hookId("system/pre_tool_use/modify-1"),
        layer: "system",
        event: HOOK_EVENT.PreToolUse,
        matcher: () => true,
        decision: (p) => Promise.resolve({ decision: "modify", payload: { v: p.v + 1 } }),
      });
      registerHook<{ v: number }>({
        id: hookId("system/pre_tool_use/approve-mid"),
        layer: "system",
        event: HOOK_EVENT.PreToolUse,
        matcher: () => true,
        decision: () => Promise.resolve({ decision: "approve" }),
      });
      registerHook<{ v: number }>({
        id: hookId("system/pre_tool_use/modify-2"),
        layer: "system",
        event: HOOK_EVENT.PreToolUse,
        matcher: () => true,
        decision: (p) => Promise.resolve({ decision: "modify", payload: { v: p.v * 10 } }),
      });

      const aggregate = await runHooks<{ v: number }>(
        sql,
        clock,
        {
          tenantId,
          agentId,
          sessionId,
          turnId: null,
          toolName: "test_tool",
          event: HOOK_EVENT.PreToolUse,
        },
        { v: 5 },
      );

      // Rule 1: v=5 → modify → v=6. Rule 2: approve (no change). Rule 3: v=6 → modify → v=60.
      expect(aggregate.decision).toBe("modify");
      if (aggregate.decision === "modify") expect(aggregate.payload).toEqual({ v: 60 });

      const rows = await sql`SELECT id FROM hook_audit`;
      expect(rows.length).toBe(3);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "two rules, second matcher false: 1 audit row from first, no row for second",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId, tenantId, sessionId } = await setup(sql);

      registerHook({
        id: hookId("system/session_start/approve-matched"),
        layer: "system",
        event: HOOK_EVENT.SessionStart,
        matcher: () => true,
        decision: () => Promise.resolve({ decision: "approve" }),
      });
      registerHook({
        id: hookId("system/session_start/reject-unmatched"),
        layer: "system",
        event: HOOK_EVENT.SessionStart,
        matcher: () => false,
        decision: () => Promise.resolve({ decision: "deny", reason: "should not run" }),
      });

      const aggregate = await runHooks(
        sql,
        clock,
        {
          tenantId,
          agentId,
          sessionId,
          turnId: null,
          toolName: null,
          event: HOOK_EVENT.SessionStart,
        },
        {},
      );

      expect(aggregate.decision).toBe("approve");
      const rows = await sql`SELECT id FROM hook_audit`;
      expect(rows.length).toBe(1);
    },
    HOOK_TIMEOUT_MS,
  );

  // ---- Cross-layer composition tests (RELAY-139) --------------------------------

  test(
    "cross-layer deny: system denies → org and agent rules never run",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId, tenantId, sessionId } = await setup(sql);

      let orgRan = false;
      let agentRan = false;

      registerHook({
        id: hookId("system/session_start/sys-deny"),
        layer: "system",
        event: HOOK_EVENT.SessionStart,
        matcher: () => true,
        decision: () => Promise.resolve({ decision: "deny", reason: "system blocks" }),
      });
      registerHook<unknown>({
        id: hookId("system/session_start/org-should-not-run"),
        layer: "organization",
        event: HOOK_EVENT.SessionStart,
        matcher: () => {
          orgRan = true;
          return true;
        },
        decision: () => Promise.resolve({ decision: "approve" }),
      });
      registerHook<unknown>({
        id: hookId("system/session_start/agent-should-not-run"),
        layer: "agent",
        event: HOOK_EVENT.SessionStart,
        matcher: () => {
          agentRan = true;
          return true;
        },
        decision: () => Promise.resolve({ decision: "approve" }),
      });

      const aggregate = await runHooks(
        sql,
        clock,
        {
          tenantId,
          agentId,
          sessionId,
          turnId: null,
          toolName: null,
          event: HOOK_EVENT.SessionStart,
        },
        {},
      );

      expect(aggregate.decision).toBe("deny");
      if (aggregate.decision === "deny") expect(aggregate.reason).toBe("system blocks");
      expect(orgRan).toBe(false);
      expect(agentRan).toBe(false);

      // Only 1 audit row — system deny row; org/agent produce nothing
      const auditRows = await sql<AuditRow[]>`SELECT id, layer, decision FROM hook_audit`;
      expect(auditRows.length).toBe(1);
      expect(auditRows[0]?.layer).toBe("system");
      expect(auditRows[0]?.decision).toBe("deny");
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "cross-layer modify chain: system modify → org modify → agent approve, payload threads",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId, tenantId, sessionId } = await setup(sql);

      // System: v += 10
      registerHook<{ v: number }>({
        id: hookId("system/pre_tool_use/sys-modify"),
        layer: "system",
        event: HOOK_EVENT.PreToolUse,
        matcher: () => true,
        decision: (p) => Promise.resolve({ decision: "modify", payload: { v: p.v + 10 } }),
      });
      // Org: v *= 2 (sees system's modified payload v=11)
      registerHook<{ v: number }>({
        id: hookId("system/pre_tool_use/org-modify"),
        layer: "organization",
        event: HOOK_EVENT.PreToolUse,
        matcher: () => true,
        decision: (p) => Promise.resolve({ decision: "modify", payload: { v: p.v * 2 } }),
      });
      // Agent: approve (no payload change)
      registerHook<{ v: number }>({
        id: hookId("system/pre_tool_use/agent-approve"),
        layer: "agent",
        event: HOOK_EVENT.PreToolUse,
        matcher: () => true,
        decision: () => Promise.resolve({ decision: "approve" }),
      });

      const aggregate = await runHooks<{ v: number }>(
        sql,
        clock,
        { tenantId, agentId, sessionId, turnId: null, toolName: "t", event: HOOK_EVENT.PreToolUse },
        { v: 1 },
      );

      // v=1 → system: v=11 → org: v=22 → agent: approve (no change)
      expect(aggregate.decision).toBe("modify");
      if (aggregate.decision === "modify") expect(aggregate.payload).toEqual({ v: 22 });

      const auditRows = await sql<
        AuditRow[]
      >`SELECT layer, decision FROM hook_audit ORDER BY created_at`;
      expect(auditRows.length).toBe(3);
      expect(auditRows[0]?.layer).toBe("system");
      expect(auditRows[0]?.decision).toBe("modify");
      expect(auditRows[1]?.layer).toBe("organization");
      expect(auditRows[1]?.decision).toBe("modify");
      expect(auditRows[2]?.layer).toBe("agent");
      expect(auditRows[2]?.decision).toBe("approve");
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "cross-layer: system approve → org deny → agent never runs",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId, tenantId, sessionId } = await setup(sql);

      let agentRan = false;

      registerHook({
        id: hookId("system/session_start/sys-approve"),
        layer: "system",
        event: HOOK_EVENT.SessionStart,
        matcher: () => true,
        decision: () => Promise.resolve({ decision: "approve" }),
      });
      registerHook<unknown>({
        id: hookId("system/session_start/org-deny"),
        layer: "organization",
        event: HOOK_EVENT.SessionStart,
        matcher: () => true,
        decision: () => Promise.resolve({ decision: "deny", reason: "org policy" }),
      });
      registerHook<unknown>({
        id: hookId("system/session_start/agent-should-not-run"),
        layer: "agent",
        event: HOOK_EVENT.SessionStart,
        matcher: () => {
          agentRan = true;
          return true;
        },
        decision: () => Promise.resolve({ decision: "approve" }),
      });

      const aggregate = await runHooks(
        sql,
        clock,
        {
          tenantId,
          agentId,
          sessionId,
          turnId: null,
          toolName: null,
          event: HOOK_EVENT.SessionStart,
        },
        {},
      );

      expect(aggregate.decision).toBe("deny");
      if (aggregate.decision === "deny") expect(aggregate.reason).toBe("org policy");
      expect(agentRan).toBe(false);

      // 2 audit rows: system approve + org deny
      const auditRows = await sql<
        AuditRow[]
      >`SELECT layer, decision FROM hook_audit ORDER BY created_at`;
      expect(auditRows.length).toBe(2);
      expect(auditRows[0]?.layer).toBe("system");
      expect(auditRows[0]?.decision).toBe("approve");
      expect(auditRows[1]?.layer).toBe("organization");
      expect(auditRows[1]?.decision).toBe("deny");

      // Pending message written for org-layer deny
      const pendingRows = await sql<PendingRow[]>`SELECT id FROM pending_system_messages`;
      expect(pendingRows.length).toBe(1);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "cross-layer: empty system + non-empty org: org rules run, system denial impossible",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId, tenantId, sessionId } = await setup(sql);

      // System bucket is empty — only org rule
      registerHook<unknown>({
        id: hookId("system/session_start/org-approve"),
        layer: "organization",
        event: HOOK_EVENT.SessionStart,
        matcher: () => true,
        decision: () => Promise.resolve({ decision: "approve" }),
      });

      const aggregate = await runHooks(
        sql,
        clock,
        {
          tenantId,
          agentId,
          sessionId,
          turnId: null,
          toolName: null,
          event: HOOK_EVENT.SessionStart,
        },
        {},
      );

      expect(aggregate.decision).toBe("approve");
      const auditRows = await sql<AuditRow[]>`SELECT layer, decision FROM hook_audit`;
      expect(auditRows.length).toBe(1);
      expect(auditRows[0]?.layer).toBe("organization");
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "cross-layer modify: agent modify is final aggregate even when system also modified",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId, tenantId, sessionId } = await setup(sql);

      registerHook<{ v: number }>({
        id: hookId("system/pre_tool_use/sys-mod"),
        layer: "system",
        event: HOOK_EVENT.PreToolUse,
        matcher: () => true,
        decision: (p) => Promise.resolve({ decision: "modify", payload: { v: p.v + 5 } }),
      });
      registerHook<{ v: number }>({
        id: hookId("system/pre_tool_use/agent-mod"),
        layer: "agent",
        event: HOOK_EVENT.PreToolUse,
        matcher: () => true,
        decision: (p) => Promise.resolve({ decision: "modify", payload: { v: p.v + 100 } }),
      });

      const aggregate = await runHooks<{ v: number }>(
        sql,
        clock,
        { tenantId, agentId, sessionId, turnId: null, toolName: "t", event: HOOK_EVENT.PreToolUse },
        { v: 0 },
      );

      // v=0 → system: v=5 → agent: v=105. Chain is left-to-right, agent's modify is final.
      expect(aggregate.decision).toBe("modify");
      if (aggregate.decision === "modify") expect(aggregate.payload).toEqual({ v: 105 });
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "all three layers modify: payload threads all the way through",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId, tenantId, sessionId } = await setup(sql);

      registerHook<{ v: number }>({
        id: hookId("system/pre_tool_use/sys"),
        layer: "system",
        event: HOOK_EVENT.PreToolUse,
        matcher: () => true,
        decision: (p) => Promise.resolve({ decision: "modify", payload: { v: p.v + 1 } }),
      });
      registerHook<{ v: number }>({
        id: hookId("system/pre_tool_use/org"),
        layer: "organization",
        event: HOOK_EVENT.PreToolUse,
        matcher: () => true,
        decision: (p) => Promise.resolve({ decision: "modify", payload: { v: p.v + 10 } }),
      });
      registerHook<{ v: number }>({
        id: hookId("system/pre_tool_use/agt"),
        layer: "agent",
        event: HOOK_EVENT.PreToolUse,
        matcher: () => true,
        decision: (p) => Promise.resolve({ decision: "modify", payload: { v: p.v + 100 } }),
      });

      const aggregate = await runHooks<{ v: number }>(
        sql,
        clock,
        { tenantId, agentId, sessionId, turnId: null, toolName: "t", event: HOOK_EVENT.PreToolUse },
        { v: 0 },
      );

      // v=0 → sys: v=1 → org: v=11 → agent: v=111
      expect(aggregate.decision).toBe("modify");
      if (aggregate.decision === "modify") expect(aggregate.payload).toEqual({ v: 111 });

      const auditRows = await sql<AuditRow[]>`SELECT layer FROM hook_audit ORDER BY created_at`;
      expect(auditRows.length).toBe(3);
      expect(auditRows[0]?.layer).toBe("system");
      expect(auditRows[1]?.layer).toBe("organization");
      expect(auditRows[2]?.layer).toBe("agent");
    },
    HOOK_TIMEOUT_MS,
  );
});
