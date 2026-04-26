// Integration tests for loadResumeInput multi-cycle replay (RELAY-232).
// Real Postgres per CLAUDE.md §3. Skipped when INTEGRATION_DATABASE_URL is unset.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { assert } from "../../../src/core/assert.ts";
import { migrate } from "../../../src/db/migrate-apply.ts";
import { InboundMessageId, ToolUseId } from "../../../src/ids.ts";
import type { AgentId, SessionId, TenantId } from "../../../src/ids.ts";
import { loadResumeInput } from "../../../src/session/load-resume.ts";
import {
  DB_URL,
  MIGRATIONS_DIR,
  describeOrSkip,
  insertAgent,
  insertSession,
  makeIds,
  resetDb,
} from "../helpers.ts";

let sqlRef: Sql | undefined;

// Produces a timestamp offset ms into the past from "~60 seconds ago", giving stable
// relative ordering without relying on wall-clock progression during test execution.
const relativeTs = (ms: number): Date => new Date(Date.now() - 60_000 + ms);

function requireSql(): Sql {
  assert(sqlRef !== undefined, "integration test: sql must be initialized by beforeAll");
  return sqlRef;
}

beforeAll(async () => {
  if (!DB_URL) return;
  const s = postgres(DB_URL, { max: 4, idle_timeout: 2 });
  await s`SELECT 1`;
  await resetDb(s);
  const mig = await migrate(s, MIGRATIONS_DIR);
  if (!mig.ok) throw new Error(`migration failed: ${mig.error.kind}`);
  sqlRef = s;
}, 30_000);

afterAll(async () => {
  if (sqlRef !== undefined) await sqlRef.end({ timeout: 5 });
}, 10_000);

afterEach(async () => {
  if (!DB_URL) return;
  const s = requireSql();
  await s.unsafe(`TRUNCATE TABLE inbound_messages, turns, sessions, agents CASCADE`);
});

// Fixture types for turn content — must be JSON-serializable so sql.json() accepts them.
type FixtureBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: Record<string, string>;
    };
type FixtureToolResult = {
  readonly type: "tool_result";
  readonly toolUseId: string;
  readonly content: string;
};

// Inserts a completed turn row.
async function insertTurn(
  sql: Sql,
  opts: {
    sessionId: SessionId;
    agentId: AgentId;
    tenantId: TenantId;
    turnIndex: number;
    startedAt: Date;
    completedAt: Date;
    responseContent: readonly FixtureBlock[];
    toolResults?: readonly FixtureToolResult[];
  },
): Promise<void> {
  const id = randomUUID();
  const response = sql.json({
    content: opts.responseContent,
    stopReason: "tool_use",
    usage: { inputTokens: 5, outputTokens: 3 },
  });
  const toolResults = sql.json(opts.toolResults ?? []);
  const usage = sql.json({ inputTokens: 5, outputTokens: 3 });
  await sql`
    INSERT INTO turns (id, session_id, tenant_id, agent_id, turn_index, started_at, completed_at, response, tool_results, usage)
    VALUES (${id}, ${opts.sessionId}, ${opts.tenantId}, ${opts.agentId}, ${opts.turnIndex},
            ${opts.startedAt}, ${opts.completedAt}, ${response}, ${toolResults}, ${usage})
  `;
}

// Inserts an inbound_messages row and returns its id.
async function insertInbound(
  sql: Sql,
  opts: {
    tenantId: TenantId;
    targetSessionId: SessionId;
    content: string;
    receivedAt: Date;
    sourceToolUseId?: string;
  },
): Promise<string> {
  const id = randomUUID();
  const sourceToolUseId = opts.sourceToolUseId ?? null;
  await sql`
    INSERT INTO inbound_messages (id, tenant_id, target_session_id, sender_type, sender_id, kind, content, received_at, source_tool_use_id)
    VALUES (${id}, ${opts.tenantId}, ${opts.targetSessionId}, 'human', 'test-sender', 'message',
            ${opts.content}, ${opts.receivedAt}, ${sourceToolUseId})
  `;
  return id;
}

describeOrSkip("loadResumeInput integration — multi-cycle (RELAY-232)", () => {
  test("3-turn session: asks across turns are all paired correctly", async () => {
    const sql = requireSql();
    const { agentId, tenantId } = makeIds();
    const sessionIdStr = randomUUID();
    const sessionIdResult = await import("../../../src/ids.ts").then((m) =>
      m.SessionId.parse(sessionIdStr),
    );
    assert(sessionIdResult.ok, "test: sessionId parse failed");
    const sessionId = sessionIdResult.value;

    await insertAgent(sql, agentId, tenantId);
    await insertSession(sql, sessionId, agentId, tenantId);

    const U1 = "toolu_ask_u1_integ";
    const U2 = "toolu_notify_u2_integ";
    const U3 = "toolu_ask_u3_integ";

    const t = relativeTs;

    // Turn 0: ask(U1), suspended
    await insertTurn(sql, {
      sessionId,
      agentId,
      tenantId,
      turnIndex: 0,
      startedAt: t(0),
      completedAt: t(1_000),
      responseContent: [{ type: "tool_use", id: U1, name: "ask", input: {} }],
      toolResults: [],
    });

    // Turn 1: notify(U2), result stored inline
    await insertTurn(sql, {
      sessionId,
      agentId,
      tenantId,
      turnIndex: 1,
      startedAt: t(10_000),
      completedAt: t(11_000),
      responseContent: [{ type: "tool_use", id: U2, name: "notify", input: {} }],
      toolResults: [{ type: "tool_result", toolUseId: U2, content: "<dispatched>" }],
    });

    // Turn 2: ask(U3), suspended — this is the turn being resumed now
    await insertTurn(sql, {
      sessionId,
      agentId,
      tenantId,
      turnIndex: 2,
      startedAt: t(20_000),
      completedAt: t(21_000),
      responseContent: [{ type: "tool_use", id: U3, name: "ask", input: {} }],
      toolResults: [],
    });

    // Inbound R1: reply to U1 (arrived between turn 0 and turn 1)
    await insertInbound(sql, {
      tenantId,
      targetSessionId: sessionId,
      content: "reply to u1",
      receivedAt: t(5_000),
      sourceToolUseId: U1,
    });

    // Inbound R2: reply to U3 (current trigger — arrived after turn 2)
    await insertInbound(sql, {
      tenantId,
      targetSessionId: sessionId,
      content: "reply to u3",
      receivedAt: t(30_000),
      sourceToolUseId: U3,
    });

    const u3Result = ToolUseId.parse(U3);
    assert(u3Result.ok, "test: ToolUseId parse failed");
    const inboundIdResult = InboundMessageId.parse(randomUUID());
    assert(inboundIdResult.ok, "test: InboundMessageId parse failed");

    const result = await loadResumeInput(sql, {
      sessionId,
      tenantId,
      agentSystemPrompt: "System prompt",
      inboundContent: "reply to u3",
      inboundMessageId: inboundIdResult.value,
      sourceToolUseId: u3Result.value,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const msgs = result.value.initialMessages;
    // [0] user: opening ("test opening content" from insertSession)
    // [1] assistant: turn 0 (ask U1)
    // [2] user: tool_result(U1, "reply to u1")
    // [3] assistant: turn 1 (notify U2)
    // [4] user: tool_result(U2, "<dispatched>")
    // [5] assistant: turn 2 (ask U3)
    // [6] user: tool_result(U3, "reply to u3")
    expect(msgs).toHaveLength(7);
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[1]?.role).toBe("assistant");

    const tr0 = msgs[2]?.content[0];
    expect(tr0?.type).toBe("tool_result");
    if (tr0?.type === "tool_result") {
      expect(tr0.toolUseId as string).toBe(U1);
      expect(tr0.content).toBe("reply to u1");
    }

    expect(msgs[3]?.role).toBe("assistant");
    const tr1 = msgs[4]?.content[0];
    expect(tr1?.type).toBe("tool_result");
    if (tr1?.type === "tool_result") {
      expect(tr1.toolUseId as string).toBe(U2);
      expect(tr1.content).toBe("<dispatched>");
    }

    expect(msgs[5]?.role).toBe("assistant");
    const tr2 = msgs[6]?.content[0];
    expect(tr2?.type).toBe("tool_result");
    if (tr2?.type === "tool_result") {
      expect(tr2.toolUseId as string).toBe(U3);
      expect(tr2.content).toBe("reply to u3");
    }

    expect(result.value.startTurnIndex).toBe(3);
  });

  test("fresh inbound between turns: unpaired inbound in correct position", async () => {
    const sql = requireSql();
    const { agentId, tenantId } = makeIds();
    const sessionIdStr = randomUUID();
    const sessionIdResult = await import("../../../src/ids.ts").then((m) =>
      m.SessionId.parse(sessionIdStr),
    );
    assert(sessionIdResult.ok, "test: sessionId parse");
    const sessionId = sessionIdResult.value;

    await insertAgent(sql, agentId, tenantId);
    await insertSession(sql, sessionId, agentId, tenantId);

    const U1 = "toolu_ask_fresh_u1";
    const t = relativeTs;

    // Turn 0: ask(U1)
    await insertTurn(sql, {
      sessionId,
      agentId,
      tenantId,
      turnIndex: 0,
      startedAt: t(0),
      completedAt: t(1_000),
      responseContent: [{ type: "tool_use", id: U1, name: "ask", input: {} }],
      toolResults: [],
    });

    // Turn 1: plain text, end_turn
    await insertTurn(sql, {
      sessionId,
      agentId,
      tenantId,
      turnIndex: 1,
      startedAt: t(8_000),
      completedAt: t(9_000),
      responseContent: [{ type: "text", text: "noted" }],
      toolResults: [],
    });

    // Reply to U1 (between turn 0 and turn 1)
    await insertInbound(sql, {
      tenantId,
      targetSessionId: sessionId,
      content: "reply to u1",
      receivedAt: t(3_000),
      sourceToolUseId: U1,
    });
    // Fresh nudge (between turn 0 and turn 1, no source_tool_use_id)
    await insertInbound(sql, {
      tenantId,
      targetSessionId: sessionId,
      content: "fresh nudge",
      receivedAt: t(4_000),
    });
    // Current trigger (after turn 1)
    await insertInbound(sql, {
      tenantId,
      targetSessionId: sessionId,
      content: "trigger",
      receivedAt: t(12_000),
    });

    const inboundIdResult = InboundMessageId.parse(randomUUID());
    assert(inboundIdResult.ok, "test");

    const result = await loadResumeInput(sql, {
      sessionId,
      tenantId,
      agentSystemPrompt: "System prompt",
      inboundContent: "trigger",
      inboundMessageId: inboundIdResult.value,
      sourceToolUseId: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const msgs = result.value.initialMessages;
    // [0] opening
    // [1] assistant turn 0 (ask U1)
    // [2] user tool_result(U1, "reply to u1")
    // [3] user plain "fresh nudge" (unpaired, between turn 0 and turn 1)
    // [4] assistant turn 1 ("noted")
    // [5] user plain "trigger" (current inbound, after turn 1)
    expect(msgs).toHaveLength(6);

    const tr = msgs[2]?.content[0];
    expect(tr?.type).toBe("tool_result");
    if (tr?.type === "tool_result") expect(tr.content).toBe("reply to u1");

    const nudge = msgs[3]?.content[0];
    expect(nudge?.type === "text" && nudge.text).toBe("fresh nudge");

    expect(msgs[4]?.role).toBe("assistant");
    const trigger = msgs[5]?.content[0];
    expect(trigger?.type === "text" && trigger.text).toBe("trigger");
  });
});
