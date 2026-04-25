// Integration tests for pending_system_messages module. Real Postgres per CLAUDE.md §3.
// Skipped when INTEGRATION_DATABASE_URL is unset.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { assert } from "../../../src/core/assert.ts";
import { migrate } from "../../../src/db/migrate-apply.ts";
import { insertHookAudit } from "../../../src/hook/audit.ts";
import {
  enqueuePendingSystemMessage,
  drainPendingSystemMessages,
} from "../../../src/hook/pending.ts";
import { MAX_PENDING_MESSAGES_PER_TURN } from "../../../src/hook/limits.ts";
import {
  AgentId,
  HookAuditId,
  PendingSystemMessageId,
  SessionId,
  TenantId,
} from "../../../src/ids.ts";
import type {
  AgentId as AgentIdType,
  HookAuditId as HookAuditIdType,
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

async function insertAuditRow(
  sql: Sql,
  agentId: AgentIdType,
  tenantId: TenantIdType,
): Promise<HookAuditIdType> {
  const result = await insertHookAudit(sql, {
    hookId: "system/session-start/stub",
    layer: "system",
    event: "session_start",
    matcherResult: true,
    decision: "deny",
    reason: "test deny",
    latencyMs: 1,
    tenantId,
    sessionId: null,
    agentId,
    turnId: null,
    toolName: null,
  });
  assert(result.ok, "fixture: audit row insert failed");
  const parsed = HookAuditId.parse(result.value.id);
  assert(parsed.ok, "fixture: invalid HookAuditId from DB");
  return parsed.value;
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

describeOrSkip("pending_system_messages (integration)", () => {
  test(
    "enqueue inserts a row and drain returns it",
    async () => {
      const sql = requireSql();
      const agentRaw = randomUUID();
      const tenantRaw = randomUUID();
      const sessionRaw = randomUUID();
      await insertAgent(sql, agentRaw, tenantRaw);
      await insertSession(sql, sessionRaw, agentRaw, tenantRaw);
      const agentId = parseAgent(agentRaw);
      const tenantId = parseTenant(tenantRaw);
      const sessionId = parseSession(sessionRaw);
      const auditId = await insertAuditRow(sql, agentId, tenantId);

      const enqResult = await enqueuePendingSystemMessage(sql, {
        tenantId,
        targetSessionId: sessionId,
        kind: "hook_deny",
        hookAuditId: auditId,
        content: "[relay:hook_deny session_start] test deny",
      });
      expect(enqResult.ok).toBe(true);

      const drainResult = await drainPendingSystemMessages(sql, {
        targetSessionId: sessionId,
        tenantId,
      });
      expect(drainResult.ok).toBe(true);
      if (!drainResult.ok) return;
      expect(drainResult.value.length).toBe(1);
      const row = drainResult.value[0];
      assert(row !== undefined, "drain: expected one row");
      expect(row.content).toBe("[relay:hook_deny session_start] test deny");
      expect(row.hookAuditId).toBe(auditId);

      const pid = PendingSystemMessageId.parse(row.id);
      expect(pid.ok).toBe(true);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "drain marks rows consumed and second drain returns empty",
    async () => {
      const sql = requireSql();
      const agentRaw = randomUUID();
      const tenantRaw = randomUUID();
      const sessionRaw = randomUUID();
      await insertAgent(sql, agentRaw, tenantRaw);
      await insertSession(sql, sessionRaw, agentRaw, tenantRaw);
      const agentId = parseAgent(agentRaw);
      const tenantId = parseTenant(tenantRaw);
      const sessionId = parseSession(sessionRaw);
      const auditId = await insertAuditRow(sql, agentId, tenantId);

      await enqueuePendingSystemMessage(sql, {
        tenantId,
        targetSessionId: sessionId,
        kind: "hook_deny",
        hookAuditId: auditId,
        content: "msg",
      });

      const first = await drainPendingSystemMessages(sql, { targetSessionId: sessionId, tenantId });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.value.length).toBe(1);

      const second = await drainPendingSystemMessages(sql, {
        targetSessionId: sessionId,
        tenantId,
      });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.length).toBe(0);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "drain returns rows in created_at order",
    async () => {
      const sql = requireSql();
      const agentRaw = randomUUID();
      const tenantRaw = randomUUID();
      const sessionRaw = randomUUID();
      await insertAgent(sql, agentRaw, tenantRaw);
      await insertSession(sql, sessionRaw, agentRaw, tenantRaw);
      const agentId = parseAgent(agentRaw);
      const tenantId = parseTenant(tenantRaw);
      const sessionId = parseSession(sessionRaw);

      // Insert three rows with controlled created_at ordering
      for (const label of ["first", "second", "third"]) {
        const auditId = await insertAuditRow(sql, agentId, tenantId);
        await enqueuePendingSystemMessage(sql, {
          tenantId,
          targetSessionId: sessionId,
          kind: "hook_deny",
          hookAuditId: auditId,
          content: label,
        });
      }

      const drain = await drainPendingSystemMessages(sql, { targetSessionId: sessionId, tenantId });
      expect(drain.ok).toBe(true);
      if (!drain.ok) return;
      expect(drain.value.length).toBe(3);
      const contents = drain.value.map((r) => r.content);
      expect(contents).toEqual(["first", "second", "third"]);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "drain respects MAX_PENDING_MESSAGES_PER_TURN cap",
    async () => {
      const sql = requireSql();
      const agentRaw = randomUUID();
      const tenantRaw = randomUUID();
      const sessionRaw = randomUUID();
      await insertAgent(sql, agentRaw, tenantRaw);
      await insertSession(sql, sessionRaw, agentRaw, tenantRaw);
      const agentId = parseAgent(agentRaw);
      const tenantId = parseTenant(tenantRaw);
      const sessionId = parseSession(sessionRaw);

      const total = MAX_PENDING_MESSAGES_PER_TURN + 2;
      for (let i = 0; i < total; i++) {
        const auditId = await insertAuditRow(sql, agentId, tenantId);
        await enqueuePendingSystemMessage(sql, {
          tenantId,
          targetSessionId: sessionId,
          kind: "hook_deny",
          hookAuditId: auditId,
          content: `msg-${i.toString()}`,
        });
      }

      const drain = await drainPendingSystemMessages(sql, { targetSessionId: sessionId, tenantId });
      expect(drain.ok).toBe(true);
      if (!drain.ok) return;
      expect(drain.value.length).toBe(MAX_PENDING_MESSAGES_PER_TURN);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "drained rows have consumed_at set",
    async () => {
      const sql = requireSql();
      const agentRaw = randomUUID();
      const tenantRaw = randomUUID();
      const sessionRaw = randomUUID();
      await insertAgent(sql, agentRaw, tenantRaw);
      await insertSession(sql, sessionRaw, agentRaw, tenantRaw);
      const agentId = parseAgent(agentRaw);
      const tenantId = parseTenant(tenantRaw);
      const sessionId = parseSession(sessionRaw);
      const auditId = await insertAuditRow(sql, agentId, tenantId);

      await enqueuePendingSystemMessage(sql, {
        tenantId,
        targetSessionId: sessionId,
        kind: "hook_deny",
        hookAuditId: auditId,
        content: "a message",
      });
      const drainResult = await drainPendingSystemMessages(sql, {
        targetSessionId: sessionId,
        tenantId,
      });
      assert(drainResult.ok, "drain failed");
      const [row] = drainResult.value;
      assert(row !== undefined, "drain: expected row");

      // Verify consumed_at is set in the DB
      const dbRows = await sql<{ consumed_at: Date | null }[]>`
        SELECT consumed_at FROM pending_system_messages WHERE id = ${row.id as string}
      `;
      expect(dbRows.length).toBe(1);
      expect(dbRows[0]?.consumed_at).toBeInstanceOf(Date);
    },
    HOOK_TIMEOUT_MS,
  );
});
