import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe } from "bun:test";
import type { Sql } from "postgres";
import { assert } from "../../src/core/assert.ts";
import { idempotencyKey, type IdempotencyKey } from "../../src/core/idempotency.ts";
import { AgentId, SessionId, TenantId, TurnId } from "../../src/ids.ts";
import type { AgentId as AgentIdType, TenantId as TenantIdType } from "../../src/ids.ts";
import { WRITER } from "../../src/memory/insert.ts";

export const DB_URL = process.env["INTEGRATION_DATABASE_URL"];
export const MIGRATIONS_DIR = path.resolve(import.meta.dir, "../../src/db/migrations");
export const HOOK_TIMEOUT_MS = 30_000;
export const describeOrSkip = DB_URL ? describe : describe.skip;

export async function resetDb(s: Sql): Promise<void> {
  await s.unsafe(`
    DROP TABLE IF EXISTS session_pending_asks CASCADE;
    DROP TABLE IF EXISTS pending_system_messages CASCADE;
    DROP TABLE IF EXISTS hook_audit CASCADE;
    DROP TABLE IF EXISTS inbound_messages CASCADE;
    DROP TABLE IF EXISTS turns CASCADE;
    DROP TABLE IF EXISTS trigger_envelopes CASCADE;
    DROP TABLE IF EXISTS work_queue CASCADE;
    DROP TABLE IF EXISTS memory CASCADE;
    DROP TABLE IF EXISTS tasks CASCADE;
    DROP TABLE IF EXISTS sessions CASCADE;
    DROP TABLE IF EXISTS agents CASCADE;
    DROP TABLE IF EXISTS _migrations CASCADE;
    DROP EXTENSION IF EXISTS vector CASCADE;
  `);
}

export async function insertAgent(sql: Sql, agentId: string, tenantId: string): Promise<void> {
  await sql`
    INSERT INTO agents (id, tenant_id, system_prompt, tool_set, hook_rules, created_at, updated_at)
    VALUES (${agentId}, ${tenantId}, 'test agent', '[]'::jsonb, '[]'::jsonb, now(), now())
  `;
}

export async function insertSession(
  s: Sql,
  sessionId: string,
  agentId: string,
  tenantId: string,
): Promise<void> {
  const chainId = randomUUID();
  await s`
    INSERT INTO sessions (id, agent_id, tenant_id, originating_trigger, chain_id, depth, opening_user_content, created_at, updated_at)
    VALUES (${sessionId}, ${agentId}, ${tenantId}, '{"kind":"test"}'::jsonb, ${chainId}, 0, 'test opening content', now(), now())
  `;
}

export function makeIds(): { agentId: AgentIdType; tenantId: TenantIdType } {
  const a = AgentId.parse(randomUUID());
  const t = TenantId.parse(randomUUID());
  assert(a.ok && t.ok, "fixture: randomUUID produced invalid ids");
  return { agentId: a.value, tenantId: t.value };
}

export function makeTestKey(): IdempotencyKey {
  const r1 = SessionId.parse(randomUUID());
  const r2 = TurnId.parse(randomUUID());
  assert(r1.ok, "fixture: invalid SessionId");
  assert(r2.ok, "fixture: invalid TurnId");
  return idempotencyKey({
    writer: WRITER,
    sessionId: r1.value,
    turnId: r2.value,
    toolCallId: randomUUID(),
  });
}
