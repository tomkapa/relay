// Integration tests for the remember tool. Real pgvector Postgres per CLAUDE.md §3.
// Skipped when INTEGRATION_DATABASE_URL is unset.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { assert } from "../../../src/core/assert.ts";
import { SessionId as SessionIdParser, TurnId as TurnIdParser } from "../../../src/ids.ts";
import type { AgentId, TenantId } from "../../../src/ids.ts";
import { migrate } from "../../../src/db/migrate-apply.ts";
import { idempotencyKey } from "../../../src/core/idempotency.ts";
import { WRITER as MEMORY_WRITER } from "../../../src/memory/insert.ts";
import { makeRememberTool } from "../../../src/memory/remember.ts";
import { InMemoryToolRegistry } from "../../../src/session/tools-inmemory.ts";
import type { ToolInvocationContext } from "../../../src/session/tools.ts";
import { FakeEmbeddingClient } from "../../fakes/embedding-fake.ts";
import {
  DB_URL,
  HOOK_TIMEOUT_MS,
  MIGRATIONS_DIR,
  describeOrSkip,
  insertAgent,
  makeIds,
  resetDb,
} from "../helpers.ts";

let sqlRef: Sql | undefined;

function requireSql(): Sql {
  assert(sqlRef !== undefined, "integration test: sql initialized by beforeAll");
  return sqlRef;
}

function makeCtx(agentId: AgentId, tenantId: TenantId): ToolInvocationContext {
  const session = SessionIdParser.parse(randomUUID());
  const turn = TurnIdParser.parse(randomUUID());
  assert(session.ok, "fixture: invalid SessionId");
  assert(turn.ok, "fixture: invalid TurnId");
  return {
    sessionId: session.value,
    agentId,
    tenantId,
    turnId: turn.value,
    toolUseId: `tc_${randomUUID()}`,
  };
}

function makeRegistry(sql: Sql) {
  const embedding = new FakeEmbeddingClient();
  const tool = makeRememberTool({ sql, embedding });
  return new InMemoryToolRegistry([tool]);
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
  await s`TRUNCATE TABLE agents CASCADE`;
});

describeOrSkip("remember tool (integration)", () => {
  test(
    "remember_writesEventRow_endToEnd",
    async () => {
      const sql = requireSql();
      const { agentId, tenantId } = makeIds();
      await insertAgent(sql, agentId, tenantId);

      const ctx = makeCtx(agentId, tenantId);
      const registry = makeRegistry(sql);
      const signal = AbortSignal.timeout(5000);

      const result = await registry.invoke({
        name: "remember",
        input: { text: "the user prefers concise responses" },
        ctx,
        signal,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const parsed = JSON.parse(result.content) as { memoryId: string; kind: string };
      expect(typeof parsed.memoryId).toBe("string");
      expect(parsed.kind).toBe("event");

      const expectedKey = idempotencyKey({
        writer: MEMORY_WRITER,
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        toolCallId: ctx.toolUseId,
      });

      const rows = await sql<
        {
          id: string;
          kind: string;
          text: string;
          importance: number;
          idempotency_key: string;
          agent_id: string;
          tenant_id: string;
        }[]
      >`
        SELECT id, kind, text, importance, idempotency_key, agent_id, tenant_id
        FROM memory WHERE id = ${parsed.memoryId}
      `;
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (row === undefined) return;
      expect(row.kind).toBe("event");
      expect(row.text).toBe("the user prefers concise responses");
      expect(row.importance).toBeCloseTo(0.5);
      expect(row.idempotency_key).toBe(expectedKey);
      expect(row.agent_id).toBe(agentId);
      expect(row.tenant_id).toBe(tenantId);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "remember_acceptsExplicitImportance",
    async () => {
      const sql = requireSql();
      const { agentId, tenantId } = makeIds();
      await insertAgent(sql, agentId, tenantId);

      const ctx = makeCtx(agentId, tenantId);
      const registry = makeRegistry(sql);
      const signal = AbortSignal.timeout(5000);

      const result = await registry.invoke({
        name: "remember",
        input: { text: "important fact", importance: 0.9 },
        ctx,
        signal,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const parsed = JSON.parse(result.content) as { memoryId: string; kind: string };
      const rows = await sql<{ importance: number }[]>`
        SELECT importance FROM memory WHERE id = ${parsed.memoryId}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.importance).toBeCloseTo(0.9);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "remember_dedupsOnRepeatedToolUseId",
    async () => {
      const sql = requireSql();
      const { agentId, tenantId } = makeIds();
      await insertAgent(sql, agentId, tenantId);

      const ctx = makeCtx(agentId, tenantId);
      const registry = makeRegistry(sql);
      const signal = AbortSignal.timeout(5000);

      const result1 = await registry.invoke({
        name: "remember",
        input: { text: "first write" },
        ctx,
        signal,
      });
      const result2 = await registry.invoke({
        name: "remember",
        input: { text: "first write" },
        ctx, // same ctx → same toolUseId
        signal,
      });

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      if (!result1.ok || !result2.ok) return;

      const p1 = JSON.parse(result1.content) as { memoryId: string };
      const p2 = JSON.parse(result2.content) as { memoryId: string };
      expect(p1.memoryId).toBe(p2.memoryId);

      const count = await sql<{ n: string }[]>`SELECT count(*) AS n FROM memory`;
      expect(Number(count[0]?.n)).toBe(1);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "remember_distinctToolUseIds_writeSeparateRows",
    async () => {
      const sql = requireSql();
      const { agentId, tenantId } = makeIds();
      await insertAgent(sql, agentId, tenantId);

      const registry = makeRegistry(sql);
      const signal = AbortSignal.timeout(5000);

      const ctx1 = makeCtx(agentId, tenantId);
      const ctx2 = makeCtx(agentId, tenantId); // distinct toolUseId (new ctx)

      const r1 = await registry.invoke({
        name: "remember",
        input: { text: "fact one" },
        ctx: ctx1,
        signal,
      });
      const r2 = await registry.invoke({
        name: "remember",
        input: { text: "fact two" },
        ctx: ctx2,
        signal,
      });

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      if (!r1.ok || !r2.ok) return;

      const p1 = JSON.parse(r1.content) as { memoryId: string };
      const p2 = JSON.parse(r2.content) as { memoryId: string };
      expect(p1.memoryId).not.toBe(p2.memoryId);

      const count = await sql<{ n: string }[]>`SELECT count(*) AS n FROM memory`;
      expect(Number(count[0]?.n)).toBe(2);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "remember_returnsToolError_onEmbedTransient_writesNoRow",
    async () => {
      const sql = requireSql();
      const { agentId, tenantId } = makeIds();
      await insertAgent(sql, agentId, tenantId);

      const ctx = makeCtx(agentId, tenantId);
      const embedding = new FakeEmbeddingClient({ error: { kind: "transient", message: "x" } });
      const tool = makeRememberTool({ sql, embedding });
      const registry = new InMemoryToolRegistry([tool]);
      const signal = AbortSignal.timeout(5000);

      const result = await registry.invoke({
        name: "remember",
        input: { text: "hello" },
        ctx,
        signal,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errorMessage).toContain("temporarily unavailable");

      const count = await sql<{ n: string }[]>`SELECT count(*) AS n FROM memory`;
      expect(Number(count[0]?.n)).toBe(0);
    },
    HOOK_TIMEOUT_MS,
  );
});
