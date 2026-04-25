// Integration tests for createAgent. Real Postgres per CLAUDE.md §3.
// Skipped when INTEGRATION_DATABASE_URL is unset so `bun test` stays green locally.

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { assert } from "../../../src/core/assert.ts";
import { FakeClock } from "../../../src/core/clock.ts";
import { ok, err } from "../../../src/core/result.ts";
import type { Result } from "../../../src/core/result.ts";
import { migrate } from "../../../src/db/migrate-apply.ts";
import { TenantId } from "../../../src/ids.ts";
import { createAgent } from "../../../src/agent/create.ts";
import { parseAgentCreate } from "../../../src/agent/parse.ts";
import { HOOK_EVENT } from "../../../src/hook/types.ts";
import { registerHook, __clearRegistryForTesting } from "../../../src/hook/registry.ts";
import { HookRecordId } from "../../../src/ids.ts";
import type { EmbedError, EmbeddingClient } from "../../../src/memory/embedding.ts";
import { EMBEDDING_DIM } from "../../../src/memory/limits.ts";
import { FakeEmbeddingClient } from "../../fakes/embedding-fake.ts";
import { DB_URL, HOOK_TIMEOUT_MS, MIGRATIONS_DIR, describeOrSkip, resetDb } from "../helpers.ts";

let sqlRef: Sql | undefined;

function requireSql(): Sql {
  assert(sqlRef !== undefined, "integration test: sql initialized by beforeAll");
  return sqlRef;
}

function validSpec(overrides: Record<string, unknown> = {}) {
  const tenantId = TenantId.parse(randomUUID());
  assert(tenantId.ok, "fixture: randomUUID produced invalid TenantId");
  return {
    tenantId: tenantId.value,
    systemPrompt: "You are a helpful assistant.",
    toolSet: [{ name: "search", description: "web search" }] as const,
    hookRules: [] as const,
    seedMemory: [] as const,
    ...overrides,
  };
}

function makeHookRecordId(name: string) {
  const r = HookRecordId.parse(`system/agent_create/${name}`);
  assert(r.ok, `fixture: invalid HookRecordId for ${name}`);
  return r.value;
}

// EmbeddingClient that fails on the Nth call (0-indexed).
class FailOnNthEmbeddingClient implements EmbeddingClient {
  private callCount = 0;
  public constructor(
    private readonly failOnCall: number,
    private readonly error: EmbedError,
  ) {}
  public embed(): Promise<Result<Float32Array, EmbedError>> {
    const n = this.callCount++;
    if (n === this.failOnCall) return Promise.resolve(err(this.error));
    return Promise.resolve(ok(new Float32Array(EMBEDDING_DIM).fill(0.1)));
  }
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
  await requireSql()`TRUNCATE TABLE agents CASCADE`;
});

afterEach(() => {
  __clearRegistryForTesting();
});

describeOrSkip("createAgent (integration)", () => {
  test(
    "inserts a row with the expected fields",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_700_000_000_000);
      const spec = validSpec();

      const result = await createAgent(sql, clock, new FakeEmbeddingClient(), spec);

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

      const result = await createAgent(sql, clock, new FakeEmbeddingClient(), spec);
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

      const r1 = await createAgent(sql, clock, new FakeEmbeddingClient(), validSpec());
      const r2 = await createAgent(sql, clock, new FakeEmbeddingClient(), validSpec());

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      if (!r1.ok || !r2.ok) return;
      expect(r1.value.id).not.toBe(r2.value.id);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "happy path with seed memories: agent row + N memory rows all land atomically",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(0);
      const spec = validSpec({
        seedMemory: [
          { text: "User prefers TypeScript", importance: 0.9 },
          { text: "User prefers concise answers", importance: 0.7 },
          { text: "Context: financial domain", importance: 0.8 },
        ],
      });

      const parseResult = parseAgentCreate(spec);
      assert(parseResult.ok, "fixture: parseAgentCreate failed");

      const result = await createAgent(sql, clock, new FakeEmbeddingClient(), parseResult.value);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const agentRows = await sql<{ id: string }[]>`
        SELECT id FROM agents WHERE id = ${result.value.id}
      `;
      expect(agentRows.length).toBe(1);

      const memoryRows = await sql<
        { id: string; kind: string; agent_id: string; tenant_id: string }[]
      >`
        SELECT id, kind, agent_id, tenant_id FROM memory
        WHERE agent_id = ${result.value.id}
        ORDER BY created_at
      `;
      expect(memoryRows.length).toBe(3);
      for (const row of memoryRows) {
        expect(row.kind).toBe("event");
        expect(row.agent_id).toBe(result.value.id as string);
        expect(row.tenant_id).toBe(parseResult.value.tenantId as string);
      }
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "deny hook rolls back entire creation — no agent row, no memory rows",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(0);

      registerHook({
        id: makeHookRecordId("test-deny"),
        layer: "system",
        event: HOOK_EVENT.AgentCreate,
        matcher: () => true,
        decision: () => ({ decision: "deny", reason: "test policy: no agents allowed" }),
      });

      const spec = validSpec({
        seedMemory: [{ text: "some seed fact", importance: 0.5 }],
      });
      const parseResult = parseAgentCreate(spec);
      assert(parseResult.ok, "fixture: parseAgentCreate failed");

      const result = await createAgent(sql, clock, new FakeEmbeddingClient(), parseResult.value);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("hook_denied");
      if (result.error.kind === "hook_denied") {
        expect(result.error.reason).toBe("test policy: no agents allowed");
      }

      // Entire transaction rolled back — nothing persists.
      const agentRows = await sql`SELECT id FROM agents`;
      expect(agentRows.length).toBe(0);

      const memoryRows = await sql`SELECT id FROM memory`;
      expect(memoryRows.length).toBe(0);

      // Hook audit row is also rolled back (same tx as the deny decision).
      const auditRows = await sql`SELECT id FROM hook_audit WHERE event = 'agent_create'`;
      expect(auditRows.length).toBe(0);

      // No pending system messages — sessionId is null so enqueue is skipped.
      const pendingRows = await sql`SELECT id FROM pending_system_messages`;
      expect(pendingRows.length).toBe(0);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "approve with empty bucket: no audit rows written, agent row inserted",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(0);
      // No hooks registered (afterEach clears registry).

      const result = await createAgent(sql, clock, new FakeEmbeddingClient(), validSpec());

      expect(result.ok).toBe(true);

      const auditRows = await sql`SELECT id FROM hook_audit`;
      expect(auditRows.length).toBe(0);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "embedding failure on second seed memory: no rows inserted, returns embed_transient",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(0);
      const embedder = new FailOnNthEmbeddingClient(1, {
        kind: "transient",
        message: "rate limited",
      });

      const spec = validSpec({
        seedMemory: [
          { text: "first seed memory", importance: 0.5 },
          { text: "second seed memory — this embed will fail", importance: 0.5 },
        ],
      });
      const parseResult = parseAgentCreate(spec);
      assert(parseResult.ok, "fixture: parseAgentCreate failed");

      const result = await createAgent(sql, clock, embedder, parseResult.value);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("embed_transient");

      // Embeddings failed before the transaction opened — nothing inserted.
      const agentRows = await sql`SELECT id FROM agents`;
      expect(agentRows.length).toBe(0);

      const memoryRows = await sql`SELECT id FROM memory`;
      expect(memoryRows.length).toBe(0);

      const auditRows = await sql`SELECT id FROM hook_audit`;
      expect(auditRows.length).toBe(0);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "duplicate seed-memory text: both rows land (idempotency keys differ by index)",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(0);
      const duplicateText = "this fact appears twice";

      const spec = validSpec({
        seedMemory: [
          { text: duplicateText, importance: 0.5 },
          { text: duplicateText, importance: 0.5 },
        ],
      });
      const parseResult = parseAgentCreate(spec);
      assert(parseResult.ok, "fixture: parseAgentCreate failed");

      const result = await createAgent(sql, clock, new FakeEmbeddingClient(), parseResult.value);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const memoryRows = await sql<{ text: string }[]>`
        SELECT text FROM memory WHERE agent_id = ${result.value.id}
      `;
      expect(memoryRows.length).toBe(2);
      expect(memoryRows[0]?.text).toBe(duplicateText);
      expect(memoryRows[1]?.text).toBe(duplicateText);
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
