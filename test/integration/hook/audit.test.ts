// Integration tests for insertHookAudit. Real Postgres per CLAUDE.md §3.
// Skipped when INTEGRATION_DATABASE_URL is unset.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { assert } from "../../../src/core/assert.ts";
import { migrate } from "../../../src/db/migrate-apply.ts";
import { insertHookAudit } from "../../../src/hook/audit.ts";
import type { InsertHookAuditInput } from "../../../src/hook/audit.ts";
import { MAX_DENY_REASON_CHARS } from "../../../src/hook/limits.ts";
import { AgentId, HookAuditId, SessionId, TenantId, TurnId } from "../../../src/ids.ts";
import type {
  AgentId as AgentIdType,
  SessionId as SessionIdType,
  TenantId as TenantIdType,
  TurnId as TurnIdType,
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

function baseInput(agentId: AgentIdType, tenantId: TenantIdType): InsertHookAuditInput {
  return {
    hookId: "system/session-start/stub",
    layer: "system",
    event: "session_start",
    matcherResult: true,
    decision: "approve",
    reason: null,
    latencyMs: 5,
    tenantId,
    sessionId: null,
    agentId,
    turnId: null,
    toolName: null,
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

describeOrSkip("insertHookAudit (integration)", () => {
  test(
    "inserts an approve row with reason null",
    async () => {
      const sql = requireSql();
      const agentRaw = randomUUID();
      const tenantRaw = randomUUID();
      await insertAgent(sql, agentRaw, tenantRaw);
      const agentId = parseAgent(agentRaw);
      const tenantId = parseTenant(tenantRaw);

      const result = await insertHookAudit(sql, baseInput(agentId, tenantId));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const row = result.value;
      expect(row.hookId).toBe("system/session-start/stub");
      expect(row.layer).toBe("system");
      expect(row.event).toBe("session_start");
      expect(row.matcherResult).toBe(true);
      expect(row.decision).toBe("approve");
      expect(row.reason).toBeNull();
      expect(row.latencyMs).toBe(5);
      expect(row.sessionId).toBeNull();
      expect(row.turnId).toBeNull();
      expect(row.toolName).toBeNull();
      expect(row.createdAt).toBeInstanceOf(Date);

      const parsed = HookAuditId.parse(row.id);
      expect(parsed.ok).toBe(true);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "inserts a deny row with reason populated",
    async () => {
      const sql = requireSql();
      const agentRaw = randomUUID();
      const tenantRaw = randomUUID();
      await insertAgent(sql, agentRaw, tenantRaw);
      const agentId = parseAgent(agentRaw);
      const tenantId = parseTenant(tenantRaw);

      const result = await insertHookAudit(sql, {
        ...baseInput(agentId, tenantId),
        decision: "deny",
        reason: "blocked by rate limit",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.decision).toBe("deny");
      expect(result.value.reason).toBe("blocked by rate limit");
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "inserts a pre_tool_use row with session, turn, and tool_name",
    async () => {
      const sql = requireSql();
      const agentRaw = randomUUID();
      const tenantRaw = randomUUID();
      const sessionRaw = randomUUID();
      const turnRaw = randomUUID();
      await insertAgent(sql, agentRaw, tenantRaw);
      await insertSession(sql, sessionRaw, agentRaw, tenantRaw);
      const agentId = parseAgent(agentRaw);
      const tenantId = parseTenant(tenantRaw);
      const turnIdResult = TurnId.parse(turnRaw);
      assert(turnIdResult.ok, "fixture: invalid TurnId");
      const turnId: TurnIdType = turnIdResult.value;

      const result = await insertHookAudit(sql, {
        ...baseInput(agentId, tenantId),
        event: "pre_tool_use",
        sessionId: parseSession(sessionRaw),
        turnId,
        toolName: "bash",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.event).toBe("pre_tool_use");
      expect(result.value.sessionId).toBe(sessionRaw);
      expect(result.value.toolName).toBe("bash");
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "returns agent_not_found when agent does not exist",
    async () => {
      const sql = requireSql();
      const agentId = parseAgent(randomUUID());
      const tenantId = parseTenant(randomUUID());

      const result = await insertHookAudit(sql, baseInput(agentId, tenantId));

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("agent_not_found");
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "returns tenant_mismatch when agent belongs to different tenant",
    async () => {
      const sql = requireSql();
      const agentRaw = randomUUID();
      const agentTenantRaw = randomUUID();
      const callerTenantRaw = randomUUID();
      await insertAgent(sql, agentRaw, agentTenantRaw);
      const agentId = parseAgent(agentRaw);
      const callerTenantId = parseTenant(callerTenantRaw);

      const result = await insertHookAudit(sql, {
        ...baseInput(agentId, callerTenantId),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("tenant_mismatch");
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "returns reason_too_long when reason exceeds cap",
    async () => {
      const sql = requireSql();
      const agentRaw = randomUUID();
      const tenantRaw = randomUUID();
      await insertAgent(sql, agentRaw, tenantRaw);
      const agentId = parseAgent(agentRaw);
      const tenantId = parseTenant(tenantRaw);

      const longReason = "x".repeat(MAX_DENY_REASON_CHARS + 1);
      const result = await insertHookAudit(sql, {
        ...baseInput(agentId, tenantId),
        decision: "deny",
        reason: longReason,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("reason_too_long");
    },
    HOOK_TIMEOUT_MS,
  );
});
