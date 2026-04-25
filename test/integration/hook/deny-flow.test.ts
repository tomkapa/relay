// End-to-end deny flow: evaluateHook with a forced deny → hook_audit row + pending_system_messages
// row → runTurnLoop receives a system_synthetic message carrying the deny reason.
// Real Postgres per CLAUDE.md §3. Skipped when INTEGRATION_DATABASE_URL is unset.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { assert } from "../../../src/core/assert.ts";
import { FakeClock } from "../../../src/core/clock.ts";
import { migrate } from "../../../src/db/migrate-apply.ts";
import { evaluateHook } from "../../../src/hook/evaluate.ts";
import { AgentId, SessionId, TenantId } from "../../../src/ids.ts";
import type {
  AgentId as AgentIdType,
  SessionId as SessionIdType,
  TenantId as TenantIdType,
} from "../../../src/ids.ts";
import type { ModelClient } from "../../../src/session/model.ts";
import type { Message, ModelResponse } from "../../../src/session/turn.ts";
import { InMemoryToolRegistry } from "../../../src/session/tools-inmemory.ts";
import { runTurnLoop } from "../../../src/session/turn-loop.ts";
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

async function setup(sql: Sql): Promise<{
  agentId: AgentIdType;
  tenantId: TenantIdType;
  sessionId: SessionIdType;
}> {
  const agentRaw = randomUUID();
  const tenantRaw = randomUUID();
  const sessionRaw = randomUUID();
  await insertAgent(sql, agentRaw, tenantRaw);
  await insertSession(sql, sessionRaw, agentRaw, tenantRaw);
  return {
    agentId: parseAgent(agentRaw),
    tenantId: parseTenant(tenantRaw),
    sessionId: parseSession(sessionRaw),
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

describeOrSkip("deny flow end-to-end (integration)", () => {
  test(
    "forced deny → audit row + pending row → turn loop sees system_synthetic message",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId, tenantId, sessionId } = await setup(sql);

      // Force a deny via evaluateHook (stubs always approve; this simulates RELAY-138 deny).
      await evaluateHook(sql, clock, {
        hookId: "system/session-start/stub",
        layer: "system",
        event: "session_start",
        matcherResult: true,
        tenantId,
        agentId,
        sessionId,
        turnId: null,
        toolName: null,
        decide: () => Promise.resolve({ decision: "deny", reason: "depth exceeded" }),
      });

      // (a) Exactly one hook_audit row with full column set.
      const auditRows = await sql<
        {
          id: string;
          decision: string;
          reason: string;
          event: string;
          layer: string;
          hook_id: string;
          latency_ms: number;
        }[]
      >`
        SELECT id, decision, reason, event, layer, hook_id, latency_ms FROM hook_audit
      `;
      expect(auditRows.length).toBe(1);
      const auditRow = auditRows[0];
      assert(auditRow !== undefined, "expected audit row");
      expect(auditRow["decision"]).toBe("deny");
      expect(auditRow["reason"]).toBe("depth exceeded");
      expect(auditRow["event"]).toBe("session_start");
      expect(auditRow["layer"]).toBe("system");
      expect(auditRow["hook_id"]).toBe("system/session-start/stub");
      expect(auditRow["latency_ms"]).toBeGreaterThanOrEqual(0);

      // (b) Exactly one pending_system_messages row linked to the audit row.
      const pendingRows = await sql<
        {
          id: string;
          content: string;
          hook_audit_id: string;
          consumed_at: Date | null;
          consumed_by_turn: string | null;
        }[]
      >`
        SELECT id, content, hook_audit_id, consumed_at, consumed_by_turn FROM pending_system_messages
      `;
      expect(pendingRows.length).toBe(1);
      const pendingRow = pendingRows[0];
      assert(pendingRow !== undefined, "expected pending row");
      expect(pendingRow["hook_audit_id"]).toBe(auditRow["id"]);
      expect(pendingRow["content"]).toMatch(/^\[relay:hook_deny session_start\]/);
      expect(pendingRow["content"]).toContain("depth exceeded");
      expect(pendingRow["consumed_at"]).toBeNull();
      expect(pendingRow["consumed_by_turn"]).toBeNull();

      // (c) runTurnLoop receives a system_synthetic message carrying the deny reason.
      const capturedMessages: Message[][] = [];
      const fakeModel: ModelClient = {
        complete(params) {
          capturedMessages.push([...params.messages]);
          const r: ModelResponse = {
            content: [{ type: "text", text: "ok" }],
            stopReason: "end_turn",
            usage: { inputTokens: 5, outputTokens: 2 },
          };
          return Promise.resolve(r);
        },
      };

      const result = await runTurnLoop(
        { sql, clock, model: fakeModel, tools: new InMemoryToolRegistry([]) },
        {
          sessionId,
          agentId,
          tenantId,
          systemPrompt: "You are helpful.",
          initialMessages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        },
      );
      expect(result.ok).toBe(true);

      // The first model call should have the system_synthetic message prepended.
      const firstCall = capturedMessages[0];
      assert(firstCall !== undefined && firstCall.length >= 2, "expected at least 2 messages");
      const firstMsg = firstCall[0];
      assert(firstMsg !== undefined, "expected first message");
      expect(firstMsg.role).toBe("system_synthetic");
      const block = firstMsg.content[0];
      assert(block !== undefined, "expected text block");
      assert(block.type === "text", "expected text block to be text type");
      expect(block.text).toContain("depth exceeded");

      // After the turn, pending row should have consumed_by_turn set.
      const afterRows = await sql<{ consumed_at: Date | null; consumed_by_turn: string | null }[]>`
        SELECT consumed_at, consumed_by_turn FROM pending_system_messages
      `;
      const afterRow = afterRows[0];
      assert(afterRow !== undefined, "expected pending row after turn");
      expect(afterRow["consumed_at"]).toBeInstanceOf(Date);
      expect(afterRow["consumed_by_turn"]).not.toBeNull();
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "no pending messages: turn loop behaves as before (regression guard)",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId, tenantId, sessionId } = await setup(sql);

      const callCount = { n: 0 };
      const fakeModel: ModelClient = {
        complete() {
          callCount.n++;
          const r: ModelResponse = {
            content: [{ type: "text", text: "done" }],
            stopReason: "end_turn",
            usage: { inputTokens: 5, outputTokens: 2 },
          };
          return Promise.resolve(r);
        },
      };

      const result = await runTurnLoop(
        { sql, clock, model: fakeModel, tools: new InMemoryToolRegistry([]) },
        {
          sessionId,
          agentId,
          tenantId,
          systemPrompt: "sys",
          initialMessages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        },
      );

      expect(result.ok).toBe(true);
      expect(callCount.n).toBe(1);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "multiple pending rows drained in created_at order",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId, tenantId, sessionId } = await setup(sql);

      for (const reason of ["first deny", "second deny"]) {
        await evaluateHook(sql, clock, {
          hookId: "system/session-start/stub",
          layer: "system",
          event: "session_start",
          matcherResult: true,
          tenantId,
          agentId,
          sessionId,
          turnId: null,
          toolName: null,
          decide: () => Promise.resolve({ decision: "deny", reason }),
        });
      }

      const capturedMessages: Message[][] = [];
      const fakeModel: ModelClient = {
        complete(params) {
          capturedMessages.push([...params.messages]);
          return Promise.resolve({
            content: [{ type: "text", text: "done" }],
            stopReason: "end_turn",
            usage: { inputTokens: 5, outputTokens: 2 },
          });
        },
      };

      const result = await runTurnLoop(
        { sql, clock, model: fakeModel, tools: new InMemoryToolRegistry([]) },
        {
          sessionId,
          agentId,
          tenantId,
          systemPrompt: "sys",
          initialMessages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        },
      );
      expect(result.ok).toBe(true);

      const firstCall = capturedMessages[0];
      assert(firstCall !== undefined && firstCall.length >= 3, "expected at least 3 messages");
      const msg0 = firstCall[0];
      const msg1 = firstCall[1];
      assert(msg0 !== undefined && msg1 !== undefined, "expected two synthetic messages");
      assert(
        msg0.role === "system_synthetic" && msg1.role === "system_synthetic",
        "both should be synthetic",
      );
      const block0 = msg0.content[0];
      const block1 = msg1.content[0];
      assert(block0 !== undefined, "expected text block 0");
      assert(block0.type === "text", "expected text block 0 to be text type");
      assert(block1 !== undefined, "expected text block 1");
      assert(block1.type === "text", "expected text block 1 to be text type");
      expect(block0.text).toContain("first deny");
      expect(block1.text).toContain("second deny");
    },
    HOOK_TIMEOUT_MS,
  );
});
