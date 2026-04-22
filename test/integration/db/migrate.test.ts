// Integration tests for the migration runner against a real Postgres with pgvector.
// CLAUDE.md §3 — integration tests hit real Postgres, not mocks.
//
// Bun's tcp-over-unix-socket stack has a known incompatibility with `dockerode` that
// underlies the testcontainers JS client; `PostgreSqlContainer.start()` hangs on macOS.
// See https://github.com/testcontainers/testcontainers-node/discussions/1115.
//
// The workaround: consume a ready-to-use Postgres via `INTEGRATION_DATABASE_URL`. A dev
// spins up a pgvector container once (see README) and reuses it across runs — the same
// contract CI uses, just with a local container instead of a service.
//
// If the env var is unset the tests are skipped. That's deliberate: unit tests own the
// happy path for the runner's file-parsing logic (test/unit/db/migrate.test.ts); these
// tests only add value when a real Postgres is present.

import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres, { type Sql } from "postgres";
import { assert } from "../../../src/core/assert.ts";
import { migrate } from "../../../src/db/migrate-apply.ts";
import { DB_URL, HOOK_TIMEOUT_MS, MIGRATIONS_DIR, describeOrSkip, resetDb } from "../helpers.ts";

let sqlRef: Sql | undefined;

function requireSql(): Sql {
  assert(sqlRef !== undefined, "integration test: sql initialized by beforeAll");
  return sqlRef;
}

beforeAll(async () => {
  if (!DB_URL) return;
  const s = postgres(DB_URL, { max: 4, idle_timeout: 2 });
  // Fail fast if the URL is wrong rather than letting the first test hang.
  await s`SELECT 1`;
  await resetDb(s);
  sqlRef = s;
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  if (sqlRef !== undefined) await sqlRef.end({ timeout: 5 });
}, 10_000);

describeOrSkip("migrate (integration)", () => {
  test(
    "applies shipped migrations: extension, tables, indexes, checks",
    async () => {
      const sql = requireSql();
      const result = await migrate(sql, MIGRATIONS_DIR);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.applied).toEqual([1, 2, 3, 4]);
      expect(result.value.skipped).toEqual([]);

      const extRows = await sql<{ installed: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS installed
      `;
      expect(extRows[0]?.installed).toBe(true);

      const cols = await sql<{ table_name: string; column_name: string }[]>`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('agents', 'sessions', 'tasks')
          AND column_name = 'tenant_id'
      `;
      const tablesWithTenant = new Set(cols.map((r) => r.table_name));
      expect(tablesWithTenant.has("agents")).toBe(true);
      expect(tablesWithTenant.has("sessions")).toBe(true);
      expect(tablesWithTenant.has("tasks")).toBe(true);

      const idx = await sql<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes WHERE tablename = 'sessions'
      `;
      const names = new Set(idx.map((r) => r.indexname));
      expect(names.has("sessions_agent_closed_idx")).toBe(true);
      expect(names.has("sessions_chain_id_idx")).toBe(true);
      expect(names.has("sessions_source_work_item_idx")).toBe(true);

      const envelopeTable = await sql<{ exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'trigger_envelopes'
        ) AS exists
      `;
      expect(envelopeTable[0]?.exists).toBe(true);

      const turnsTable = await sql<{ exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'turns'
        ) AS exists
      `;
      expect(turnsTable[0]?.exists).toBe(true);

      const transcriptCol = await sql<{ exists: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'sessions'
            AND column_name = 'turn_transcript'
        ) AS exists
      `;
      expect(transcriptCol[0]?.exists).toBe(false);

      // depth CHECK rejects out-of-range.
      const agentRows = await sql<{ id: string }[]>`
        INSERT INTO agents (id, tenant_id, system_prompt)
        VALUES (gen_random_uuid(), gen_random_uuid(), 'test')
        RETURNING id
      `;
      const agentId = agentRows[0]?.id;
      expect(agentId).toBeDefined();
      let threw = false;
      try {
        await sql`
          INSERT INTO sessions (id, agent_id, tenant_id, originating_trigger, chain_id, depth)
          VALUES (gen_random_uuid(), ${agentId ?? ""}, gen_random_uuid(), '{}'::jsonb, gen_random_uuid(), 99)
        `;
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "is idempotent — second run skips everything",
    async () => {
      const sql = requireSql();
      const second = await migrate(sql, MIGRATIONS_DIR);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.applied).toEqual([]);
      expect(second.value.skipped).toEqual([1, 2, 3, 4]);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "detects checksum mismatch when a past migration is altered",
    async () => {
      const sql = requireSql();
      await sql`UPDATE _migrations SET checksum = 'tampered' WHERE version = 1`;
      const r = await migrate(sql, MIGRATIONS_DIR);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.kind).toBe("checksum_mismatch");
    },
    HOOK_TIMEOUT_MS,
  );
});
