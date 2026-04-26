// Integration tests for notify() tool end-to-end. Real Postgres per CLAUDE.md §3.
// Skipped when INTEGRATION_DATABASE_URL is unset so `bun test` stays green locally.
// RELAY-145.

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { assert } from "../../../src/core/assert.ts";
import { FakeClock } from "../../../src/core/clock.ts";
import { migrate } from "../../../src/db/migrate-apply.ts";
import {
  ChainId as ChainIdParser,
  Depth,
  HookRecordId,
  SessionId as SessionIdParser,
  ToolUseId,
} from "../../../src/ids.ts";
import type { AgentId, ChainId, SessionId, TenantId } from "../../../src/ids.ts";
import type { ModelClient } from "../../../src/session/model.ts";
import { InMemoryToolRegistry, notifyTool } from "../../../src/session/tools-inmemory.ts";
import { runTurnLoop } from "../../../src/session/turn-loop.ts";
import type { Message, ModelResponse, ToolUseBlock } from "../../../src/session/turn.ts";
import { ASK_TOOL_NAME, NOTIFY_TOOL_NAME } from "../../../src/session/builtin-tools.ts";
import { __clearRegistryForTesting, registerHook } from "../../../src/hook/registry.ts";
import { HOOK_EVENT } from "../../../src/hook/types.ts";
import {
  DB_URL,
  HOOK_TIMEOUT_MS,
  MIGRATIONS_DIR,
  describeOrSkip,
  makeIds,
  resetDb,
} from "../helpers.ts";
import {
  installMetricFixture,
  sumCounter,
  type MetricFixture,
  uninstallMetricFixture,
} from "../../helpers/metrics.ts";

let sqlRef: Sql | undefined;

function requireSql(): Sql {
  assert(sqlRef !== undefined, "integration test: sql initialized by beforeAll");
  return sqlRef;
}

async function insertAgent(sql: Sql, agentId: AgentId, tenantId: TenantId): Promise<void> {
  await sql`
    INSERT INTO agents (id, tenant_id, system_prompt)
    VALUES (${agentId}, ${tenantId}, 'test agent')
  `;
}

async function insertSession(
  sql: Sql,
  agentId: AgentId,
  tenantId: TenantId,
  chainId: ChainId,
): Promise<SessionId> {
  const raw = randomUUID();
  await sql`
    INSERT INTO sessions (id, agent_id, tenant_id, originating_trigger, chain_id, depth, opening_user_content, created_at, updated_at)
    VALUES (${raw}, ${agentId}, ${tenantId}, '{"kind":"test"}'::jsonb, ${chainId}, 0, 'test content', now(), now())
  `;
  const r = SessionIdParser.parse(raw);
  assert(r.ok, "insertSession: invalid UUID");
  return r.value;
}

function makeChainId(): ChainId {
  const r = ChainIdParser.parse(randomUUID());
  assert(r.ok, "makeChainId: invalid UUID");
  return r.value;
}

function makeDepth0() {
  const r = Depth.parse(0);
  assert(r.ok, "makeDepth0: 0 out of range");
  return r.value;
}

function makeHookId(tag: string) {
  const r = HookRecordId.parse(tag);
  assert(r.ok, "makeHookId: invalid HookRecordId");
  return r.value;
}

function textResponse(text: string): ModelResponse {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

function notifyResponse(toolUseId: string, targetAgentId: AgentId, content: string): ModelResponse {
  const parsed = ToolUseId.parse(toolUseId);
  assert(parsed.ok, "notifyResponse: invalid toolUseId");
  const block: ToolUseBlock = {
    type: "tool_use",
    id: parsed.value,
    name: NOTIFY_TOOL_NAME,
    input: { target_agent_id: targetAgentId, content },
  };
  return {
    content: [block],
    stopReason: "tool_use",
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

const baseMessages: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }];

const tools = new InMemoryToolRegistry([notifyTool]);

let fixture: MetricFixture;

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
  await requireSql()`TRUNCATE TABLE turns, sessions, trigger_envelopes, work_queue, agents CASCADE`;
  __clearRegistryForTesting();
  fixture = installMetricFixture();
});

afterEach(async () => {
  __clearRegistryForTesting();
  await uninstallMetricFixture();
});

describeOrSkip("notify integration (real Postgres)", () => {
  test(
    "notify_dispatchesAndContinues: notify produces <dispatched> tool_result and session ends",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId: agentA, tenantId } = makeIds();
      const { agentId: agentB } = makeIds();
      const chainId = makeChainId();
      const depth = makeDepth0();

      await insertAgent(sql, agentA, tenantId);
      await insertAgent(sql, agentB, tenantId);
      const sessionId = await insertSession(sql, agentA, tenantId, chainId);

      const responses: ModelResponse[] = [
        notifyResponse("notify_tool_use_id_1", agentB, "hello B"),
        textResponse("all done"),
      ];
      const model: ModelClient = { complete: () => Promise.resolve(responses.shift()!) };

      const result = await runTurnLoop(
        { sql, clock, model, tools },
        {
          sessionId,
          agentId: agentA,
          tenantId,
          chainId,
          depth,
          systemPrompt: "You are a helpful agent.",
          initialMessages: baseMessages,
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.kind).toBe("completed");

      const [turns, envelopes, workItems, rm] = await Promise.all([
        sql<
          { turn_index: number; tool_results: unknown[] }[]
        >`SELECT turn_index, tool_results FROM turns WHERE session_id = ${sessionId} ORDER BY turn_index`,
        sql<
          { kind: string; payload: Record<string, unknown> }[]
        >`SELECT kind, payload FROM trigger_envelopes`,
        sql<{ kind: string }[]>`SELECT kind FROM work_queue`,
        fixture.collect(),
      ]);

      expect(turns).toHaveLength(2);
      const turn0 = turns[0];
      assert(turn0 !== undefined, "turn0 must exist");
      expect(turn0.tool_results).toHaveLength(1);
      const tr = turn0.tool_results[0] as Record<string, unknown>;
      expect(tr["content"]).toBe("<dispatched>");

      expect(envelopes).toHaveLength(1);
      expect(envelopes[0]?.kind).toBe("message");
      const payload = envelopes[0]!.payload;
      expect(payload["targetAgentId"]).toBe(agentB as string);
      expect(payload["parentSessionId"]).toBe(sessionId as string);
      expect(payload["parentToolUseId"]).toBeUndefined();

      expect(workItems).toHaveLength(1);
      expect(workItems[0]?.kind).toBe("session_start");

      expect(
        sumCounter(rm, "relay.send.dispatch_total", {
          "relay.send.kind": "notify",
          "relay.outcome": "dispatched",
        }),
      ).toBe(1);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "notify_andAsk_inSameTurn_suspendsParent: ask wins; both envelopes written",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId: agentA, tenantId } = makeIds();
      const { agentId: agentB } = makeIds();
      const { agentId: agentC } = makeIds();
      const chainId = makeChainId();
      const depth = makeDepth0();

      await insertAgent(sql, agentA, tenantId);
      await insertAgent(sql, agentB, tenantId);
      await insertAgent(sql, agentC, tenantId);
      const sessionId = await insertSession(sql, agentA, tenantId, chainId);

      const askId = ToolUseId.parse("ask_tool_use_id_1a");
      const notifyId = ToolUseId.parse("notify_tool_use_id_1a");
      assert(askId.ok && notifyId.ok, "fixture: invalid tool use IDs");

      const mixedResponse: ModelResponse = {
        content: [
          {
            type: "tool_use",
            id: askId.value,
            name: ASK_TOOL_NAME,
            input: { target_agent_id: agentB, content: "what time is it?" },
          },
          {
            type: "tool_use",
            id: notifyId.value,
            name: NOTIFY_TOOL_NAME,
            input: { target_agent_id: agentC, content: "FYI I started" },
          },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5 },
      };

      const model: ModelClient = { complete: () => Promise.resolve(mixedResponse) };

      const result = await runTurnLoop(
        { sql, clock, model, tools },
        {
          sessionId,
          agentId: agentA,
          tenantId,
          chainId,
          depth,
          systemPrompt: "You are a helpful agent.",
          initialMessages: baseMessages,
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.kind).toBe("suspended");

      const [envelopes, workItems, rm] = await Promise.all([
        sql<
          { payload: Record<string, unknown> }[]
        >`SELECT payload FROM trigger_envelopes ORDER BY created_at`,
        sql<{ kind: string }[]>`SELECT kind FROM work_queue`,
        fixture.collect(),
      ]);

      expect(envelopes).toHaveLength(2);
      const askEnvelope = envelopes.find((e) => e.payload["targetAgentId"] === (agentB as string));
      const notifyEnvelope = envelopes.find(
        (e) => e.payload["targetAgentId"] === (agentC as string),
      );
      expect(askEnvelope).toBeDefined();
      expect(notifyEnvelope).toBeDefined();
      expect(askEnvelope?.payload["parentToolUseId"]).toBe(askId.value as string);
      expect(notifyEnvelope?.payload["parentToolUseId"]).toBeUndefined();

      expect(workItems).toHaveLength(2);
      workItems.forEach((w) => {
        expect(w.kind).toBe("session_start");
      });

      expect(
        sumCounter(rm, "relay.send.dispatch_total", {
          "relay.send.kind": "ask",
          "relay.outcome": "dispatched",
        }),
      ).toBe(1);
      expect(
        sumCounter(rm, "relay.send.dispatch_total", {
          "relay.send.kind": "notify",
          "relay.outcome": "dispatched",
        }),
      ).toBe(1);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "notify_validationError: invalid UUID produces inline error tool_result, no envelope",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId, tenantId } = makeIds();
      const chainId = makeChainId();
      const depth = makeDepth0();

      await insertAgent(sql, agentId, tenantId);
      const sessionId = await insertSession(sql, agentId, tenantId, chainId);

      const badToolUseId = ToolUseId.parse("bad_notify_id_1");
      assert(badToolUseId.ok, "fixture: invalid toolUseId");

      const responses: ModelResponse[] = [
        {
          content: [
            {
              type: "tool_use",
              id: badToolUseId.value,
              name: NOTIFY_TOOL_NAME,
              input: { target_agent_id: "not-a-uuid", content: "hi" },
            } satisfies ToolUseBlock,
          ],
          stopReason: "tool_use",
          usage: { inputTokens: 10, outputTokens: 5 },
        },
        textResponse("understood"),
      ];
      const model: ModelClient = { complete: () => Promise.resolve(responses.shift()!) };

      const result = await runTurnLoop(
        { sql, clock, model, tools },
        {
          sessionId,
          agentId,
          tenantId,
          chainId,
          depth,
          systemPrompt: "You are a helpful agent.",
          initialMessages: baseMessages,
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.kind).toBe("completed");

      const [turns, envelopes, rm] = await Promise.all([
        sql<
          { tool_results: unknown[] }[]
        >`SELECT tool_results FROM turns WHERE session_id = ${sessionId} ORDER BY turn_index`,
        sql`SELECT id FROM trigger_envelopes`,
        fixture.collect(),
      ]);

      const turn0Results = turns[0]?.tool_results as Record<string, unknown>[];
      expect(turn0Results).toHaveLength(1);
      expect(turn0Results[0]?.["isError"]).toBe(true);

      expect(envelopes).toHaveLength(0);

      expect(
        sumCounter(rm, "relay.send.dispatch_total", {
          "relay.send.kind": "notify",
          "relay.outcome": "validation_failed",
        }),
      ).toBe(1);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "notify_hookDeny: denied notify produces inline error tool_result, no envelope",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_000_000);
      const { agentId: agentA, tenantId } = makeIds();
      const { agentId: agentB } = makeIds();
      const chainId = makeChainId();
      const depth = makeDepth0();

      await insertAgent(sql, agentA, tenantId);
      await insertAgent(sql, agentB, tenantId);
      const sessionId = await insertSession(sql, agentA, tenantId, chainId);

      registerHook({
        id: makeHookId("system/pre_message_send/deny-all-notify"),
        layer: "system",
        event: HOOK_EVENT.PreMessageSend,
        matcher: (p) => p.kind === "notify",
        decision: () => Promise.resolve({ decision: "deny", reason: "notify blocked by policy" }),
      });

      const notifyToolUseId = ToolUseId.parse("deny_notify_id_1");
      assert(notifyToolUseId.ok, "fixture: invalid toolUseId");

      const responses: ModelResponse[] = [
        notifyResponse(notifyToolUseId.value, agentB, "hi"),
        textResponse("ok policy noted"),
      ];
      const model: ModelClient = { complete: () => Promise.resolve(responses.shift()!) };

      const result = await runTurnLoop(
        { sql, clock, model, tools },
        {
          sessionId,
          agentId: agentA,
          tenantId,
          chainId,
          depth,
          systemPrompt: "You are a helpful agent.",
          initialMessages: baseMessages,
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.kind).toBe("completed");

      const [turns, envelopes, rm] = await Promise.all([
        sql<
          { tool_results: unknown[] }[]
        >`SELECT tool_results FROM turns WHERE session_id = ${sessionId} ORDER BY turn_index`,
        sql`SELECT id FROM trigger_envelopes`,
        fixture.collect(),
      ]);

      const turn0Results = turns[0]?.tool_results as Record<string, unknown>[];
      expect(turn0Results).toHaveLength(1);
      expect(turn0Results[0]?.["isError"]).toBe(true);

      expect(envelopes).toHaveLength(0);

      expect(
        sumCounter(rm, "relay.send.dispatch_total", {
          "relay.send.kind": "notify",
          "relay.outcome": "hook_denied",
        }),
      ).toBe(1);
    },
    HOOK_TIMEOUT_MS,
  );
});
