// Integration tests for trigger handlers. Real Postgres per CLAUDE.md §3.
// Skipped when INTEGRATION_DATABASE_URL is unset so `bun test` stays green locally.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import type { AgentId, SessionId } from "../../../src/ids.ts";
import { assert } from "../../../src/core/assert.ts";
import { FakeClock } from "../../../src/core/clock.ts";
import { migrate } from "../../../src/db/migrate-apply.ts";
import {
  AgentId as AgentIdParser,
  SessionId as SessionIdParser,
  TenantId,
  WorkItemId,
} from "../../../src/ids.ts";
import { enqueue } from "../../../src/work_queue/queue-ops.ts";
import { writeEnvelope } from "../../../src/trigger/envelope-ops.ts";
import { writeInboundMessage } from "../../../src/trigger/inbound/inbound-ops.ts";
import { triggerHandlers } from "../../../src/trigger/handlers.ts";
import type { HandlerDeps } from "../../../src/trigger/handlers.ts";
import { DB_URL, HOOK_TIMEOUT_MS, MIGRATIONS_DIR, describeOrSkip, resetDb } from "../helpers.ts";
import type { WorkItem } from "../../../src/work_queue/queue.ts";
import { MAX_ENVELOPE_BYTES } from "../../../src/trigger/limits.ts";
import type { ModelClient } from "../../../src/session/model.ts";
import type { Message, ModelResponse } from "../../../src/session/turn.ts";
import { InMemoryToolRegistry } from "../../../src/session/tools-inmemory.ts";
import { FakeEmbeddingClient } from "../../fakes/embedding-fake.ts";

let sqlRef: Sql | undefined;

function requireSql(): Sql {
  assert(sqlRef !== undefined, "integration test: sql initialized by beforeAll");
  return sqlRef;
}

function tenant() {
  const r = TenantId.parse(randomUUID());
  assert(r.ok, "fixture: randomUUID produced invalid TenantId");
  return r.value;
}

async function insertAgent(
  sql: Sql,
  tenantId: ReturnType<typeof tenant>,
  systemPrompt = "You are a helpful assistant.",
): Promise<AgentId> {
  const agentIdStr = randomUUID();
  await sql`
    INSERT INTO agents (id, tenant_id, system_prompt)
    VALUES (${agentIdStr}, ${tenantId}, ${systemPrompt})
  `;
  const r = AgentIdParser.parse(agentIdStr);
  assert(r.ok, "fixture: randomUUID produced invalid AgentId");
  return r.value;
}

async function insertTask(
  sql: Sql,
  tenantId: ReturnType<typeof tenant>,
  agentId: AgentId,
  intent: string,
): Promise<string> {
  const taskId = randomUUID();
  const triggerCond = sql.json({ kind: "cron", expr: "0 * * * *", tz: "UTC" });
  await sql`
    INSERT INTO tasks (id, agent_id, tenant_id, trigger_condition, intent)
    VALUES (${taskId}, ${agentId}, ${tenantId}, ${triggerCond}, ${intent})
  `;
  return taskId;
}

type SessionRow = {
  id: string;
  agent_id: string;
  tenant_id: string;
  chain_id: string;
  depth: number;
  source_work_item_id: string;
  originating_trigger: Record<string, unknown>;
};

async function getSession(sql: Sql, workItemId: string): Promise<SessionRow | undefined> {
  const rows = await sql<SessionRow[]>`
    SELECT id, agent_id, tenant_id, chain_id, depth, source_work_item_id, originating_trigger
    FROM sessions
    WHERE source_work_item_id = ${workItemId}
  `;
  return rows[0];
}

async function insertOpenSession(
  sql: Sql,
  tenantId: ReturnType<typeof tenant>,
  agentId: AgentId,
  openingUserContent = "Original question",
): Promise<SessionId> {
  const sessionIdStr = randomUUID();
  const chainId = randomUUID();
  const trigger = sql.json({ kind: "test" });
  await sql`
    INSERT INTO sessions (
      id, agent_id, tenant_id, originating_trigger,
      parent_session_id, chain_id, depth, opening_user_content
    )
    VALUES (
      ${sessionIdStr}, ${agentId}, ${tenantId},
      ${trigger},
      NULL, ${chainId}, 0, ${openingUserContent}
    )
  `;
  const r = SessionIdParser.parse(sessionIdStr);
  assert(r.ok, "fixture: randomUUID produced invalid SessionId");
  return r.value;
}

async function insertTurnRow(
  sql: Sql,
  sessionId: SessionId,
  agentId: AgentId,
  tenantId: ReturnType<typeof tenant>,
  turnIndex: number,
  responseText: string,
): Promise<void> {
  const turnId = randomUUID();
  const response = sql.json({
    content: [{ type: "text", text: responseText }],
    stopReason: "end_turn",
    usage: { inputTokens: 5, outputTokens: 3 },
  });
  const toolResults = sql.json([]);
  const usage = sql.json({ inputTokens: 5, outputTokens: 3 });
  const now = new Date();
  await sql`
    INSERT INTO turns (id, session_id, tenant_id, agent_id, turn_index, started_at, completed_at, response, tool_results, usage)
    VALUES (${turnId}, ${sessionId}, ${tenantId}, ${agentId}, ${turnIndex}, ${now}, ${now}, ${response}, ${toolResults}, ${usage})
  `;
}

function endTurnModel(): ModelClient {
  const response: ModelResponse = {
    content: [{ type: "text", text: "Hello!" }],
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 5 },
  };
  return { complete: () => Promise.resolve(response) };
}

function fakeDeps(sql: Sql, clock: FakeClock, model: ModelClient = endTurnModel()): HandlerDeps {
  return {
    sql,
    clock,
    model,
    tools: new InMemoryToolRegistry([]),
    embedder: new FakeEmbeddingClient({ error: { kind: "transient", message: "test" } }),
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
    `TRUNCATE TABLE inbound_messages, trigger_envelopes, work_queue, sessions, tasks, agents CASCADE`,
  );
});

describeOrSkip("session_start — message handler", () => {
  test(
    "creates session row with correct fields for a message envelope",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_700_000_000_000);
      const tenantId = tenant();
      const agentId = await insertAgent(sql, tenantId);

      const envelopeResult = await writeEnvelope(sql, tenantId, "message", {
        kind: "message",
        sender: { type: "human", id: "user-1", displayName: "Alice" },
        targetAgentId: agentId as string,
        content: "Hello",
        receivedAt: new Date(clock.now()).toISOString(),
      });
      assert(envelopeResult.ok, "fixture: writeEnvelope failed");

      const wid = await enqueue(sql, {
        tenantId,
        kind: "session_start",
        payloadRef: envelopeResult.value,
        scheduledAt: new Date(clock.now()),
      });
      assert(wid.ok, "fixture: enqueue failed");
      const workItemId = wid.value as string;

      const workItem: WorkItem = {
        id: wid.value,
        tenantId,
        kind: "session_start",
        payloadRef: envelopeResult.value,
        scheduledAt: new Date(clock.now()),
        traceparent: null,
        attempts: 1,
      };

      const deps = fakeDeps(sql, clock);
      const ctrl = new AbortController();
      const result = await triggerHandlers(deps).session_start(workItem, ctrl.signal);

      expect(result.ok).toBe(true);

      const session = await getSession(sql, workItemId);
      expect(session).toBeDefined();
      expect(session?.source_work_item_id).toBe(workItemId);
      expect(session?.depth).toBe(0);
      expect(session?.chain_id).toBeTruthy();
      expect(session?.agent_id).toBe(agentId as string);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "creates session row for event envelope with source in transcript",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_700_000_000_000);
      const tenantId = tenant();
      const agentId = await insertAgent(sql, tenantId);

      const envelopeResult = await writeEnvelope(sql, tenantId, "event", {
        kind: "event",
        source: "github",
        targetAgentId: agentId as string,
        data: { action: "push" },
        receivedAt: new Date(clock.now()).toISOString(),
      });
      assert(envelopeResult.ok, "fixture: writeEnvelope failed");

      const wid = await enqueue(sql, {
        tenantId,
        kind: "session_start",
        payloadRef: envelopeResult.value,
        scheduledAt: new Date(clock.now()),
      });
      assert(wid.ok, "fixture: enqueue failed");
      const workItemId = wid.value as string;

      const workItem: WorkItem = {
        id: wid.value,
        tenantId,
        kind: "session_start",
        payloadRef: envelopeResult.value,
        scheduledAt: new Date(clock.now()),
        traceparent: null,
        attempts: 1,
      };

      const result = await triggerHandlers(fakeDeps(sql, clock)).session_start(
        workItem,
        new AbortController().signal,
      );
      expect(result.ok).toBe(true);

      const session = await getSession(sql, workItemId);
      expect(session).toBeDefined();
      expect(session?.agent_id).toBe(agentId as string);
    },
    HOOK_TIMEOUT_MS,
  );
});

describeOrSkip("task_fire handler", () => {
  test(
    "creates session row with originating_trigger.kind = task_fire and intent in transcript",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_700_000_000_000);
      const tenantId = tenant();
      const agentId = await insertAgent(sql, tenantId);
      const taskId = await insertTask(sql, tenantId, agentId, "Run weekly digest");

      const wid = await enqueue(sql, {
        tenantId,
        kind: "task_fire",
        payloadRef: taskId,
        scheduledAt: new Date(clock.now()),
      });
      assert(wid.ok, "fixture: enqueue failed");
      const workItemId = wid.value as string;

      const workItem: WorkItem = {
        id: wid.value,
        tenantId,
        kind: "task_fire",
        payloadRef: taskId,
        scheduledAt: new Date(clock.now()),
        traceparent: null,
        attempts: 1,
      };

      const result = await triggerHandlers(fakeDeps(sql, clock)).task_fire(
        workItem,
        new AbortController().signal,
      );
      expect(result.ok).toBe(true);

      const session = await getSession(sql, workItemId);
      expect(session).toBeDefined();
      expect(session?.originating_trigger["kind"]).toBe("task_fire");
    },
    HOOK_TIMEOUT_MS,
  );
});

describeOrSkip("idempotency", () => {
  test(
    "second dispatch for same work item produces exactly one session row",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_700_000_000_000);
      const tenantId = tenant();
      const agentId = await insertAgent(sql, tenantId);

      const envelopeResult = await writeEnvelope(sql, tenantId, "message", {
        kind: "message",
        sender: { type: "human", id: "user-1" },
        targetAgentId: agentId as string,
        content: "Retry me",
        receivedAt: new Date(clock.now()).toISOString(),
      });
      assert(envelopeResult.ok, "fixture: writeEnvelope failed");

      const wid = await enqueue(sql, {
        tenantId,
        kind: "session_start",
        payloadRef: envelopeResult.value,
        scheduledAt: new Date(clock.now()),
      });
      assert(wid.ok, "fixture: enqueue failed");
      const workItemId = wid.value as string;

      const workItem: WorkItem = {
        id: wid.value,
        tenantId,
        kind: "session_start",
        payloadRef: envelopeResult.value,
        scheduledAt: new Date(clock.now()),
        traceparent: null,
        attempts: 1,
      };

      const deps = fakeDeps(sql, clock);
      const signal = new AbortController().signal;

      const r1 = await triggerHandlers(deps).session_start(workItem, signal);
      expect(r1.ok).toBe(true);

      const r2 = await triggerHandlers(deps).session_start(workItem, signal);
      expect(r2.ok).toBe(true);

      const rows = await sql<{ id: string }[]>`
        SELECT id FROM sessions WHERE source_work_item_id = ${workItemId}
      `;
      expect(rows).toHaveLength(1);
    },
    HOOK_TIMEOUT_MS,
  );
});

describeOrSkip("tenant mismatch", () => {
  test(
    "envelope referencing an agent in a different tenant returns handler_failed",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_700_000_000_000);
      const tenantA = tenant();
      const tenantB = tenant();
      const agentInB = await insertAgent(sql, tenantB);

      const envelopeResult = await writeEnvelope(sql, tenantA, "message", {
        kind: "message",
        sender: { type: "human", id: "u" },
        targetAgentId: agentInB as string,
        content: "Cross-tenant",
        receivedAt: new Date(clock.now()).toISOString(),
      });
      assert(envelopeResult.ok, "fixture: writeEnvelope failed");

      const wid = await enqueue(sql, {
        tenantId: tenantA,
        kind: "session_start",
        payloadRef: envelopeResult.value,
        scheduledAt: new Date(clock.now()),
      });
      assert(wid.ok, "fixture: enqueue failed");
      const workItemId = wid.value as string;

      const workItem: WorkItem = {
        id: wid.value,
        tenantId: tenantA,
        kind: "session_start",
        payloadRef: envelopeResult.value,
        scheduledAt: new Date(clock.now()),
        traceparent: null,
        attempts: 1,
      };

      const result = await triggerHandlers(fakeDeps(sql, clock)).session_start(
        workItem,
        new AbortController().signal,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("handler_failed");

      const sessionCount = await sql<{ count: string }[]>`
        SELECT count(*) FROM sessions WHERE source_work_item_id = ${workItemId}
      `;
      expect(Number(sessionCount[0]?.count)).toBe(0);
    },
    HOOK_TIMEOUT_MS,
  );
});

describeOrSkip("unknown agent", () => {
  test(
    "envelope referencing non-existent agent_id returns handler_failed with no session",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_700_000_000_000);
      const tenantId = tenant();
      const nonExistentAgent = randomUUID();

      const envelopeResult = await writeEnvelope(sql, tenantId, "message", {
        kind: "message",
        sender: { type: "human", id: "u" },
        targetAgentId: nonExistentAgent,
        content: "Ghost agent",
        receivedAt: new Date(clock.now()).toISOString(),
      });
      assert(envelopeResult.ok, "fixture: writeEnvelope failed");

      const wid = await enqueue(sql, {
        tenantId,
        kind: "session_start",
        payloadRef: envelopeResult.value,
        scheduledAt: new Date(clock.now()),
      });
      assert(wid.ok, "fixture: enqueue failed");
      const workItemId = wid.value as string;

      const workItem: WorkItem = {
        id: wid.value,
        tenantId,
        kind: "session_start",
        payloadRef: envelopeResult.value,
        scheduledAt: new Date(clock.now()),
        traceparent: null,
        attempts: 1,
      };

      const result = await triggerHandlers(fakeDeps(sql, clock)).session_start(
        workItem,
        new AbortController().signal,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("handler_failed");

      const sessionCount = await sql<{ count: string }[]>`
        SELECT count(*) FROM sessions WHERE source_work_item_id = ${workItemId}
      `;
      expect(Number(sessionCount[0]?.count)).toBe(0);
    },
    HOOK_TIMEOUT_MS,
  );
});

describeOrSkip("oversized envelope", () => {
  test(
    "envelope with payload exceeding MAX_ENVELOPE_BYTES returns handler_failed",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_700_000_000_000);
      const tenantId = tenant();
      const agentId = await insertAgent(sql, tenantId);
      const envelopeId = randomUUID();

      const bigPayload = JSON.stringify({
        kind: "message",
        sender: { type: "human", id: "u" },
        targetAgentId: agentId as string,
        content: "x".repeat(MAX_ENVELOPE_BYTES + 1),
        receivedAt: new Date(clock.now()).toISOString(),
      });
      // Bypass writeEnvelope validation by inserting directly via unsafe SQL.
      await sql.unsafe(
        `INSERT INTO trigger_envelopes (id, tenant_id, kind, payload) VALUES ($1, $2, 'message', $3::jsonb)`,
        [envelopeId, tenantId as string, bigPayload],
      );

      const wid = await enqueue(sql, {
        tenantId,
        kind: "session_start",
        payloadRef: envelopeId,
        scheduledAt: new Date(clock.now()),
      });
      assert(wid.ok, "fixture: enqueue failed");
      const workItemId = wid.value as string;

      const workItem: WorkItem = {
        id: wid.value,
        tenantId,
        kind: "session_start",
        payloadRef: envelopeId,
        scheduledAt: new Date(clock.now()),
        traceparent: null,
        attempts: 1,
      };

      const result = await triggerHandlers(fakeDeps(sql, clock)).session_start(
        workItem,
        new AbortController().signal,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("handler_failed");

      const sessionCount = await sql<{ count: string }[]>`
        SELECT count(*) FROM sessions WHERE source_work_item_id = ${workItemId}
      `;
      expect(Number(sessionCount[0]?.count)).toBe(0);
    },
    HOOK_TIMEOUT_MS,
  );
});

describeOrSkip("inbound_message handler — happy path", () => {
  test(
    "returns ok and emits ready signal for a valid inbound_message work item",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_700_000_000_000);
      const tenantId = tenant();
      const agentId = await insertAgent(sql, tenantId);
      const sessionId = await insertOpenSession(sql, tenantId, agentId);

      const widResult = WorkItemId.parse(randomUUID());
      assert(widResult.ok, "fixture: WorkItemId.parse failed");

      const inboundResult = await writeInboundMessage(sql, {
        tenantId,
        targetSessionId: sessionId,
        sender: { type: "human", id: "user-1", displayName: "Alice" },
        content: "Hello from the test",
        receivedAt: new Date(clock.now()),
        sourceWorkItemId: widResult.value,
      });
      assert(inboundResult.ok, "fixture: writeInboundMessage failed");

      const workItem: WorkItem = {
        id: widResult.value,
        tenantId,
        kind: "inbound_message",
        payloadRef: inboundResult.value,
        scheduledAt: new Date(clock.now()),
        traceparent: null,
        attempts: 1,
      };

      const result = await triggerHandlers(fakeDeps(sql, clock)).inbound_message(
        workItem,
        new AbortController().signal,
      );
      expect(result.ok).toBe(true);
    },
    HOOK_TIMEOUT_MS,
  );

  for (const senderType of ["agent", "system"] as const) {
    test(
      `returns ok for sender_type ${senderType}`,
      async () => {
        const sql = requireSql();
        const clock = new FakeClock(1_700_000_000_000);
        const tenantId = tenant();
        const agentId = await insertAgent(sql, tenantId);
        const sessionId = await insertOpenSession(sql, tenantId, agentId);
        const widResult = WorkItemId.parse(randomUUID());
        assert(widResult.ok, "fixture: WorkItemId.parse failed");
        const inboundResult = await writeInboundMessage(sql, {
          tenantId,
          targetSessionId: sessionId,
          sender: { type: senderType, id: "sender-1" },
          content: `${senderType} says hi`,
          receivedAt: new Date(clock.now()),
          sourceWorkItemId: widResult.value,
        });
        assert(inboundResult.ok, "fixture: writeInboundMessage failed");
        const workItem: WorkItem = {
          id: widResult.value,
          tenantId,
          kind: "inbound_message",
          payloadRef: inboundResult.value,
          scheduledAt: new Date(clock.now()),
          traceparent: null,
          attempts: 1,
        };
        const result = await triggerHandlers(fakeDeps(sql, clock)).inbound_message(
          workItem,
          new AbortController().signal,
        );
        expect(result.ok).toBe(true);
      },
      HOOK_TIMEOUT_MS,
    );
  }
});

describeOrSkip("inbound_message handler — idempotency", () => {
  test(
    "second writeInboundMessage with same sourceWorkItemId returns the existing id",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_700_000_000_000);
      const tenantId = tenant();
      const agentId = await insertAgent(sql, tenantId);
      const sessionId = await insertOpenSession(sql, tenantId, agentId);
      const widResult = WorkItemId.parse(randomUUID());
      assert(widResult.ok, "fixture: WorkItemId.parse failed");

      const spec = {
        tenantId,
        targetSessionId: sessionId,
        sender: { type: "human" as const, id: "user-1" },
        content: "Hello",
        receivedAt: new Date(clock.now()),
        sourceWorkItemId: widResult.value,
      };

      const r1 = await writeInboundMessage(sql, spec);
      assert(r1.ok, "fixture: first writeInboundMessage failed");
      const r2 = await writeInboundMessage(sql, spec);
      assert(r2.ok, "fixture: second writeInboundMessage failed");
      expect(r1.value).toBe(r2.value);

      const count = await sql<{ c: string }[]>`
        SELECT count(*) AS c FROM inbound_messages WHERE source_work_item_id = ${widResult.value}
      `;
      expect(Number(count[0]?.c)).toBe(1);
    },
    HOOK_TIMEOUT_MS,
  );
});

describeOrSkip("inbound_message handler — error cases", () => {
  test(
    "invalid payload_ref returns handler_failed",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(0);
      const tenantId = tenant();
      const widResult = WorkItemId.parse(randomUUID());
      assert(widResult.ok, "fixture: WorkItemId.parse failed");
      const workItem: WorkItem = {
        id: widResult.value,
        tenantId,
        kind: "inbound_message",
        payloadRef: "not-a-uuid",
        scheduledAt: new Date(0),
        traceparent: null,
        attempts: 1,
      };
      const result = await triggerHandlers(fakeDeps(sql, clock)).inbound_message(
        workItem,
        new AbortController().signal,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("handler_failed");
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "inbound row not found returns handler_failed",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(0);
      const tenantId = tenant();
      const widResult = WorkItemId.parse(randomUUID());
      assert(widResult.ok, "fixture: WorkItemId.parse failed");
      const workItem: WorkItem = {
        id: widResult.value,
        tenantId,
        kind: "inbound_message",
        payloadRef: randomUUID(),
        scheduledAt: new Date(0),
        traceparent: null,
        attempts: 1,
      };
      const result = await triggerHandlers(fakeDeps(sql, clock)).inbound_message(
        workItem,
        new AbortController().signal,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("handler_failed");
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "inbound row tenant_id != work item tenant_id returns handler_failed without delivery",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_700_000_000_000);
      const tenantA = tenant();
      const tenantB = tenant();
      const agentId = await insertAgent(sql, tenantA);
      const sessionId = await insertOpenSession(sql, tenantA, agentId);
      const widResult = WorkItemId.parse(randomUUID());
      assert(widResult.ok, "fixture: WorkItemId.parse failed");

      // Write inbound under tenantA, but dispatch work item under tenantB
      const inboundResult = await writeInboundMessage(sql, {
        tenantId: tenantA,
        targetSessionId: sessionId,
        sender: { type: "human", id: "u" },
        content: "Mismatch",
        receivedAt: new Date(clock.now()),
        sourceWorkItemId: widResult.value,
      });
      assert(inboundResult.ok, "fixture: writeInboundMessage failed");

      const workItem: WorkItem = {
        id: widResult.value,
        tenantId: tenantB,
        kind: "inbound_message",
        payloadRef: inboundResult.value,
        scheduledAt: new Date(clock.now()),
        traceparent: null,
        attempts: 1,
      };
      const result = await triggerHandlers(fakeDeps(sql, clock)).inbound_message(
        workItem,
        new AbortController().signal,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("handler_failed");
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "closed target session returns handler_failed without delivery",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_700_000_000_000);
      const tenantId = tenant();
      const agentId = await insertAgent(sql, tenantId);
      const sessionId = await insertOpenSession(sql, tenantId, agentId);

      // Close the session
      await sql`UPDATE sessions SET closed_at = now() WHERE id = ${sessionId}`;

      const widResult = WorkItemId.parse(randomUUID());
      assert(widResult.ok, "fixture: WorkItemId.parse failed");
      const inboundResult = await writeInboundMessage(sql, {
        tenantId,
        targetSessionId: sessionId,
        sender: { type: "human", id: "u" },
        content: "Too late",
        receivedAt: new Date(clock.now()),
        sourceWorkItemId: widResult.value,
      });
      assert(inboundResult.ok, "fixture: writeInboundMessage failed");

      const workItem: WorkItem = {
        id: widResult.value,
        tenantId,
        kind: "inbound_message",
        payloadRef: inboundResult.value,
        scheduledAt: new Date(clock.now()),
        traceparent: null,
        attempts: 1,
      };
      const result = await triggerHandlers(fakeDeps(sql, clock)).inbound_message(
        workItem,
        new AbortController().signal,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("handler_failed");
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "missing target session returns handler_failed",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_700_000_000_000);
      const tenantId = tenant();
      const agentId = await insertAgent(sql, tenantId);
      const sessionId = await insertOpenSession(sql, tenantId, agentId);

      const widResult = WorkItemId.parse(randomUUID());
      assert(widResult.ok, "fixture: WorkItemId.parse failed");
      const inboundResult = await writeInboundMessage(sql, {
        tenantId,
        targetSessionId: sessionId,
        sender: { type: "human", id: "u" },
        content: "Ghost session",
        receivedAt: new Date(clock.now()),
        sourceWorkItemId: widResult.value,
      });
      assert(inboundResult.ok, "fixture: writeInboundMessage failed");

      // Disable FK checks to reroute the inbound to a non-existent session, then delete
      // the original session. ON DELETE CASCADE would otherwise silently remove the inbound.
      await sql.unsafe(`SET session_replication_role = 'replica'`);
      await sql`UPDATE inbound_messages SET target_session_id = ${randomUUID()} WHERE id = ${inboundResult.value}`;
      await sql.unsafe(`SET session_replication_role = 'origin'`);
      await sql`DELETE FROM sessions WHERE id = ${sessionId}`;

      const workItem: WorkItem = {
        id: widResult.value,
        tenantId,
        kind: "inbound_message",
        payloadRef: inboundResult.value,
        scheduledAt: new Date(clock.now()),
        traceparent: null,
        attempts: 1,
      };
      const result = await triggerHandlers(fakeDeps(sql, clock)).inbound_message(
        workItem,
        new AbortController().signal,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("handler_failed");
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "target session in different tenant than inbound returns handler_failed",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_700_000_000_000);
      const tenantA = tenant();
      const tenantB = tenant();
      const agentA = await insertAgent(sql, tenantA);
      const agentB = await insertAgent(sql, tenantB);
      const sessionA = await insertOpenSession(sql, tenantA, agentA);
      const sessionB = await insertOpenSession(sql, tenantB, agentB);

      const widResult = WorkItemId.parse(randomUUID());
      assert(widResult.ok, "fixture: WorkItemId.parse failed");

      // Write inbound targeting sessionA under tenantA, but set target to sessionB
      const inboundResult = await writeInboundMessage(sql, {
        tenantId: tenantA,
        targetSessionId: sessionA,
        sender: { type: "human", id: "u" },
        content: "Cross-tenant target",
        receivedAt: new Date(clock.now()),
        sourceWorkItemId: widResult.value,
      });
      assert(inboundResult.ok, "fixture: writeInboundMessage failed");

      // Manually update the target_session_id to point to a different tenant's session
      await sql`UPDATE inbound_messages SET target_session_id = ${sessionB} WHERE id = ${inboundResult.value}`;

      const workItem: WorkItem = {
        id: widResult.value,
        tenantId: tenantA,
        kind: "inbound_message",
        payloadRef: inboundResult.value,
        scheduledAt: new Date(clock.now()),
        traceparent: null,
        attempts: 1,
      };
      const result = await triggerHandlers(fakeDeps(sql, clock)).inbound_message(
        workItem,
        new AbortController().signal,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("handler_failed");
    },
    HOOK_TIMEOUT_MS,
  );
});

describeOrSkip("inbound_message handler — resume turn loop wiring", () => {
  test(
    "happy path: prior turn reloaded, inbound appended, session closed after end_turn",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_700_000_000_000);
      const tenantId = tenant();
      const agentId = await insertAgent(sql, tenantId, "Agent system prompt");
      const sessionId = await insertOpenSession(sql, tenantId, agentId, "Original question");

      await insertTurnRow(sql, sessionId, agentId, tenantId, 0, "First reply");

      const widResult = WorkItemId.parse(randomUUID());
      assert(widResult.ok, "fixture: WorkItemId.parse failed");
      const inboundResult = await writeInboundMessage(sql, {
        tenantId,
        targetSessionId: sessionId,
        sender: { type: "human", id: "user-1" },
        content: "Follow-up question",
        receivedAt: new Date(clock.now()),
        sourceWorkItemId: widResult.value,
      });
      assert(inboundResult.ok, "fixture: writeInboundMessage failed");

      const capturedCalls: { messages: readonly Message[] }[] = [];
      const recordingModel: ModelClient = {
        complete({ messages }) {
          capturedCalls.push({ messages });
          return Promise.resolve({
            content: [{ type: "text", text: "Resume reply" }],
            stopReason: "end_turn",
            usage: { inputTokens: 10, outputTokens: 5 },
          });
        },
      };

      const workItem: WorkItem = {
        id: widResult.value,
        tenantId,
        kind: "inbound_message",
        payloadRef: inboundResult.value,
        scheduledAt: new Date(clock.now()),
        traceparent: null,
        attempts: 1,
      };

      const result = await triggerHandlers(fakeDeps(sql, clock, recordingModel)).inbound_message(
        workItem,
        new AbortController().signal,
      );
      expect(result.ok).toBe(true);

      const sessions = await sql<{ closed_at: Date | null }[]>`
        SELECT closed_at FROM sessions WHERE id = ${sessionId}
      `;
      expect(sessions[0]?.closed_at).not.toBeNull();

      const turns = await sql<{ turn_index: number }[]>`
        SELECT turn_index FROM turns WHERE session_id = ${sessionId} ORDER BY turn_index
      `;
      expect(turns).toHaveLength(2);
      expect(turns[1]?.turn_index).toBe(1);

      assert(capturedCalls.length >= 1, "recording model was called at least once");
      const capturedMessages = capturedCalls[0]?.messages;
      assert(capturedMessages !== undefined, "captured messages must exist");
      expect(capturedMessages).toHaveLength(3);
      const msg0 = capturedMessages[0];
      const msg1 = capturedMessages[1];
      const msg2 = capturedMessages[2];
      expect(msg0?.role).toBe("user");
      expect(msg1?.role).toBe("assistant");
      expect(msg2?.role).toBe("user");
      const firstBlock = msg0?.role === "user" ? msg0.content[0] : undefined;
      expect(firstBlock?.type === "text" ? firstBlock.text : undefined).toBe("Original question");
      const lastBlock = msg2?.role === "user" ? msg2.content[0] : undefined;
      expect(lastBlock?.type === "text" ? lastBlock.text : undefined).toBe("Follow-up question");
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "model_call_failed → handler_failed, session stays open",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_700_000_000_000);
      const tenantId = tenant();
      const agentId = await insertAgent(sql, tenantId);
      const sessionId = await insertOpenSession(sql, tenantId, agentId);

      const widResult = WorkItemId.parse(randomUUID());
      assert(widResult.ok, "fixture: WorkItemId.parse failed");
      const inboundResult = await writeInboundMessage(sql, {
        tenantId,
        targetSessionId: sessionId,
        sender: { type: "human", id: "u" },
        content: "Trigger failure",
        receivedAt: new Date(clock.now()),
        sourceWorkItemId: widResult.value,
      });
      assert(inboundResult.ok, "fixture: writeInboundMessage failed");

      const failModel: ModelClient = {
        complete: () => Promise.reject(new Error("model unavailable")),
      };

      const workItem: WorkItem = {
        id: widResult.value,
        tenantId,
        kind: "inbound_message",
        payloadRef: inboundResult.value,
        scheduledAt: new Date(clock.now()),
        traceparent: null,
        attempts: 1,
      };

      const result = await triggerHandlers(fakeDeps(sql, clock, failModel)).inbound_message(
        workItem,
        new AbortController().signal,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("handler_failed");

      const sessions = await sql<{ closed_at: Date | null }[]>`
        SELECT closed_at FROM sessions WHERE id = ${sessionId}
      `;
      expect(sessions[0]?.closed_at).toBeNull();
    },
    HOOK_TIMEOUT_MS,
  );
});

describeOrSkip("session_start — turn loop wiring", () => {
  test(
    "fresh session: model returns end_turn → session closed, one turn persisted",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_700_000_000_000);
      const tenantId = tenant();
      const agentId = await insertAgent(sql, tenantId);

      const envelopeResult = await writeEnvelope(sql, tenantId, "message", {
        kind: "message",
        sender: { type: "human", id: "user-1" },
        targetAgentId: agentId as string,
        content: "Hello",
        receivedAt: new Date(clock.now()).toISOString(),
      });
      assert(envelopeResult.ok, "fixture: writeEnvelope failed");

      const wid = await enqueue(sql, {
        tenantId,
        kind: "session_start",
        payloadRef: envelopeResult.value,
        scheduledAt: new Date(clock.now()),
      });
      assert(wid.ok, "fixture: enqueue failed");
      const workItemId = wid.value as string;

      const workItem: WorkItem = {
        id: wid.value,
        tenantId,
        kind: "session_start",
        payloadRef: envelopeResult.value,
        scheduledAt: new Date(clock.now()),
        traceparent: null,
        attempts: 1,
      };

      const result = await triggerHandlers(fakeDeps(sql, clock)).session_start(
        workItem,
        new AbortController().signal,
      );
      expect(result.ok).toBe(true);

      const sessions = await sql<{ id: string; closed_at: Date | null }[]>`
        SELECT id, closed_at FROM sessions WHERE source_work_item_id = ${workItemId}
      `;
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.closed_at).not.toBeNull();

      const sessionId = sessions[0]?.id;
      assert(sessionId !== undefined, "integration test: session row must exist");
      const turns = await sql<{ turn_index: number }[]>`
        SELECT turn_index FROM turns WHERE session_id = ${sessionId}
      `;
      expect(turns).toHaveLength(1);
      expect(turns[0]?.turn_index).toBe(0);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "fresh session: model_call_failed → handler_failed, session row not closed",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_700_000_000_000);
      const tenantId = tenant();
      const agentId = await insertAgent(sql, tenantId);

      const envelopeResult = await writeEnvelope(sql, tenantId, "message", {
        kind: "message",
        sender: { type: "human", id: "user-1" },
        targetAgentId: agentId as string,
        content: "Keep going",
        receivedAt: new Date(clock.now()).toISOString(),
      });
      assert(envelopeResult.ok, "fixture: writeEnvelope failed");

      const wid = await enqueue(sql, {
        tenantId,
        kind: "session_start",
        payloadRef: envelopeResult.value,
        scheduledAt: new Date(clock.now()),
      });
      assert(wid.ok, "fixture: enqueue failed");
      const workItemId = wid.value as string;

      const workItem: WorkItem = {
        id: wid.value,
        tenantId,
        kind: "session_start",
        payloadRef: envelopeResult.value,
        scheduledAt: new Date(clock.now()),
        traceparent: null,
        attempts: 1,
      };

      const failModel: ModelClient = {
        complete: () => Promise.reject(new Error("model unavailable")),
      };
      const result = await triggerHandlers(fakeDeps(sql, clock, failModel)).session_start(
        workItem,
        new AbortController().signal,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("handler_failed");

      const sessions = await sql<{ closed_at: Date | null }[]>`
        SELECT closed_at FROM sessions WHERE source_work_item_id = ${workItemId}
      `;
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.closed_at).toBeNull();
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "duplicate session: loop skipped, session not closed again",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(1_700_000_000_000);
      const tenantId = tenant();
      const agentId = await insertAgent(sql, tenantId);

      const envelopeResult = await writeEnvelope(sql, tenantId, "message", {
        kind: "message",
        sender: { type: "human", id: "user-1" },
        targetAgentId: agentId as string,
        content: "Retry me",
        receivedAt: new Date(clock.now()).toISOString(),
      });
      assert(envelopeResult.ok, "fixture: writeEnvelope failed");

      const wid = await enqueue(sql, {
        tenantId,
        kind: "session_start",
        payloadRef: envelopeResult.value,
        scheduledAt: new Date(clock.now()),
      });
      assert(wid.ok, "fixture: enqueue failed");
      const workItemId = wid.value as string;

      const workItem: WorkItem = {
        id: wid.value,
        tenantId,
        kind: "session_start",
        payloadRef: envelopeResult.value,
        scheduledAt: new Date(clock.now()),
        traceparent: null,
        attempts: 1,
      };

      const deps = fakeDeps(sql, clock);

      const r1 = await triggerHandlers(deps).session_start(workItem, new AbortController().signal);
      expect(r1.ok).toBe(true);

      const r2 = await triggerHandlers(deps).session_start(workItem, new AbortController().signal);
      expect(r2.ok).toBe(true);

      const sessions = await sql<{ id: string; closed_at: Date | null }[]>`
        SELECT id, closed_at FROM sessions WHERE source_work_item_id = ${workItemId}
      `;
      expect(sessions).toHaveLength(1);

      const sessionId = sessions[0]?.id;
      assert(sessionId !== undefined, "integration test: session row must exist");
      // Only one turn row — the duplicate run did not insert a second turn.
      const turns = await sql<{ turn_index: number }[]>`
        SELECT turn_index FROM turns WHERE session_id = ${sessionId}
      `;
      expect(turns).toHaveLength(1);
    },
    HOOK_TIMEOUT_MS,
  );
});
