// Integration tests for createAgent. Real Postgres per CLAUDE.md §3.
// Skipped when INTEGRATION_DATABASE_URL is unset so `bun test` stays green locally.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { assert } from "../../../src/core/assert.ts";
import { FakeClock } from "../../../src/core/clock.ts";
import { migrate } from "../../../src/db/migrate-apply.ts";
import { TenantId } from "../../../src/ids.ts";
import { createAgent } from "../../../src/agent/create.ts";
import { parseAgentCreate } from "../../../src/agent/parse.ts";
import { DB_URL, HOOK_TIMEOUT_MS, MIGRATIONS_DIR, describeOrSkip, resetDb } from "../helpers.ts";

let sqlRef: Sql | undefined;

function requireSql(): Sql {
  assert(sqlRef !== undefined, "integration test: sql initialized by beforeAll");
  return sqlRef;
}

function validSpec() {
  const tenantId = TenantId.parse(randomUUID());
  assert(tenantId.ok, "fixture: randomUUID produced invalid TenantId");
  return {
    tenantId: tenantId.value,
    systemPrompt: "You are a helpful assistant.",
    toolSet: [{ name: "search", description: "web search" }] as const,
    hookRules: [] as const,
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
  await s`TRUNCATE TABLE agents CASCADE`;
});

describeOrSkip("createAgent (integration)", () => {
  test(
    "inserts a row with the expected fields",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_700_000_000_000);
      const spec = validSpec();

      const result = await createAgent(sql, clock, spec);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const { id, createdAt } = result.value;
      expect(typeof (id as string)).toBe("string");
      expect(createdAt.getTime()).toBe(1_700_000_000_000);

      const rows = await sql<{ id: string; system_prompt: string }[]>`
        SELECT id, system_prompt FROM agents WHERE id = ${id}
      `;
      expect(rows.length).toBe(1);
      expect(rows[0]?.id).toBe(id as string);
      expect(rows[0]?.system_prompt).toBe(spec.systemPrompt);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "stores tool_set and hook_rules as JSONB",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(0);
      const spec = validSpec();

      const result = await createAgent(sql, clock, spec);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const rows = await sql<{ tool_set: unknown; hook_rules: unknown }[]>`
        SELECT tool_set, hook_rules FROM agents WHERE id = ${result.value.id}
      `;
      expect(rows.length).toBe(1);
      expect(rows[0]?.tool_set).toEqual(spec.toolSet);
      expect(rows[0]?.hook_rules).toEqual(spec.hookRules);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "transaction rollback rolls back all statements on constraint violation",
    async () => {
      const sql = requireSql();
      const agentId = randomUUID();
      const tenantIdRaw = randomUUID();

      // Manually exercise sql.begin rollback: insert the same ID twice.
      // The second statement violates the PK and the whole transaction rolls back.
      try {
        await sql.begin(async (tx) => {
          await tx`
            INSERT INTO agents (id, tenant_id, system_prompt, tool_set, hook_rules, created_at, updated_at)
            VALUES (${agentId}, ${tenantIdRaw}, 'test', '[]'::jsonb, '[]'::jsonb, now(), now())
          `;
          await tx`
            INSERT INTO agents (id, tenant_id, system_prompt, tool_set, hook_rules, created_at, updated_at)
            VALUES (${agentId}, ${tenantIdRaw}, 'dup', '[]'::jsonb, '[]'::jsonb, now(), now())
          `;
        });
      } catch {
        // Expected: duplicate PK triggers rollback
      }

      const rows = await sql<{ id: string }[]>`
        SELECT id FROM agents WHERE id = ${agentId}
      `;
      expect(rows.length).toBe(0);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "two sequential createAgent calls each get distinct ids",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(0);
      const spec = validSpec();

      const r1 = await createAgent(sql, clock, spec);
      const r2 = await createAgent(sql, clock, validSpec());

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      if (!r1.ok || !r2.ok) return;
      expect(r1.value.id).not.toBe(r2.value.id);
    },
    HOOK_TIMEOUT_MS,
  );
});

describeOrSkip("parseAgentCreate + createAgent (integration boundary)", () => {
  test(
    "v1 UUID tenant_id is rejected at parse stage — no row inserted",
    async () => {
      const sql = requireSql();
      const V1_UUID = "550e8400-e29b-11d4-a716-446655440000";

      const parseResult = parseAgentCreate({
        tenantId: V1_UUID,
        systemPrompt: "test",
        toolSet: [],
        hookRules: [],
      });
      expect(parseResult.ok).toBe(false);
      if (parseResult.ok) return;
      expect(parseResult.error.kind).toBe("tenant_id_invalid");

      // Confirm nothing was inserted (parse returned early before createAgent was called).
      const rows = await sql`SELECT id FROM agents WHERE tenant_id = ${V1_UUID}`;
      expect(rows.length).toBe(0);
    },
    HOOK_TIMEOUT_MS,
  );
});
