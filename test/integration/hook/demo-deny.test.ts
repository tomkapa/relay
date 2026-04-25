// Demo-deny integration test: a synthetic pre_tool_use deny hook registered via the
// registry → runHooks denies → audit row + pending message → next turn sees the
// synthetic system message. This is RELAY-138's own end-to-end proof (not the
// RELAY-108 release-gate demo which uses a real-world deny condition).

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { assert } from "../../../src/core/assert.ts";
import { FakeClock } from "../../../src/core/clock.ts";
import { migrate } from "../../../src/db/migrate-apply.ts";
import { __clearRegistryForTesting, registerHook } from "../../../src/hook/registry.ts";
import { HOOK_EVENT } from "../../../src/hook/types.ts";
import { AgentId, HookRecordId, SessionId, TenantId, ToolUseId } from "../../../src/ids.ts";
import type {
  AgentId as AgentIdType,
  SessionId as SessionIdType,
  TenantId as TenantIdType,
} from "../../../src/ids.ts";
import type { ModelClient } from "../../../src/session/model.ts";
import type { Message, ModelResponse } from "../../../src/session/turn.ts";
import { InMemoryToolRegistry, echoTool } from "../../../src/session/tools-inmemory.ts";
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
  const a = AgentId.parse(agentRaw);
  const t = TenantId.parse(tenantRaw);
  const s = SessionId.parse(sessionRaw);
  assert(a.ok && t.ok && s.ok, "demo-deny: fixture id parse failed");
  return { agentId: a.value, tenantId: t.value, sessionId: s.value };
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
  __clearRegistryForTesting();
});

afterEach(() => {
  __clearRegistryForTesting();
});

describeOrSkip("demo-deny: pre_tool_use deny → audit → pending → synthetic message", () => {
  test(
    "deny hook: audit row + pending message + tool_result isError + next-turn synthetic message",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId, tenantId, sessionId } = await setup(sql);

      const denyIdResult = HookRecordId.parse("system/pre_tool_use/demo-deny");
      assert(denyIdResult.ok, "demo-deny: hook id parse failed");

      registerHook({
        id: denyIdResult.value,
        layer: "system",
        event: HOOK_EVENT.PreToolUse,
        matcher: () => true,
        decision: () => Promise.resolve({ decision: "deny", reason: "test deny" }),
      });

      const toolIdResult = ToolUseId.parse("toolu_demo01");
      assert(toolIdResult.ok, "demo-deny: tool_use_id parse failed");
      const toolId = toolIdResult.value;

      const capturedMessages: Message[][] = [];
      let callCount = 0;
      const fakeModel: ModelClient = {
        complete(params) {
          callCount++;
          capturedMessages.push([...params.messages]);
          if (callCount === 1) {
            const r: ModelResponse = {
              content: [{ type: "tool_use", id: toolId, name: "echo", input: { text: "hello" } }],
              stopReason: "tool_use",
              usage: { inputTokens: 5, outputTokens: 3 },
            };
            return Promise.resolve(r);
          }
          return Promise.resolve({
            content: [{ type: "text", text: "done" }],
            stopReason: "end_turn",
            usage: { inputTokens: 5, outputTokens: 2 },
          });
        },
      };

      const tools = new InMemoryToolRegistry([echoTool]);
      const result = await runTurnLoop(
        { sql, clock, model: fakeModel, tools },
        {
          sessionId,
          agentId,
          tenantId,
          systemPrompt: "You are helpful.",
          initialMessages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        },
      );

      expect(result.ok).toBe(true);

      // (a) Exactly 1 hook_audit row with decision=deny.
      const auditRows = await sql<{ id: string; decision: string; reason: string }[]>`
        SELECT id, decision, reason FROM hook_audit
      `;
      expect(auditRows.length).toBe(1);
      const auditRow = auditRows[0];
      assert(auditRow !== undefined, "expected audit row");
      expect(auditRow.decision).toBe("deny");
      expect(auditRow.reason).toBe("test deny");

      // (b) Exactly 1 pending_system_messages row linked to the audit row.
      const pendingRows = await sql<{ id: string; content: string; hook_audit_id: string }[]>`
        SELECT id, content, hook_audit_id FROM pending_system_messages
      `;
      expect(pendingRows.length).toBe(1);
      const pendingRow = pendingRows[0];
      assert(pendingRow !== undefined, "expected pending row");
      expect(pendingRow.hook_audit_id).toBe(auditRow.id);
      expect(pendingRow.content).toMatch(/^\[relay:hook_deny pre_tool_use\[echo\]\]/);
      expect(pendingRow.content).toContain("test deny");

      // (c) Two model calls happened (tool_use turn, then a recovery turn after deny).
      expect(callCount).toBeGreaterThanOrEqual(2);

      // (d) The second turn's model call sees a system_synthetic message from the drain.
      const secondCallMessages = capturedMessages[1];
      assert(secondCallMessages !== undefined, "expected second model call messages");
      const syntheticMsg = secondCallMessages.find((m) => m.role === "system_synthetic");
      assert(syntheticMsg !== undefined, "expected system_synthetic message in second turn input");
      const block = syntheticMsg.content[0];
      assert(block !== undefined, "expected content block");
      assert(block.type === "text", "expected text block");
      expect(block.text).toContain("test deny");
    },
    HOOK_TIMEOUT_MS,
  );
});
