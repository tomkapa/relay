// Integration tests for RELAY-146: session linking + lifecycle dichotomy.
// Covers child session reuse, pending-ask ledger, cascade close, tenant isolation.
// Requires INTEGRATION_DATABASE_URL — skipped when unset.

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { assert } from "../../../src/core/assert.ts";
import { FakeClock } from "../../../src/core/clock.ts";
import { migrate } from "../../../src/db/migrate-apply.ts";
import {
  AgentId,
  ChainId,
  Depth,
  SessionId,
  TenantId,
  ToolUseId,
  type AgentId as AgentIdBrand,
  type SessionId as SessionIdBrand,
  type TenantId as TenantIdBrand,
} from "../../../src/ids.ts";
import { findOpenChildSession } from "../../../src/session/find-open-child.ts";
import {
  writePendingAsk,
  readMostRecentUnresolved,
  markResolved,
  markCascadeOrphaned,
} from "../../../src/session/pending-asks.ts";
import { markSessionTerminal } from "../../../src/session/close.ts";
import { quiesceSession } from "../../../src/session/quiesce.ts";
import { runTurnLoop } from "../../../src/session/turn-loop.ts";
import { InMemoryToolRegistry } from "../../../src/session/tools-inmemory.ts";
import type { ModelClient } from "../../../src/session/model.ts";
import type { Message, ModelResponse, ToolUseBlock } from "../../../src/session/turn.ts";
import { readEnvelope } from "../../../src/trigger/envelope-ops.ts";
import { EnvelopeId } from "../../../src/ids.ts";
import { DB_URL, MIGRATIONS_DIR, describeOrSkip, resetDb } from "../helpers.ts";

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

function parseSessionId(raw: string): SessionIdBrand {
  const r = SessionId.parse(raw);
  assert(r.ok, "fixture: invalid SessionId");
  return r.value;
}

function parseAgentId(raw: string): AgentIdBrand {
  const r = AgentId.parse(raw);
  assert(r.ok, "fixture: invalid AgentId");
  return r.value;
}

async function insertAgent(sql: Sql, tenantId: TenantIdBrand): Promise<AgentIdBrand> {
  const raw = randomUUID();
  await sql`
    INSERT INTO agents (id, tenant_id, system_prompt)
    VALUES (${raw}, ${tenantId}, 'test agent')
  `;
  return parseAgentId(raw);
}

async function insertSession(
  sql: Sql,
  agentId: AgentIdBrand,
  tenantId: TenantIdBrand,
  parentSessionId: SessionIdBrand | null = null,
  chainId?: string,
): Promise<SessionIdBrand> {
  const raw = randomUUID();
  const chain = chainId ?? randomUUID();
  await sql`
    INSERT INTO sessions (id, agent_id, tenant_id, originating_trigger, parent_session_id, chain_id, depth, opening_user_content, created_at, updated_at)
    VALUES (${raw}, ${agentId}, ${tenantId}, '{"kind":"test"}'::jsonb, ${parentSessionId}, ${chain}, 0, 'test opening content', now(), now())
  `;
  return parseSessionId(raw);
}

describeOrSkip("session-linking integration (RELAY-146)", () => {
  beforeAll(async () => {
    assert(DB_URL !== undefined, "INTEGRATION_DATABASE_URL must be set");
    sqlRef = postgres(DB_URL, { max: 5 });
    await resetDb(requireSql());
    await migrate(requireSql(), MIGRATIONS_DIR);
  });

  afterAll(async () => {
    await sqlRef?.end();
  });

  beforeEach(async () => {
    await resetDb(requireSql());
    await migrate(requireSql(), MIGRATIONS_DIR);
  });

  afterEach(async () => {
    // Nothing to clean up beyond the per-test resetDb — handled in beforeEach.
  });

  test("findOpenChildSession returns null when no open child exists", async () => {
    const sql = requireSql();
    const tenantId = parseTenantId(randomUUID());
    const agentId = await insertAgent(sql, tenantId);
    const parentId = await insertSession(sql, agentId, tenantId);
    const childAgentId = await insertAgent(sql, tenantId);

    const result = await findOpenChildSession(sql, {
      parentSessionId: parentId,
      targetAgentId: childAgentId,
      tenantId,
    });

    expect(result).toBeNull();
  });

  test("findOpenChildSession returns child when open child exists", async () => {
    const sql = requireSql();
    const tenantId = parseTenantId(randomUUID());
    const agentId = await insertAgent(sql, tenantId);
    const chainId = randomUUID();
    const parentId = await insertSession(sql, agentId, tenantId, null, chainId);
    const childAgentId = await insertAgent(sql, tenantId);
    const childId = await insertSession(sql, childAgentId, tenantId, parentId, chainId);

    const result = await findOpenChildSession(sql, {
      parentSessionId: parentId,
      targetAgentId: childAgentId,
      tenantId,
    });

    expect(result).not.toBeNull();
    expect(result?.childSessionId).toBe(childId);
  });

  test("findOpenChildSession returns null for cross-tenant lookup", async () => {
    const sql = requireSql();
    const tenantA = parseTenantId(randomUUID());
    const tenantB = parseTenantId(randomUUID());
    const agentA = await insertAgent(sql, tenantA);
    const agentB = await insertAgent(sql, tenantB);
    const chainId = randomUUID();
    const parentId = await insertSession(sql, agentA, tenantA, null, chainId);
    const childAgentId = await insertAgent(sql, tenantA);
    await insertSession(sql, childAgentId, tenantA, parentId, chainId);

    // Look up with tenant B — should return null (isolation)
    const result = await findOpenChildSession(sql, {
      parentSessionId: parentId,
      targetAgentId: agentB,
      tenantId: tenantB,
    });

    expect(result).toBeNull();
  });

  test("findOpenChildSession returns null after child is closed (cascade_terminal)", async () => {
    const sql = requireSql();
    const clock = new FakeClock(Date.now());
    const tenantId = parseTenantId(randomUUID());
    const agentId = await insertAgent(sql, tenantId);
    const chainId = randomUUID();
    const parentId = await insertSession(sql, agentId, tenantId, null, chainId);
    const childAgentId = await insertAgent(sql, tenantId);
    const childId = await insertSession(sql, childAgentId, tenantId, parentId, chainId);

    await markSessionTerminal(sql, childId, new Date(clock.now()));

    const result = await findOpenChildSession(sql, {
      parentSessionId: parentId,
      targetAgentId: childAgentId,
      tenantId,
    });

    expect(result).toBeNull();
  });

  test("writePendingAsk then readMostRecentUnresolved returns the row", async () => {
    const sql = requireSql();
    const tenantId = parseTenantId(randomUUID());
    const agentId = await insertAgent(sql, tenantId);
    const chainId = randomUUID();
    const parentId = await insertSession(sql, agentId, tenantId, null, chainId);
    const childAgentId = await insertAgent(sql, tenantId);
    const childId = await insertSession(sql, childAgentId, tenantId, parentId, chainId);

    const toolUseIdResult = ToolUseId.parse("toolu_ask_01");
    assert(toolUseIdResult.ok, "fixture: invalid ToolUseId");
    const toolUseId = toolUseIdResult.value;

    await writePendingAsk(sql, {
      tenantId,
      parentSessionId: parentId,
      childSessionId: childId,
      parentToolUseId: toolUseId,
    });

    const row = await readMostRecentUnresolved(sql, childId);
    expect(row).not.toBeNull();
    expect(row?.parentToolUseId).toBe(toolUseId);
  });

  test("markResolved changes resolved_kind to reply_routed", async () => {
    const sql = requireSql();
    const tenantId = parseTenantId(randomUUID());
    const agentId = await insertAgent(sql, tenantId);
    const chainId = randomUUID();
    const parentId = await insertSession(sql, agentId, tenantId, null, chainId);
    const childAgentId = await insertAgent(sql, tenantId);
    const childId = await insertSession(sql, childAgentId, tenantId, parentId, chainId);

    const toolUseIdResult = ToolUseId.parse("toolu_ask_02");
    assert(toolUseIdResult.ok, "fixture: invalid ToolUseId");

    await writePendingAsk(sql, {
      tenantId,
      parentSessionId: parentId,
      childSessionId: childId,
      parentToolUseId: toolUseIdResult.value,
    });

    const pending = await readMostRecentUnresolved(sql, childId);
    assert(pending !== null, "pending ask must exist");

    await markResolved(sql, pending.id, "reply_routed", new Date());

    // After mark resolved, readMostRecentUnresolved returns null.
    const afterResolve = await readMostRecentUnresolved(sql, childId);
    expect(afterResolve).toBeNull();
  });

  test("markCascadeOrphaned marks all unresolved asks as cascade_orphan", async () => {
    const sql = requireSql();
    const tenantId = parseTenantId(randomUUID());
    const agentId = await insertAgent(sql, tenantId);
    const chainId = randomUUID();
    const parentId = await insertSession(sql, agentId, tenantId, null, chainId);
    const childAgentId = await insertAgent(sql, tenantId);
    const childId = await insertSession(sql, childAgentId, tenantId, parentId, chainId);

    const toolUseIdResult = ToolUseId.parse("toolu_ask_03");
    assert(toolUseIdResult.ok, "fixture: invalid ToolUseId");

    await writePendingAsk(sql, {
      tenantId,
      parentSessionId: parentId,
      childSessionId: childId,
      parentToolUseId: toolUseIdResult.value,
    });

    await markCascadeOrphaned(sql, childId, new Date());

    const rows = await sql<{ resolved_kind: string }[]>`
      SELECT resolved_kind FROM session_pending_asks
      WHERE child_session_id = ${childId}
    `;
    expect(rows.length).toBe(1);
    const row = rows[0];
    assert(row !== undefined, "row must exist");
    expect(row.resolved_kind).toBe("cascade_orphan");
  });

  test("markSessionTerminal sets closed_at and orphans pending asks", async () => {
    const sql = requireSql();
    const clock = new FakeClock(Date.now());
    const tenantId = parseTenantId(randomUUID());
    const agentId = await insertAgent(sql, tenantId);
    const chainId = randomUUID();
    const parentId = await insertSession(sql, agentId, tenantId, null, chainId);
    const childAgentId = await insertAgent(sql, tenantId);
    const childId = await insertSession(sql, childAgentId, tenantId, parentId, chainId);

    const toolUseIdResult = ToolUseId.parse("toolu_ask_04");
    assert(toolUseIdResult.ok, "fixture: invalid ToolUseId");

    await writePendingAsk(sql, {
      tenantId,
      parentSessionId: parentId,
      childSessionId: childId,
      parentToolUseId: toolUseIdResult.value,
    });

    const closedAt = new Date(clock.now());
    const marked = await markSessionTerminal(sql, childId, closedAt);
    expect(marked).toBe(true);

    // Session should now be closed
    const rows = await sql<{ closed_at: Date | null }[]>`
      SELECT closed_at FROM sessions WHERE id = ${childId}
    `;
    const row = rows[0];
    assert(row !== undefined, "session must exist");
    expect(row.closed_at).not.toBeNull();

    // Pending ask should be orphaned
    const askRows = await sql<{ resolved_kind: string }[]>`
      SELECT resolved_kind FROM session_pending_asks
      WHERE child_session_id = ${childId}
    `;
    const askRow = askRows[0];
    assert(askRow !== undefined, "ask row must exist");
    expect(askRow.resolved_kind).toBe("cascade_orphan");
  });

  test("markSessionTerminal is idempotent — returns false on second call", async () => {
    const sql = requireSql();
    const clock = new FakeClock(Date.now());
    const tenantId = parseTenantId(randomUUID());
    const agentId = await insertAgent(sql, tenantId);
    const childId = await insertSession(sql, agentId, tenantId);

    const now = new Date(clock.now());
    const first = await markSessionTerminal(sql, childId, now);
    const second = await markSessionTerminal(sql, childId, now);

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  test("quiesceSession returns session_not_found for unknown session", async () => {
    const sql = requireSql();
    const clock = new FakeClock(Date.now());
    const tenantId = parseTenantId(randomUUID());
    const agentId = parseAgentId(randomUUID());
    const sessionId = parseSessionId(randomUUID());
    const chainIdResult = ChainId.parse(randomUUID());
    const depthResult = Depth.parse(1);
    assert(chainIdResult.ok && depthResult.ok, "fixture: invalid chain/depth");

    const result = await quiesceSession(sql, clock, {
      sessionId,
      tenantId,
      agentId,
      chainId: chainIdResult.value,
      depth: depthResult.value,
      reason: { kind: "loop_end_no_pending" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("session_not_found");
  });

  test("quiesceSession succeeds for open child session with no pending ask", async () => {
    const sql = requireSql();
    const clock = new FakeClock(Date.now());
    const tenantId = parseTenantId(randomUUID());
    const agentId = await insertAgent(sql, tenantId);
    const chainId = randomUUID();
    const parentId = await insertSession(sql, agentId, tenantId, null, chainId);
    const childAgentId = await insertAgent(sql, tenantId);
    const childId = await insertSession(sql, childAgentId, tenantId, parentId, chainId);
    const chainIdResult = ChainId.parse(chainId);
    const depthResult = Depth.parse(1);
    assert(chainIdResult.ok && depthResult.ok, "fixture: invalid chain/depth");

    const result = await quiesceSession(sql, clock, {
      sessionId: childId,
      tenantId,
      agentId: childAgentId,
      chainId: chainIdResult.value,
      depth: depthResult.value,
      reason: { kind: "loop_end_no_pending" },
    });

    expect(result.ok).toBe(true);

    // Child session should NOT have closed_at set (quiescence is not a close).
    const rows = await sql<{ closed_at: Date | null }[]>`
      SELECT closed_at FROM sessions WHERE id = ${childId}
    `;
    const row = rows[0];
    assert(row !== undefined, "session must exist");
    expect(row.closed_at).toBeNull();
  });

  test("sessions_open_child_uniq prevents two open children for same (parent, agent)", async () => {
    const sql = requireSql();
    const tenantId = parseTenantId(randomUUID());
    const agentId = await insertAgent(sql, tenantId);
    const chainId = randomUUID();
    const parentId = await insertSession(sql, agentId, tenantId, null, chainId);
    const childAgentId = await insertAgent(sql, tenantId);

    // First child insert succeeds
    await insertSession(sql, childAgentId, tenantId, parentId, chainId);

    // Second child insert with same parent and agent should fail
    let threw = false;
    try {
      await insertSession(sql, childAgentId, tenantId, parentId, chainId);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("two asks same target same turn → one combined envelope + one ledger row + synthetic tool_result", async () => {
    const sql = requireSql();
    const clock = new FakeClock(Date.now());
    const tenantId = parseTenantId(randomUUID());
    const parentAgentId = await insertAgent(sql, tenantId);
    const targetAgentId = await insertAgent(sql, tenantId);
    const chainIdRaw = randomUUID();
    const parentSessionId = await insertSession(sql, parentAgentId, tenantId, null, chainIdRaw);
    // Pre-create the child session so the pending_asks FK to sessions.id is satisfied
    // when the producer writes the ledger row. Dispatch path here is in-batch reuse:
    // first ask finds an open child, second ask is concentrated into the first.
    await insertSession(sql, targetAgentId, tenantId, parentSessionId, chainIdRaw);

    const chainIdResult = ChainId.parse(chainIdRaw);
    const depthResult = Depth.parse(0);
    assert(chainIdResult.ok && depthResult.ok, "fixture: invalid chain/depth");

    // Model emits two ask blocks to the same target in one turn.
    const tu1 = ToolUseId.parse("toolu_two_asks_1");
    const tu2 = ToolUseId.parse("toolu_two_asks_2");
    assert(tu1.ok && tu2.ok, "fixture: invalid tool_use_id");

    const blocks: ToolUseBlock[] = [
      {
        type: "tool_use",
        id: tu1.value,
        name: "ask",
        input: { target_agent_id: targetAgentId, content: "first question" },
      },
      {
        type: "tool_use",
        id: tu2.value,
        name: "ask",
        input: { target_agent_id: targetAgentId, content: "second question" },
      },
    ];
    const response: ModelResponse = {
      content: blocks,
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const model: ModelClient = { complete: () => Promise.resolve(response) };
    const tools = new InMemoryToolRegistry([]);
    const baseMessages: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];

    const result = await runTurnLoop(
      { sql, clock, model, tools, maxTurns: 5 },
      {
        sessionId: parentSessionId,
        agentId: parentAgentId,
        tenantId,
        chainId: chainIdResult.value,
        depth: depthResult.value,
        systemPrompt: "sys",
        initialMessages: baseMessages,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("suspended");
    if (result.value.kind !== "suspended") return;

    // Exactly ONE envelope written for the concentrated ask.
    const envRows = await sql<{ id: string; payload: { content: string } }[]>`
      SELECT id, payload FROM trigger_envelopes WHERE tenant_id = ${tenantId}
    `;
    expect(envRows).toHaveLength(1);
    const envRow = envRows[0];
    assert(envRow !== undefined, "envelope row must exist");

    // Sanity-check via the typed reader as well.
    const envIdResult = EnvelopeId.parse(envRow.id);
    assert(envIdResult.ok, "envelope id must parse");
    const env = await readEnvelope(sql, envIdResult.value);
    expect(env.ok).toBe(true);

    // Combined content carries both questions, numbered.
    expect(envRow.payload.content).toBe("1. first question\n\n2. second question");

    // ONE ledger row, referencing the FIRST ask's tool_use_id.
    const askRows = await sql<{ parent_tool_use_id: string }[]>`
      SELECT parent_tool_use_id FROM session_pending_asks
      WHERE parent_session_id = ${parentSessionId}
    `;
    expect(askRows).toHaveLength(1);
    expect(askRows[0]?.parent_tool_use_id).toBe("toolu_two_asks_1");

    // The persisted parent turn carries the synthetic merged-pointer tool_result for tu2.
    const turnRows = await sql<{ tool_results: { toolUseId: string; content: string }[] }[]>`
      SELECT tool_results FROM turns WHERE session_id = ${parentSessionId}
    `;
    expect(turnRows).toHaveLength(1);
    const persisted = turnRows[0]?.tool_results ?? [];
    const synthetic = persisted.find((r) => r.toolUseId === "toolu_two_asks_2");
    expect(synthetic).toBeDefined();
    expect(synthetic?.content).toContain("merged into toolu_two_asks_1");
  });

  test("two distinct chains do not share child sessions", async () => {
    const sql = requireSql();
    const tenantId = parseTenantId(randomUUID());
    const agentId = await insertAgent(sql, tenantId);
    const chainA = randomUUID();
    const chainB = randomUUID();
    const parentA = await insertSession(sql, agentId, tenantId, null, chainA);
    const parentB = await insertSession(sql, agentId, tenantId, null, chainB);
    const childAgentId = await insertAgent(sql, tenantId);

    // Insert child under chain A
    const childA = await insertSession(sql, childAgentId, tenantId, parentA, chainA);

    // Lookup from chain B's parent should return null
    const result = await findOpenChildSession(sql, {
      parentSessionId: parentB,
      targetAgentId: childAgentId,
      tenantId,
    });

    expect(result).toBeNull();

    // But lookup from chain A's parent should return childA
    const resultA = await findOpenChildSession(sql, {
      parentSessionId: parentA,
      targetAgentId: childAgentId,
      tenantId,
    });

    expect(resultA?.childSessionId).toBe(childA);
  });
});
