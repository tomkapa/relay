// Unit tests for the boundary-dispatch phase of the turn loop (RELAY-146 follow-up).
// Covers:
//   1. Ask concentration when two asks target the same agent in one turn.
//   2. Notifies are NOT concentrated (each writes a distinct envelope).
//   3. Mixed ask + notify same target uses in-batch dedup, ledger row only for ask.
//   4. Concentrated content over MAX_MESSAGE_CONTENT_BYTES → dispatch_failed.
//   5. In-batch dedup across two distinct targets — second send to a seen target
//      routes via inbound_message rather than a fresh session_start.
//
// Uses a recording fake Sql that classifies each SQL string into a bucket so the
// assertions check observable behavior at the boundary (CLAUDE.md §3, §10).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { FakeClock } from "../../../src/core/clock.ts";
import { assert } from "../../../src/core/assert.ts";
import {
  AgentId as AgentIdParser,
  ChainId as ChainIdParser,
  Depth as DepthParser,
  SessionId as SessionIdParser,
  TenantId as TenantIdParser,
  ToolUseId,
} from "../../../src/ids.ts";
import type { AgentId, ChainId, Depth, SessionId, TenantId } from "../../../src/ids.ts";
import { __clearRegistryForTesting } from "../../../src/hook/registry.ts";
import type { ModelClient } from "../../../src/session/model.ts";
import type { Message, ModelResponse, ToolUseBlock } from "../../../src/session/turn.ts";
import { InMemoryToolRegistry } from "../../../src/session/tools-inmemory.ts";
import { runTurnLoop } from "../../../src/session/turn-loop.ts";
import { MAX_MESSAGE_CONTENT_BYTES } from "../../../src/trigger/limits.ts";

const baseInput: Message[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }];

function parseSession(raw: string): SessionId {
  const r = SessionIdParser.parse(raw);
  assert(r.ok, "test: invalid session id");
  return r.value;
}
function parseAgent(raw: string): AgentId {
  const r = AgentIdParser.parse(raw);
  assert(r.ok, "test: invalid agent id");
  return r.value;
}
function parseTenant(raw: string): TenantId {
  const r = TenantIdParser.parse(raw);
  assert(r.ok, "test: invalid tenant id");
  return r.value;
}
function makeIds(): { sessionId: SessionId; agentId: AgentId; tenantId: TenantId } {
  return {
    sessionId: parseSession(randomUUID()),
    agentId: parseAgent(randomUUID()),
    tenantId: parseTenant(randomUUID()),
  };
}
function makeChainAndDepth(): { chainId: ChainId; depth: Depth } {
  const c = ChainIdParser.parse(randomUUID());
  const d = DepthParser.parse(0);
  assert(c.ok && d.ok, "test: invalid chain/depth");
  return { chainId: c.value, depth: d.value };
}

type EnvelopeRec = { id: string; payload: Record<string, unknown> };
type WorkRec = { kind: string; payloadRef: string };
type PendingAskRec = { childSessionId: string; parentToolUseId: string };

type DispatchSqlOpts = {
  // For each call to findOpenChildSession (in order), the child id to return — null = none.
  readonly findOpenChildResponses?: readonly (string | null)[];
};

type DispatchSqlRecord = {
  envelopes: EnvelopeRec[];
  workItems: WorkRec[];
  pendingAsks: PendingAskRec[];
  findOpenChildCalls: { parentSessionId: string; targetAgentId: string }[];
};

function makeDispatchSql(
  tenantId: TenantId,
  opts: DispatchSqlOpts = {},
): {
  sql: Sql;
  rec: DispatchSqlRecord;
} {
  const rec: DispatchSqlRecord = {
    envelopes: [],
    workItems: [],
    pendingAsks: [],
    findOpenChildCalls: [],
  };
  const findResponses = [...(opts.findOpenChildResponses ?? [])];

  const fake = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const joined = strings.join("?");
    const first = strings[0] ?? "";

    // Hook audit / agent tenant lookups — tolerate as no-ops with the tenant.
    if (first.includes("SELECT tenant_id FROM agents")) {
      return Promise.resolve([{ tenant_id: tenantId }]);
    }
    if (first.includes("INSERT INTO hook_audit")) {
      return Promise.resolve([
        {
          id: randomUUID(),
          hook_id: "test/stub",
          layer: "system",
          event: "pre_message_send",
          matcher_result: true,
          decision: "approve",
          reason: null,
          latency_ms: 0,
          tenant_id: tenantId,
          session_id: null,
          agent_id: randomUUID(),
          turn_id: null,
          tool_name: null,
          created_at: new Date(),
        },
      ]);
    }

    // findOpenChildSession: SELECT id FROM sessions WHERE parent_session_id = ...
    if (joined.includes("SELECT id FROM sessions") && joined.includes("parent_session_id")) {
      const parentSessionId = String(values[0]);
      const targetAgentId = String(values[1]);
      rec.findOpenChildCalls.push({ parentSessionId, targetAgentId });
      const next = findResponses.shift() ?? null;
      return Promise.resolve(next === null ? [] : [{ id: next }]);
    }

    // Envelope insert (with explicit id) — capture id and payload.
    if (joined.includes("INSERT INTO trigger_envelopes")) {
      rec.envelopes.push({
        id: String(values[0]),
        payload: values[3] as Record<string, unknown>,
      });
      return Promise.resolve([]);
    }

    // Pending-ask insert — capture child + tool_use.
    if (joined.includes("INSERT INTO session_pending_asks")) {
      rec.pendingAsks.push({
        childSessionId: String(values[3]),
        parentToolUseId: String(values[4]),
      });
      return Promise.resolve([]);
    }

    // Work-queue enqueue: capture kind + payload_ref. Returns a row for success.
    // queue-ops binds: id, tenantId, kind, payloadRef, scheduledAt, traceparent.
    if (first.includes("WITH candidate AS")) {
      const k = values[2];
      const p = values[3];
      const kind = typeof k === "string" ? k : "";
      const payloadRef = typeof p === "string" ? p : "";
      rec.workItems.push({ kind, payloadRef });
      return Promise.resolve([{ id: randomUUID() }]);
    }

    return Promise.resolve([]);
  };

  Object.assign(fake, {
    json: (v: unknown) => v,
    begin: (fn: (tx: unknown) => Promise<unknown>) => fn(fake),
    unsafe: () => Promise.resolve([]),
  });

  return { sql: fake as unknown as Sql, rec };
}

function makeBlock(id: string, name: string, input: Record<string, unknown>): ToolUseBlock {
  const parsed = ToolUseId.parse(id);
  assert(parsed.ok, "test: invalid tool use id");
  return { type: "tool_use", id: parsed.value, name, input };
}

function multiBlockResponse(blocks: readonly ToolUseBlock[]): ModelResponse {
  return {
    content: blocks,
    stopReason: "tool_use",
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

beforeEach(() => {
  __clearRegistryForTesting();
});
afterEach(() => {
  __clearRegistryForTesting();
});

describe("dispatchBoundarySends — ask concentration & in-batch dedup (RELAY-146)", () => {
  test("two asks to same target → one envelope, one ledger row, one synthetic tool_result", async () => {
    const ids = makeIds();
    const cd = makeChainAndDepth();
    const targetAgentId = randomUUID();
    const blocks = [
      makeBlock("toolu_01", "ask", { target_agent_id: targetAgentId, content: "q1" }),
      makeBlock("toolu_02", "ask", { target_agent_id: targetAgentId, content: "q2" }),
    ];
    const model: ModelClient = { complete: () => Promise.resolve(multiBlockResponse(blocks)) };
    const tools = new InMemoryToolRegistry([]);
    const { sql, rec } = makeDispatchSql(ids.tenantId);
    const clock = new FakeClock(1_000_000);

    const result = await runTurnLoop(
      { sql, clock, model, tools, maxTurns: 10 },
      { ...ids, ...cd, systemPrompt: "sys", initialMessages: baseInput },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("suspended");
    if (result.value.kind !== "suspended") return;

    // Concentration: only ONE envelope written, ONE ledger row.
    expect(rec.envelopes).toHaveLength(1);
    expect(rec.pendingAsks).toHaveLength(1);
    expect(rec.workItems).toHaveLength(1);

    // The single envelope's content is "1. q1\n\n2. q2".
    const env = rec.envelopes[0];
    assert(env !== undefined, "expected envelope");
    expect(env.payload["content"]).toBe("1. q1\n\n2. q2");

    // Ledger row references the FIRST ask's tool_use_id.
    expect(rec.pendingAsks[0]?.parentToolUseId).toBe("toolu_01");

    // First-target dispatch is fresh — session_start (no prior open child).
    expect(rec.workItems[0]?.kind).toBe("session_start");

    // Persisted turn carries one synthetic tool_result for the merged-away ask.
    const turn = result.value.turns[0];
    assert(turn !== undefined, "expected turn");
    const synthetic = turn.toolResults.find((r) => (r.toolUseId as string) === "toolu_02");
    expect(synthetic).toBeDefined();
    expect(synthetic?.content).toContain("merged into toolu_01");
    expect(synthetic?.isError).toBe(false);
  });

  test("two notifies to same target → no concentration, two work items", async () => {
    const ids = makeIds();
    const cd = makeChainAndDepth();
    const targetAgentId = randomUUID();
    let callCount = 0;
    const blocks = [
      makeBlock("toolu_n1", "notify", { target_agent_id: targetAgentId, content: "m1" }),
      makeBlock("toolu_n2", "notify", { target_agent_id: targetAgentId, content: "m2" }),
    ];
    const model: ModelClient = {
      complete: () => {
        callCount++;
        // First call returns the two notifies; second returns end_turn so the loop completes.
        if (callCount === 1) return Promise.resolve(multiBlockResponse(blocks));
        return Promise.resolve({
          content: [{ type: "text", text: "done" }],
          stopReason: "end_turn",
          usage: { inputTokens: 5, outputTokens: 2 },
        });
      },
    };
    const tools = new InMemoryToolRegistry([]);
    const { sql, rec } = makeDispatchSql(ids.tenantId);
    const clock = new FakeClock(1_000_000);

    const result = await runTurnLoop(
      { sql, clock, model, tools, maxTurns: 10 },
      { ...ids, ...cd, systemPrompt: "sys", initialMessages: baseInput },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Two distinct envelopes/work items; no ledger rows (notify, not ask).
    expect(rec.envelopes).toHaveLength(2);
    expect(rec.workItems).toHaveLength(2);
    expect(rec.pendingAsks).toHaveLength(0);

    // First send → session_start (creates child); second → inbound_message (in-batch reuse).
    expect(rec.workItems[0]?.kind).toBe("session_start");
    expect(rec.workItems[1]?.kind).toBe("inbound_message");

    // Each notify carries its own content.
    const contents = rec.envelopes.map((e) => e.payload["content"]);
    expect(contents).toEqual(["m1", "m2"]);
  });

  test("ask + notify same target → first creates child, second uses inbound_message; ledger only for ask", async () => {
    const ids = makeIds();
    const cd = makeChainAndDepth();
    const targetAgentId = randomUUID();
    const blocks = [
      makeBlock("toolu_a1", "ask", { target_agent_id: targetAgentId, content: "q" }),
      makeBlock("toolu_n1", "notify", { target_agent_id: targetAgentId, content: "m" }),
    ];
    const model: ModelClient = { complete: () => Promise.resolve(multiBlockResponse(blocks)) };
    const tools = new InMemoryToolRegistry([]);
    const { sql, rec } = makeDispatchSql(ids.tenantId);
    const clock = new FakeClock(1_000_000);

    const result = await runTurnLoop(
      { sql, clock, model, tools, maxTurns: 10 },
      { ...ids, ...cd, systemPrompt: "sys", initialMessages: baseInput },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Ask suspends the turn.
    expect(result.value.kind).toBe("suspended");

    expect(rec.envelopes).toHaveLength(2);
    expect(rec.workItems).toHaveLength(2);

    // First (the ask) creates the child, second (the notify) routes via inbound_message.
    expect(rec.workItems[0]?.kind).toBe("session_start");
    expect(rec.workItems[1]?.kind).toBe("inbound_message");

    // Ledger row exists only for the ask.
    expect(rec.pendingAsks).toHaveLength(1);
    expect(rec.pendingAsks[0]?.parentToolUseId).toBe("toolu_a1");
  });

  test("concentrated content over MAX_MESSAGE_CONTENT_BYTES → dispatch_failed", async () => {
    const ids = makeIds();
    const cd = makeChainAndDepth();
    const targetAgentId = randomUUID();
    // Build content so that two parts joined together exceed the cap. Each part is just
    // under half the cap; the "1. …\n\n2. …" prefix and separator push us over.
    const half = "x".repeat(Math.floor(MAX_MESSAGE_CONTENT_BYTES / 2));
    const blocks = [
      makeBlock("toolu_big1", "ask", { target_agent_id: targetAgentId, content: half }),
      makeBlock("toolu_big2", "ask", { target_agent_id: targetAgentId, content: half }),
    ];
    const model: ModelClient = { complete: () => Promise.resolve(multiBlockResponse(blocks)) };
    const tools = new InMemoryToolRegistry([]);
    const { sql, rec } = makeDispatchSql(ids.tenantId);
    const clock = new FakeClock(1_000_000);

    const result = await runTurnLoop(
      { sql, clock, model, tools, maxTurns: 10 },
      { ...ids, ...cd, systemPrompt: "sys", initialMessages: baseInput },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("dispatch_failed");
    if (result.error.kind !== "dispatch_failed") return;
    expect(result.error.detail).toBe("concentrated_content_too_large");

    // No envelopes / pending_asks / work items written: concentration ran first.
    expect(rec.envelopes).toHaveLength(0);
    expect(rec.pendingAsks).toHaveLength(0);
    expect(rec.workItems).toHaveLength(0);
  });

  test("in-batch dedup across two targets: ask(B), ask(C), notify(B) → 2 children, 3 work items, B reuses", async () => {
    const ids = makeIds();
    const cd = makeChainAndDepth();
    const targetB = randomUUID();
    const targetC = randomUUID();
    const blocks = [
      makeBlock("toolu_aB", "ask", { target_agent_id: targetB, content: "qB" }),
      makeBlock("toolu_aC", "ask", { target_agent_id: targetC, content: "qC" }),
      makeBlock("toolu_nB", "notify", { target_agent_id: targetB, content: "mB" }),
    ];
    const model: ModelClient = { complete: () => Promise.resolve(multiBlockResponse(blocks)) };
    const tools = new InMemoryToolRegistry([]);
    const { sql, rec } = makeDispatchSql(ids.tenantId);
    const clock = new FakeClock(1_000_000);

    const result = await runTurnLoop(
      { sql, clock, model, tools, maxTurns: 10 },
      { ...ids, ...cd, systemPrompt: "sys", initialMessages: baseInput },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe("suspended");

    // Three envelopes (one per dispatch), three work items, two ledger rows (asks only).
    expect(rec.envelopes).toHaveLength(3);
    expect(rec.workItems).toHaveLength(3);
    expect(rec.pendingAsks).toHaveLength(2);

    // First two sends create fresh children (session_start); third (second to B) reuses
    // the in-batch child via inbound_message — no extra findOpenChildSession needed.
    expect(rec.workItems[0]?.kind).toBe("session_start");
    expect(rec.workItems[1]?.kind).toBe("session_start");
    expect(rec.workItems[2]?.kind).toBe("inbound_message");

    // findOpenChildSession is consulted twice (once per fresh target) — never for the
    // in-batch reuse path.
    expect(rec.findOpenChildCalls.length).toBe(2);

    // Ledger rows reference the two ask tool_use_ids only.
    const askIds = rec.pendingAsks.map((p) => p.parentToolUseId).sort();
    expect(askIds).toEqual(["toolu_aB", "toolu_aC"]);
  });
});
