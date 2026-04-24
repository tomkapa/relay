// Integration tests for retrieveMemory. Real pgvector Postgres per CLAUDE.md §3.
// Skipped when INTEGRATION_DATABASE_URL is unset.

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { AssertionError, assert } from "../../../src/core/assert.ts";
import { FakeClock } from "../../../src/core/clock.ts";
import { migrate } from "../../../src/db/migrate-apply.ts";
import { AgentId, CandidatePool, Importance, RetrievalK, TenantId } from "../../../src/ids.ts";
import { insertMemory } from "../../../src/memory/insert.ts";
import { MemoryKind } from "../../../src/memory/kind.ts";
import { EMBEDDING_DIM } from "../../../src/memory/limits.ts";
import { retrieveMemory } from "../../../src/memory/retrieve.ts";
import {
  installMetricFixture,
  sumCounter,
  uninstallMetricFixture,
  type MetricFixture,
} from "../../helpers/metrics.ts";
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

function parseK(raw: number) {
  const r = RetrievalK.parse(raw);
  assert(r.ok, "fixture: invalid RetrievalK");
  return r.value;
}

// One-hot vector: only dimension `hotDim` is 1.0.
function makeUnitVector(hotDim: number): Float32Array {
  assert(hotDim >= 0 && hotDim < EMBEDDING_DIM, "makeUnitVector: hotDim out of range", { hotDim });
  const arr = new Float32Array(EMBEDDING_DIM);
  arr[hotDim] = 1.0;
  return arr;
}

// Angularly spread vectors for ordered similarity: memory_i has embedding
// [cos(i*π/steps), sin(i*π/steps), 0, ...]. Query [1,0,...] gives cos(i*π/steps) similarity.
function makeAngularVector(i: number, steps: number): Float32Array {
  const arr = new Float32Array(EMBEDDING_DIM);
  arr[0] = Math.cos((i * Math.PI) / steps);
  arr[1] = Math.sin((i * Math.PI) / steps);
  return arr;
}

async function insertAgent(
  sql: Sql,
  agentId: string,
  tenantId: string,
  tunables?: { alpha?: number; halfLifeDays?: number },
): Promise<void> {
  const alpha = tunables?.alpha ?? 1.0;
  const halfLife = tunables?.halfLifeDays ?? 90;
  await sql`
    INSERT INTO agents (id, tenant_id, system_prompt, tool_set, hook_rules, created_at, updated_at,
                        memory_alpha, memory_half_life_days)
    VALUES (${agentId}, ${tenantId}, 'test agent', '[]'::jsonb, '[]'::jsonb, now(), now(),
            ${alpha}, ${halfLife})
  `;
}

async function insertMemoryRow(
  sql: Sql,
  agentId: string,
  tenantId: string,
  embedding: Float32Array,
  importance = 0.5,
  kind = "event",
): Promise<string> {
  const result = await sql.begin((tx) =>
    insertMemory(tx, {
      agentId: parseAgentId(agentId),
      tenantId: parseTenantId(tenantId),
      kind: parseKind(kind),
      text: `memory for dim ${String(embedding.findIndex((v) => v > 0))}`,
      embedding,
      importance: parseImportance(importance),
    }),
  );
  assert(result.ok, "insertMemoryRow: insert failed");
  return result.value.id;
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

let metricFixture: MetricFixture | undefined;

afterEach(async () => {
  if (metricFixture !== undefined) {
    await uninstallMetricFixture();
    metricFixture = undefined;
  }
});

describeOrSkip("retrieveMemory (integration)", () => {
  test(
    "retrieveMemory_returnsEmpty_whenNoMemoriesExist",
    async () => {
      const sql = requireSql();
      const tenantId = parseTenantId(randomUUID());
      const agentId = parseAgentId(randomUUID());
      await insertAgent(sql, agentId, tenantId);

      const clock = new FakeClock(Date.now());
      const result = await retrieveMemory(sql, clock, {
        agentId,
        tenantId,
        queryEmbed: makeUnitVector(0),
        k: parseK(3),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(0);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "retrieveMemory_returnsAgentNotFound_whenAgentMissing",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(Date.now());
      const result = await retrieveMemory(sql, clock, {
        agentId: parseAgentId(randomUUID()),
        tenantId: parseTenantId(randomUUID()),
        queryEmbed: makeUnitVector(0),
        k: parseK(3),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("agent_not_found");
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "retrieveMemory_returnsAgentNotFound_whenTenantMismatch",
    async () => {
      const sql = requireSql();
      const agentTenantId = randomUUID();
      const agentIdStr = randomUUID();
      await insertAgent(sql, agentIdStr, agentTenantId);

      const clock = new FakeClock(Date.now());
      const result = await retrieveMemory(sql, clock, {
        agentId: parseAgentId(agentIdStr),
        tenantId: parseTenantId(randomUUID()), // different tenant
        queryEmbed: makeUnitVector(0),
        k: parseK(3),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("agent_not_found");
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "retrieveMemory_returnsTopK_orderedByScore",
    async () => {
      // One-hot vectors: memory at dim i has cosine similarity 1.0 with query at dim i, 0 with others.
      const sql = requireSql();
      const tenantId = randomUUID();
      const agentId = randomUUID();
      await insertAgent(sql, agentId, tenantId);

      // Insert 5 memories; query aligned to dim 3 → memory 3 should rank first.
      for (let i = 0; i < 5; i++) {
        await insertMemoryRow(sql, agentId, tenantId, makeUnitVector(i));
      }

      const clock = new FakeClock(Date.now());
      const result = await retrieveMemory(sql, clock, {
        agentId: parseAgentId(agentId),
        tenantId: parseTenantId(tenantId),
        queryEmbed: makeUnitVector(3),
        k: parseK(3),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(3);
      // Memory 3 has similarity 1.0, all others 0.0 — it must be first.
      expect(result.value[0]?.similarity).toBeCloseTo(1.0);
      expect(result.value[0]?.score).toBeGreaterThan(0);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "retrieveMemory_respectsK",
    async () => {
      const sql = requireSql();
      const tenantId = randomUUID();
      const agentId = randomUUID();
      await insertAgent(sql, agentId, tenantId);

      for (let i = 0; i < 10; i++) {
        await insertMemoryRow(sql, agentId, tenantId, makeUnitVector(i));
      }

      const clock = new FakeClock(Date.now());
      const result = await retrieveMemory(sql, clock, {
        agentId: parseAgentId(agentId),
        tenantId: parseTenantId(tenantId),
        queryEmbed: makeUnitVector(0),
        k: parseK(3),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(3);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "retrieveMemory_excludesOtherTenantsMemories",
    async () => {
      const sql = requireSql();
      const tenantA = randomUUID();
      const tenantB = randomUUID();
      const agentA = randomUUID();
      const agentB = randomUUID();
      await insertAgent(sql, agentA, tenantA);
      await insertAgent(sql, agentB, tenantB);

      const embed = makeUnitVector(0);
      await insertMemoryRow(sql, agentA, tenantA, embed);
      await insertMemoryRow(sql, agentB, tenantB, embed);

      const clock = new FakeClock(Date.now());
      const result = await retrieveMemory(sql, clock, {
        agentId: parseAgentId(agentA),
        tenantId: parseTenantId(tenantA),
        queryEmbed: embed,
        k: parseK(5),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Only agent A's memory — tenant B's memory must not appear.
      expect(result.value.length).toBe(1);
      const dbRows = await sql<{ tenant_id: string }[]>`
        SELECT DISTINCT tenant_id FROM memory WHERE id = ANY(${result.value.map((r) => r.id as string)})
      `;
      expect(dbRows.length).toBe(1);
      expect(dbRows[0]?.tenant_id).toBe(tenantA);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "retrieveMemory_bumpsLastRetrievedAtAndCount",
    async () => {
      const sql = requireSql();
      const tenantId = randomUUID();
      const agentId = randomUUID();
      await insertAgent(sql, agentId, tenantId);
      const memId = await insertMemoryRow(sql, agentId, tenantId, makeUnitVector(0));

      const before = await sql<{ retrieval_count: number; last_retrieved_at: Date | null }[]>`
        SELECT retrieval_count, last_retrieved_at FROM memory WHERE id = ${memId}
      `;
      expect(before[0]?.retrieval_count).toBe(0);
      expect(before[0]?.last_retrieved_at).toBeNull();

      const nowMs = Date.now();
      const clock = new FakeClock(nowMs);
      const result = await retrieveMemory(sql, clock, {
        agentId: parseAgentId(agentId),
        tenantId: parseTenantId(tenantId),
        queryEmbed: makeUnitVector(0),
        k: parseK(1),
      });
      expect(result.ok).toBe(true);

      const after = await sql<{ retrieval_count: number; last_retrieved_at: Date }[]>`
        SELECT retrieval_count, last_retrieved_at FROM memory WHERE id = ${memId}
      `;
      expect(after[0]?.retrieval_count).toBe(1);
      expect(after[0]?.last_retrieved_at).toBeInstanceOf(Date);
      // last_retrieved_at should be ≈ clock.now() (within 5s tolerance).
      const diff = Math.abs((after[0]?.last_retrieved_at.getTime() ?? 0) - nowMs);
      expect(diff).toBeLessThan(5_000);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "retrieveMemory_bumpsCountAcrossMultipleCalls",
    async () => {
      const sql = requireSql();
      const tenantId = randomUUID();
      const agentId = randomUUID();
      await insertAgent(sql, agentId, tenantId);
      const memId = await insertMemoryRow(sql, agentId, tenantId, makeUnitVector(0));

      const clock = new FakeClock(Date.now());
      const input = {
        agentId: parseAgentId(agentId),
        tenantId: parseTenantId(tenantId),
        queryEmbed: makeUnitVector(0),
        k: parseK(1),
      };
      await retrieveMemory(sql, clock, input);
      await retrieveMemory(sql, clock, input);
      await retrieveMemory(sql, clock, input);

      const after = await sql<{ retrieval_count: number }[]>`
        SELECT retrieval_count FROM memory WHERE id = ${memId}
      `;
      expect(after[0]?.retrieval_count).toBe(3);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "retrieveMemory_doesNotBumpUnreturnedRows",
    async () => {
      // Angular embeddings give ordered similarity so the top-k are deterministic.
      // With 10 memories and pool=5, k=3: memories 0,1,2 are returned; 3-9 are not.
      const sql = requireSql();
      const tenantId = randomUUID();
      const agentId = randomUUID();
      await insertAgent(sql, agentId, tenantId);

      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        const id = await insertMemoryRow(sql, agentId, tenantId, makeAngularVector(i, 10));
        ids.push(id);
      }

      const clock = new FakeClock(Date.now());
      const result = await retrieveMemory(sql, clock, {
        agentId: parseAgentId(agentId),
        tenantId: parseTenantId(tenantId),
        queryEmbed: makeAngularVector(0, 10), // [1, 0, ...] — aligns with memory 0
        k: parseK(3),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(3);

      const returnedIds = new Set(result.value.map((r) => r.id as string));
      const rows = await sql<{ id: string; retrieval_count: number }[]>`
        SELECT id, retrieval_count FROM memory WHERE id = ANY(${ids})
      `;
      for (const row of rows) {
        if (returnedIds.has(row.id)) {
          expect(row.retrieval_count).toBe(1);
        } else {
          expect(row.retrieval_count).toBe(0);
        }
      }
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "retrieveMemory_blendsEventsAndFacts",
    async () => {
      const sql = requireSql();
      const tenantId = randomUUID();
      const agentId = randomUUID();
      await insertAgent(sql, agentId, tenantId);

      await insertMemoryRow(sql, agentId, tenantId, makeUnitVector(0), 0.5, "event");
      await insertMemoryRow(sql, agentId, tenantId, makeUnitVector(1), 0.5, "fact");

      const clock = new FakeClock(Date.now());
      const result = await retrieveMemory(sql, clock, {
        agentId: parseAgentId(agentId),
        tenantId: parseTenantId(tenantId),
        queryEmbed: makeUnitVector(0),
        k: parseK(2),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(2);
      const kinds = new Set(result.value.map((r) => r.kind as string));
      expect(kinds.has("event")).toBe(true);
      expect(kinds.has("fact")).toBe(true);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "retrieveMemory_assertsWrongDimension",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(Date.now());
      const wrongEmbed = new Float32Array(10); // wrong dimension
      let caught: unknown;
      try {
        await retrieveMemory(sql, clock, {
          agentId: parseAgentId(randomUUID()),
          tenantId: parseTenantId(randomUUID()),
          queryEmbed: wrongEmbed,
          k: parseK(1),
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(AssertionError);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "retrieveMemory_assertsNonFiniteEmbeddingValue",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(Date.now());
      const badEmbed = new Float32Array(EMBEDDING_DIM);
      badEmbed[0] = Number.NaN;
      let caught: unknown;
      try {
        await retrieveMemory(sql, clock, {
          agentId: parseAgentId(randomUUID()),
          tenantId: parseTenantId(randomUUID()),
          queryEmbed: badEmbed,
          k: parseK(1),
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(AssertionError);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "retrieveMemory_usesAgentTunables",
    async () => {
      // Alpha=2 makes high importance much more valuable; alpha=0 ignores importance.
      const sql = requireSql();
      const tenantId = randomUUID();
      const agentHighAlpha = randomUUID();
      const agentZeroAlpha = randomUUID();
      await insertAgent(sql, agentHighAlpha, tenantId, { alpha: 2.0 });
      await insertAgent(sql, agentZeroAlpha, tenantId, { alpha: 0.0 });

      // Two memories with very different importance but same embedding direction.
      // Use angular vectors so the similarities differ: dim0 more similar to query, dim1 less.
      const embed0 = makeAngularVector(0, 4); // similarity 1.0 with query [1, 0, ...]
      const embed1 = makeAngularVector(1, 4); // similarity cos(π/4) ≈ 0.707

      // High-importance memory at dim1, low-importance at dim0.
      await insertMemoryRow(sql, agentHighAlpha, tenantId, embed0, 0.1); // low importance
      await insertMemoryRow(sql, agentHighAlpha, tenantId, embed1, 0.9); // high importance
      await insertMemoryRow(sql, agentZeroAlpha, tenantId, embed0, 0.1);
      await insertMemoryRow(sql, agentZeroAlpha, tenantId, embed1, 0.9);

      const clock = new FakeClock(Date.now());
      const query = makeAngularVector(0, 4); // aligned with dim0

      const highAlphaResult = await retrieveMemory(sql, clock, {
        agentId: parseAgentId(agentHighAlpha),
        tenantId: parseTenantId(tenantId),
        queryEmbed: query,
        k: parseK(2),
      });
      const zeroAlphaResult = await retrieveMemory(sql, clock, {
        agentId: parseAgentId(agentZeroAlpha),
        tenantId: parseTenantId(tenantId),
        queryEmbed: query,
        k: parseK(2),
      });

      expect(highAlphaResult.ok).toBe(true);
      expect(zeroAlphaResult.ok).toBe(true);
      if (!highAlphaResult.ok || !zeroAlphaResult.ok) return;

      // With alpha=0: importance^0 = 1 for both, so ordering is purely by similarity.
      // Memory at dim0 (similarity≈1.0) ranks first for zeroAlpha agent.
      expect(zeroAlphaResult.value[0]?.similarity).toBeGreaterThan(
        zeroAlphaResult.value[1]?.similarity ?? 0,
      );

      // With alpha=2: dim1 memory (importance=0.9) may outrank dim0 (importance=0.1)
      // because 0.9^2 * 0.707 = 0.572 > 0.1^2 * 1.0 = 0.01.
      const highAlphaScores = highAlphaResult.value.map((r) => r.score);
      const zeroAlphaScores = zeroAlphaResult.value.map((r) => r.score);
      // The rankings differ — verify at least one ordering differs.
      expect(JSON.stringify(highAlphaScores)).not.toEqual(JSON.stringify(zeroAlphaScores));
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "retrieveMemory_doesNotWriteOnEmptyResult",
    async () => {
      const sql = requireSql();
      const tenantId = randomUUID();
      const agentId = randomUUID();
      await insertAgent(sql, agentId, tenantId);
      // No memories — result will be empty.

      const countBefore = await sql<{ n: string }[]>`SELECT count(*) AS n FROM memory`;
      const clock = new FakeClock(Date.now());
      const result = await retrieveMemory(sql, clock, {
        agentId: parseAgentId(agentId),
        tenantId: parseTenantId(tenantId),
        queryEmbed: makeUnitVector(0),
        k: parseK(3),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(0);

      const countAfter = await sql<{ n: string }[]>`SELECT count(*) AS n FROM memory`;
      expect(Number(countAfter[0]?.n)).toBe(Number(countBefore[0]?.n));
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "retrieveMemory_saturationCounter_incrementsWhenPoolFull",
    async () => {
      const sql = requireSql();
      const tenantId = randomUUID();
      const agentId = randomUUID();
      await insertAgent(sql, agentId, tenantId);

      // Insert exactly 5 memories; pool = 5 → pool will be saturated.
      for (let i = 0; i < 5; i++) {
        await insertMemoryRow(sql, agentId, tenantId, makeUnitVector(i));
      }

      metricFixture = installMetricFixture();
      const clock = new FakeClock(Date.now());

      // CandidatePool of exactly 5 = number of rows → should saturate.
      const kResult = RetrievalK.parse(1);
      assert(kResult.ok, "k parse");
      const pr = CandidatePool.parse(5, kResult.value);
      assert(pr.ok, "pool parse");

      await retrieveMemory(sql, clock, {
        agentId: parseAgentId(agentId),
        tenantId: parseTenantId(tenantId),
        queryEmbed: makeUnitVector(0),
        k: parseK(1),
        candidatePool: pr.value,
      });

      const rm = await metricFixture.collect();
      const satCount = sumCounter(rm, "relay.memory.retrieve.candidate_pool_saturated");
      expect(satCount).toBe(1);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "agentTunables_defaultToLimitsValues",
    async () => {
      const sql = requireSql();
      const tenantId = randomUUID();
      const agentId = randomUUID();
      // Insert agent without specifying tunable columns (use DB defaults).
      await sql`
        INSERT INTO agents (id, tenant_id, system_prompt, tool_set, hook_rules, created_at, updated_at)
        VALUES (${agentId}, ${tenantId}, 'test', '[]'::jsonb, '[]'::jsonb, now(), now())
      `;

      const rows = await sql<
        {
          memory_default_importance: number;
          memory_half_life_days: number;
          memory_alpha: number;
        }[]
      >`
        SELECT memory_default_importance, memory_half_life_days, memory_alpha
          FROM agents WHERE id = ${agentId}
      `;
      expect(rows.length).toBe(1);
      const row = rows[0];
      if (!row) return;
      expect(row.memory_default_importance).toBeCloseTo(0.5);
      expect(row.memory_half_life_days).toBe(90);
      expect(row.memory_alpha).toBeCloseTo(1.0);
    },
    HOOK_TIMEOUT_MS,
  );
});
