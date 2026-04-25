// Integration tests for synthesizeOpeningContext memory injection.
// Real pgvector Postgres per CLAUDE.md §3. Skipped when INTEGRATION_DATABASE_URL is unset.
// EmbeddingClient is mocked (paid external); DB and retrieval are real.

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { assert } from "../../../src/core/assert.ts";
import { FakeClock } from "../../../src/core/clock.ts";
import { migrate } from "../../../src/db/migrate-apply.ts";
import { AgentId, Importance, TenantId } from "../../../src/ids.ts";
import { insertMemory } from "../../../src/memory/insert.ts";
import { MemoryKind } from "../../../src/memory/kind.ts";
import { EMBEDDING_CALL_TIMEOUT_MS, EMBEDDING_DIM } from "../../../src/memory/limits.ts";
import { synthesizeOpeningContext } from "../../../src/trigger/synthesize.ts";
import type { SynthesizeDeps } from "../../../src/trigger/synthesize.ts";
import type { TriggerPayload } from "../../../src/trigger/payload.ts";
import type { AgentId as AgentIdBrand, TenantId as TenantIdBrand } from "../../../src/ids.ts";
import {
  installMetricFixture,
  sumCounter,
  uninstallMetricFixture,
  type MetricFixture,
} from "../../helpers/metrics.ts";
import type { Result } from "../../../src/core/result.ts";
import type { EmbedError, EmbeddingClient } from "../../../src/memory/embedding.ts";
import { FakeEmbeddingClient } from "../../fakes/embedding-fake.ts";
import {
  DB_URL,
  HOOK_TIMEOUT_MS,
  MIGRATIONS_DIR,
  describeOrSkip,
  makeTestKey,
  resetDb,
} from "../helpers.ts";

let sqlRef: Sql | undefined;

function requireSql(): Sql {
  assert(sqlRef !== undefined, "integration test: sql initialized by beforeAll");
  return sqlRef;
}

function parseTenantId(raw: string): TenantIdBrand {
  const r = TenantId.parse(raw);
  assert(r.ok, "fixture: invalid TenantId");
  return r.value;
}

function parseAgentId(raw: string): AgentIdBrand {
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

// Angularly spread vectors: memory i has embedding [cos(i*π/steps), sin(i*π/steps), 0...].
// Query [1,0,...] gives similarity cos(i*π/steps). i=0 has highest similarity (cos(0)=1).
function makeAngularVector(i: number, steps: number): Float32Array {
  const arr = new Float32Array(EMBEDDING_DIM);
  arr[0] = Math.cos((i * Math.PI) / steps);
  arr[1] = Math.sin((i * Math.PI) / steps);
  return arr;
}

// Query vector aligned to i=0: [1, 0, 0, ...]
function queryVector(): Float32Array {
  const arr = new Float32Array(EMBEDDING_DIM);
  arr[0] = 1.0;
  return arr;
}

async function insertAgent(sql: Sql, agentId: string, tenantId: string): Promise<void> {
  await sql`
    INSERT INTO agents (id, tenant_id, system_prompt, tool_set, hook_rules, created_at, updated_at)
    VALUES (${agentId}, ${tenantId}, 'test system prompt', '[]'::jsonb, '[]'::jsonb, now(), now())
  `;
}

async function insertMemoryRow(
  sql: Sql,
  agentId: string,
  tenantId: string,
  text: string,
  embedding: Float32Array,
  importance = 0.5,
): Promise<void> {
  const result = await sql.begin((tx) =>
    insertMemory(tx, {
      agentId: parseAgentId(agentId),
      tenantId: parseTenantId(tenantId),
      kind: parseKind("fact"),
      text,
      embedding,
      importance: parseImportance(importance),
      idempotencyKey: makeTestKey(),
    }),
  );
  assert(result.ok, "insertMemoryRow: insert failed");
}

function makeDeps(
  sql: Sql,
  clock: FakeClock,
  embedder: EmbeddingClient = new FakeEmbeddingClient(),
): SynthesizeDeps {
  return { sql, clock, embedder };
}

function makeMessagePayload(agentId: AgentIdBrand, content = "Hello world"): TriggerPayload {
  return {
    kind: "message",
    sender: { type: "human", id: "user-1" },
    targetAgentId: agentId,
    content,
    receivedAt: new Date(),
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

let metricFixture: MetricFixture | undefined;

afterEach(async () => {
  if (metricFixture !== undefined) {
    await uninstallMetricFixture();
    metricFixture = undefined;
  }
});

describeOrSkip("synthesizeOpeningContext — integration", () => {
  test(
    "synthesize_returnsBaseTuple_whenAgentHasNoMemories",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(Date.now());
      const tenantIdStr = randomUUID();
      const agentIdStr = randomUUID();
      await insertAgent(sql, agentIdStr, tenantIdStr);

      const agentId = parseAgentId(agentIdStr);
      const tenantId = parseTenantId(tenantIdStr);
      const agent = { id: agentId, tenantId, systemPrompt: "You are helpful." };
      const payload = makeMessagePayload(agentId, "Tell me something");

      const deps = makeDeps(sql, clock, new FakeEmbeddingClient());
      const signal = AbortSignal.timeout(EMBEDDING_CALL_TIMEOUT_MS);
      const ctx = await synthesizeOpeningContext(deps, payload, agent, signal);

      expect(ctx.entries).toHaveLength(2);
      // No memories → system prompt unchanged
      expect(ctx.entries[0]?.content).toBe("You are helpful.");
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "synthesize_injectsTopKMemories_endToEnd",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(Date.now());
      const tenantIdStr = randomUUID();
      const agentIdStr = randomUUID();
      await insertAgent(sql, agentIdStr, tenantIdStr);

      // Insert 3 memories with deterministic embeddings; query vector = [1, 0, ...]
      // Memory 0 has embedding aligned to query (highest similarity).
      await insertMemoryRow(sql, agentIdStr, tenantIdStr, "Fact A", makeAngularVector(0, 10));
      await insertMemoryRow(sql, agentIdStr, tenantIdStr, "Fact B", makeAngularVector(1, 10));
      await insertMemoryRow(sql, agentIdStr, tenantIdStr, "Fact C", makeAngularVector(2, 10));

      const agentId = parseAgentId(agentIdStr);
      const tenantId = parseTenantId(tenantIdStr);
      const agent = { id: agentId, tenantId, systemPrompt: "You are helpful." };
      const payload = makeMessagePayload(agentId, "Tell me something");

      // FakeEmbeddingClient returns a deterministic vector for the query text.
      // Use a custom embedder that returns the queryVector so similarity ordering is predictable.
      const fixedEmbedder = {
        embed(): Promise<Result<Float32Array, EmbedError>> {
          return Promise.resolve({ ok: true, value: queryVector() });
        },
      };
      const deps = makeDeps(sql, clock, fixedEmbedder);
      const signal = AbortSignal.timeout(EMBEDDING_CALL_TIMEOUT_MS);
      const ctx = await synthesizeOpeningContext(deps, payload, agent, signal);

      expect(ctx.entries).toHaveLength(2);
      const systemContent = ctx.entries[0]?.content ?? "";
      expect(systemContent).toContain("# Recalled memories");
      expect(systemContent).toContain("Fact A");
      expect(systemContent).toContain("Fact B");
      expect(systemContent).toContain("Fact C");
      expect(systemContent.startsWith("You are helpful.")).toBe(true);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "synthesize_doesNotInjectAcrossTenants",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(Date.now());
      const tenant1Str = randomUUID();
      const tenant2Str = randomUUID();
      const agent1Str = randomUUID();
      const agent2Str = randomUUID();
      await insertAgent(sql, agent1Str, tenant1Str);
      await insertAgent(sql, agent2Str, tenant2Str);

      // Insert memory for tenant2 agent; query is against tenant1 agent
      await insertMemoryRow(sql, agent2Str, tenant2Str, "Cross-tenant fact", queryVector());

      const agentId = parseAgentId(agent1Str);
      const tenantId = parseTenantId(tenant1Str);
      const agent = { id: agentId, tenantId, systemPrompt: "You are helpful." };
      const payload = makeMessagePayload(agentId, "Tell me something");

      const fixedEmbedder = {
        embed(): Promise<Result<Float32Array, EmbedError>> {
          return Promise.resolve({ ok: true, value: queryVector() });
        },
      };
      const deps = makeDeps(sql, clock, fixedEmbedder);
      const signal = AbortSignal.timeout(EMBEDDING_CALL_TIMEOUT_MS);
      const ctx = await synthesizeOpeningContext(deps, payload, agent, signal);

      const systemContent = ctx.entries[0]?.content ?? "";
      // No cross-tenant memories should appear
      expect(systemContent).toBe("You are helpful.");
      expect(systemContent).not.toContain("Cross-tenant fact");
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "synthesize_softFailsAndProceeds_whenEmbedFails_transient",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(Date.now());
      const tenantIdStr = randomUUID();
      const agentIdStr = randomUUID();
      await insertAgent(sql, agentIdStr, tenantIdStr);

      await insertMemoryRow(sql, agentIdStr, tenantIdStr, "Some fact", queryVector());

      const agentId = parseAgentId(agentIdStr);
      const tenantId = parseTenantId(tenantIdStr);
      const agent = { id: agentId, tenantId, systemPrompt: "You are helpful." };
      const payload = makeMessagePayload(agentId);

      metricFixture = installMetricFixture();
      const failingEmbedder = new FakeEmbeddingClient({
        error: { kind: "transient", message: "down" },
      });
      const deps = makeDeps(sql, clock, failingEmbedder);
      const signal = AbortSignal.timeout(EMBEDDING_CALL_TIMEOUT_MS);
      const ctx = await synthesizeOpeningContext(deps, payload, agent, signal);

      // Soft fail → base tuple returned unchanged
      expect(ctx.entries[0]?.content).toBe("You are helpful.");
      expect(ctx.entries).toHaveLength(2);

      const rm = await metricFixture.collect();
      const skipped = sumCounter(rm, "relay.memory.injection.skipped_total", {
        "relay.memory.injection.skipped_reason": "embed_transient",
      });
      expect(skipped).toBe(1);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "synthesize_emitsMemoryInjectedCountOnSuccess",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(Date.now());
      const tenantIdStr = randomUUID();
      const agentIdStr = randomUUID();
      await insertAgent(sql, agentIdStr, tenantIdStr);

      await insertMemoryRow(
        sql,
        agentIdStr,
        tenantIdStr,
        "A remembered fact",
        makeAngularVector(0, 10),
      );

      const agentId = parseAgentId(agentIdStr);
      const tenantId = parseTenantId(tenantIdStr);
      const agent = { id: agentId, tenantId, systemPrompt: "You are helpful." };
      const payload = makeMessagePayload(agentId);

      metricFixture = installMetricFixture();
      const fixedEmbedder = {
        embed(): Promise<Result<Float32Array, EmbedError>> {
          return Promise.resolve({ ok: true, value: queryVector() });
        },
      };
      const deps = makeDeps(sql, clock, fixedEmbedder);
      const signal = AbortSignal.timeout(EMBEDDING_CALL_TIMEOUT_MS);
      await synthesizeOpeningContext(deps, payload, agent, signal);

      const rm = await metricFixture.collect();
      const injected = sumCounter(rm, "relay.memory.injection.injected_total");
      expect(injected).toBeGreaterThanOrEqual(1);
    },
    HOOK_TIMEOUT_MS,
  );
});
