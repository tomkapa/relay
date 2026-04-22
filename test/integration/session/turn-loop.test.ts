// Integration tests for runTurnLoop. Real Postgres per CLAUDE.md §3.
// Skipped when INTEGRATION_DATABASE_URL is unset so `bun test` stays green locally.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { assert } from "../../../src/core/assert.ts";
import { FakeClock } from "../../../src/core/clock.ts";
import { migrate } from "../../../src/db/migrate-apply.ts";
import {
  AgentId as AgentIdParser,
  SessionId as SessionIdParser,
  TenantId as TenantIdParser,
} from "../../../src/ids.ts";
import type { AgentId, SessionId, TenantId } from "../../../src/ids.ts";
import type { ModelClient } from "../../../src/session/model.ts";
import { InMemoryToolRegistry, echoTool } from "../../../src/session/tools-inmemory.ts";
import { runTurnLoop } from "../../../src/session/turn-loop.ts";
import type { Message, ModelResponse, ToolUseBlock } from "../../../src/session/turn.ts";
import { DB_URL, HOOK_TIMEOUT_MS, MIGRATIONS_DIR, describeOrSkip, resetDb } from "../helpers.ts";

let sqlRef: Sql | undefined;

function requireSql(): Sql {
  assert(sqlRef !== undefined, "integration test: sql initialized by beforeAll");
  return sqlRef;
}

async function insertSession(sql: Sql, agentId: AgentId, tenantId: TenantId): Promise<SessionId> {
  const raw = randomUUID();
  const chainId = randomUUID();
  await sql`
    INSERT INTO sessions (id, agent_id, tenant_id, originating_trigger, chain_id, depth, created_at, updated_at)
    VALUES (${raw}, ${agentId}, ${tenantId}, '{"kind":"test"}'::jsonb, ${chainId}, 0, now(), now())
  `;
  const r = SessionIdParser.parse(raw);
  assert(r.ok, "insertSession: invalid UUID");
  return r.value;
}

function makeIds(): { agentId: AgentId; tenantId: TenantId } {
  const a = AgentIdParser.parse(randomUUID());
  const t = TenantIdParser.parse(randomUUID());
  assert(a.ok && t.ok, "makeIds: randomUUID produced invalid ids");
  return { agentId: a.value, tenantId: t.value };
}

function textResponse(text: string): ModelResponse {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

function toolUseResponse(id: string, name: string, input: Record<string, unknown>): ModelResponse {
  const toolBlock: ToolUseBlock = { type: "tool_use", id, name, input };
  return {
    content: [toolBlock],
    stopReason: "tool_use",
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

const baseMessages: Message[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }];

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
  await s.unsafe("TRUNCATE TABLE turns, sessions, tasks, agents CASCADE");
});

describeOrSkip("runTurnLoop (integration)", () => {
  test(
    "single end_turn inserts exactly one turns row",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId, tenantId } = makeIds();
      await sql`INSERT INTO agents (id, tenant_id, system_prompt) VALUES (${agentId}, ${tenantId}, 'sys')`;
      const sessionId = await insertSession(sql, agentId, tenantId);

      const model: ModelClient = { complete: () => Promise.resolve(textResponse("done")) };
      const tools = new InMemoryToolRegistry([]);

      const result = await runTurnLoop(
        { sql, clock, model, tools },
        { sessionId, agentId, tenantId, systemPrompt: "sys", initialMessages: baseMessages },
      );

      expect(result.ok).toBe(true);

      const rows = await sql<{ turn_index: number; response: unknown; tool_results: unknown[] }[]>`
        SELECT turn_index, response, tool_results FROM turns WHERE session_id = ${sessionId}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.turn_index).toBe(0);
      expect(rows[0]?.tool_results).toHaveLength(0);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "tool round-trip inserts two turns with contiguous turn_index values",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId, tenantId } = makeIds();
      await sql`INSERT INTO agents (id, tenant_id, system_prompt) VALUES (${agentId}, ${tenantId}, 'sys')`;
      const sessionId = await insertSession(sql, agentId, tenantId);

      let callCount = 0;
      const model: ModelClient = {
        complete: () => {
          callCount++;
          if (callCount === 1)
            return Promise.resolve(toolUseResponse("tc_1", "echo", { text: "hello" }));
          return Promise.resolve(textResponse("done"));
        },
      };
      const tools = new InMemoryToolRegistry([echoTool]);

      const result = await runTurnLoop(
        { sql, clock, model, tools },
        { sessionId, agentId, tenantId, systemPrompt: "sys", initialMessages: baseMessages },
      );

      expect(result.ok).toBe(true);

      const rows = await sql<{ turn_index: number; tool_results: unknown }[]>`
        SELECT turn_index, tool_results FROM turns WHERE session_id = ${sessionId} ORDER BY turn_index
      `;
      expect(rows).toHaveLength(2);
      expect(rows[0]?.turn_index).toBe(0);
      expect(rows[1]?.turn_index).toBe(1);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "usage is persisted correctly on the turn row",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId, tenantId } = makeIds();
      await sql`INSERT INTO agents (id, tenant_id, system_prompt) VALUES (${agentId}, ${tenantId}, 'sys')`;
      const sessionId = await insertSession(sql, agentId, tenantId);

      const model: ModelClient = {
        complete: () =>
          Promise.resolve({
            content: [{ type: "text" as const, text: "hi" }],
            stopReason: "end_turn" as const,
            usage: { inputTokens: 42, outputTokens: 7 },
          }),
      };
      const tools = new InMemoryToolRegistry([]);

      const result = await runTurnLoop(
        { sql, clock, model, tools },
        { sessionId, agentId, tenantId, systemPrompt: "sys", initialMessages: baseMessages },
      );

      expect(result.ok).toBe(true);

      const rows = await sql<{ usage: { inputTokens: number; outputTokens: number } }[]>`
        SELECT usage FROM turns WHERE session_id = ${sessionId}
      `;
      expect(rows[0]?.usage.inputTokens).toBe(42);
      expect(rows[0]?.usage.outputTokens).toBe(7);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "session closed_at remains NULL after loop completes — that is RELAY-28's job",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId, tenantId } = makeIds();
      await sql`INSERT INTO agents (id, tenant_id, system_prompt) VALUES (${agentId}, ${tenantId}, 'sys')`;
      const sessionId = await insertSession(sql, agentId, tenantId);

      const model: ModelClient = { complete: () => Promise.resolve(textResponse("done")) };
      const tools = new InMemoryToolRegistry([]);

      await runTurnLoop(
        { sql, clock, model, tools },
        { sessionId, agentId, tenantId, systemPrompt: "sys", initialMessages: baseMessages },
      );

      const rows = await sql<{ closed_at: Date | null }[]>`
        SELECT closed_at FROM sessions WHERE id = ${sessionId}
      `;
      expect(rows[0]?.closed_at).toBeNull();
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "UNIQUE (session_id, turn_index) prevents duplicate rows on repeated calls",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId, tenantId } = makeIds();
      await sql`INSERT INTO agents (id, tenant_id, system_prompt) VALUES (${agentId}, ${tenantId}, 'sys')`;
      const sessionId = await insertSession(sql, agentId, tenantId);

      const model: ModelClient = { complete: () => Promise.resolve(textResponse("done")) };
      const tools = new InMemoryToolRegistry([]);

      // First run inserts turn_index 0
      await runTurnLoop(
        { sql, clock, model, tools },
        { sessionId, agentId, tenantId, systemPrompt: "sys", initialMessages: baseMessages },
      );

      // Second run also starts at index 0 → duplicate → persist_turn_failed (constraint violation)
      const result2 = await runTurnLoop(
        { sql, clock, model, tools },
        { sessionId, agentId, tenantId, systemPrompt: "sys", initialMessages: baseMessages },
      );

      // The unique constraint should cause an insert error surfaced as persist_turn_failed
      expect(result2.ok).toBe(false);
      if (!result2.ok) expect(result2.error.kind).toBe("persist_turn_failed");
    },
    HOOK_TIMEOUT_MS,
  );
});
