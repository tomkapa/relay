// Integration tests for insertMemory. Real pgvector Postgres per CLAUDE.md §3.
// Skipped when INTEGRATION_DATABASE_URL is unset.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { AssertionError, assert } from "../../../src/core/assert.ts";
import { migrate } from "../../../src/db/migrate-apply.ts";
import { AgentId, Importance, MemoryId, TenantId } from "../../../src/ids.ts";
import { insertMemory } from "../../../src/memory/insert.ts";
import { MemoryKind } from "../../../src/memory/kind.ts";
import { EMBEDDING_DIM, MAX_ENTRY_TEXT_BYTES } from "../../../src/memory/limits.ts";
import { DB_URL, HOOK_TIMEOUT_MS, MIGRATIONS_DIR, describeOrSkip, resetDb } from "../helpers.ts";

let sqlRef: Sql | undefined;

function requireSql(): Sql {
  assert(sqlRef !== undefined, "integration test: sql initialized by beforeAll");
  return sqlRef;
}

function parseTenantId(raw: string) {
  const r = TenantId.parse(raw);
  assert(r.ok, "fixture: invalid TenantId");
  return r.value;
}

function parseAgentId(raw: string) {
  const r = AgentId.parse(raw);
  assert(r.ok, "fixture: invalid AgentId");
  return r.value;
}

function parseImportance(raw: number) {
  const r = Importance.parse(raw);
  assert(r.ok, "fixture: invalid Importance");
  return r.value;
}

function parseKind(raw: string) {
  const r = MemoryKind.parse(raw);
  assert(r.ok, "fixture: invalid MemoryKind");
  return r.value;
}

function makeEmbedding(seed = 0): Float32Array {
  const arr = new Float32Array(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    arr[i] = (Math.sin(i + seed) + 1) / 2;
  }
  return arr;
}

async function insertAgent(sql: Sql, agentId: string, tenantId: string): Promise<void> {
  await sql`
    INSERT INTO agents (id, tenant_id, system_prompt, tool_set, hook_rules, created_at, updated_at)
    VALUES (${agentId}, ${tenantId}, 'test agent', '[]'::jsonb, '[]'::jsonb, now(), now())
  `;
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

describeOrSkip("insertMemory (integration)", () => {
  test(
    "insertMemory_insertsEventRow: valid event input writes one row with expected columns",
    async () => {
      const sql = requireSql();
      const tenantIdStr = randomUUID();
      const agentIdStr = randomUUID();
      await insertAgent(sql, agentIdStr, tenantIdStr);

      const tenantId = parseTenantId(tenantIdStr);
      const agentId = parseAgentId(agentIdStr);
      const kind = parseKind("event");
      const importance = parseImportance(0.7);
      const text = "the agent observed X";
      const embedding = makeEmbedding(1);

      const result = await sql.begin((tx) =>
        insertMemory(tx, { agentId, tenantId, kind, text, embedding, importance }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const row = result.value;
      expect(MemoryId.parse(row.id as string).ok).toBe(true);
      expect(row.agentId as string).toBe(agentIdStr);
      expect(row.tenantId as string).toBe(tenantIdStr);
      expect(row.kind as string).toBe("event");
      expect(row.text).toBe(text);
      expect(row.importance as number).toBeCloseTo(0.7);
      expect(row.retrievalCount).toBe(0);
      expect(row.lastRetrievedAt).toBeNull();
      expect(row.createdAt).toBeInstanceOf(Date);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "insertMemory_insertsFactRow: valid fact input writes one row",
    async () => {
      const sql = requireSql();
      const tenantIdStr = randomUUID();
      const agentIdStr = randomUUID();
      await insertAgent(sql, agentIdStr, tenantIdStr);

      const tenantId = parseTenantId(tenantIdStr);
      const agentId = parseAgentId(agentIdStr);
      const kind = parseKind("fact");
      const importance = parseImportance(0.9);
      const text = "user prefers concise answers";
      const embedding = makeEmbedding(2);

      const result = await sql.begin((tx) =>
        insertMemory(tx, { agentId, tenantId, kind, text, embedding, importance }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.kind as string).toBe("fact");

      const dbRows = await sql<{ kind: string }[]>`
        SELECT kind FROM memory WHERE id = ${result.value.id as string}
      `;
      expect(dbRows.length).toBe(1);
      expect(dbRows[0]?.kind).toBe("fact");
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "insertMemory_rejectsTenantMismatch: mismatched tenantId returns error, no row written",
    async () => {
      const sql = requireSql();
      const agentTenantStr = randomUUID();
      const agentIdStr = randomUUID();
      await insertAgent(sql, agentIdStr, agentTenantStr);

      const callerTenantId = parseTenantId(randomUUID()); // different tenant
      const agentId = parseAgentId(agentIdStr);
      const kind = parseKind("event");
      const importance = parseImportance(0.5);
      const text = "some memory";
      const embedding = makeEmbedding();

      const result = await sql.begin((tx) =>
        insertMemory(tx, { agentId, tenantId: callerTenantId, kind, text, embedding, importance }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("tenant_mismatch");
      if (result.error.kind !== "tenant_mismatch") return;
      expect(result.error.expected as string).toBe(callerTenantId as string);
      expect(result.error.got as string).toBe(agentTenantStr);

      const count = await sql<{ n: string }[]>`
        SELECT count(*) AS n FROM memory
      `;
      expect(Number(count[0]?.n)).toBe(0);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "insertMemory_rejectsUnknownAgent: unknown agentId returns agent_not_found, no row written",
    async () => {
      const sql = requireSql();
      const tenantId = parseTenantId(randomUUID());
      const agentId = parseAgentId(randomUUID()); // never inserted
      const kind = parseKind("event");
      const importance = parseImportance(0.5);
      const text = "some memory";
      const embedding = makeEmbedding();

      const result = await sql.begin((tx) =>
        insertMemory(tx, { agentId, tenantId, kind, text, embedding, importance }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("agent_not_found");
      if (result.error.kind !== "agent_not_found") return;
      expect(result.error.agentId as string).toBe(agentId as string);

      const count = await sql<{ n: string }[]>`SELECT count(*) AS n FROM memory`;
      expect(Number(count[0]?.n)).toBe(0);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "insertMemory_rejectsOversizeText: text exceeding MAX_ENTRY_TEXT_BYTES returns text_too_long",
    async () => {
      const sql = requireSql();
      const tenantIdStr = randomUUID();
      const agentIdStr = randomUUID();
      await insertAgent(sql, agentIdStr, tenantIdStr);

      const tenantId = parseTenantId(tenantIdStr);
      const agentId = parseAgentId(agentIdStr);
      const kind = parseKind("event");
      const importance = parseImportance(0.5);
      const oversizeText = "x".repeat(MAX_ENTRY_TEXT_BYTES + 1);
      const embedding = makeEmbedding();

      const result = await sql.begin((tx) =>
        insertMemory(tx, {
          agentId,
          tenantId,
          kind,
          text: oversizeText,
          embedding,
          importance,
        }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("text_too_long");
      if (result.error.kind !== "text_too_long") return;
      expect(result.error.bytes).toBeGreaterThan(MAX_ENTRY_TEXT_BYTES);
      expect(result.error.max).toBe(MAX_ENTRY_TEXT_BYTES);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "insertMemory_assertsWrongDimension: embedding with wrong length throws AssertionError",
    async () => {
      const sql = requireSql();
      const tenantId = parseTenantId(randomUUID());
      const agentId = parseAgentId(randomUUID());
      const kind = parseKind("event");
      const importance = parseImportance(0.5);
      const wrongEmbedding = new Float32Array(128); // wrong dimension

      let caught: unknown;
      try {
        await sql.begin((tx) =>
          insertMemory(tx, {
            agentId,
            tenantId,
            kind,
            text: "some text",
            embedding: wrongEmbedding,
            importance,
          }),
        );
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(AssertionError);
    },
    HOOK_TIMEOUT_MS,
  );
});
