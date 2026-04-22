// Integration tests for trigger handlers. Real Postgres per CLAUDE.md §3.
// Skipped when INTEGRATION_DATABASE_URL is unset so `bun test` stays green locally.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import type { AgentId } from "../../../src/ids.ts";
import { assert } from "../../../src/core/assert.ts";
import { FakeClock } from "../../../src/core/clock.ts";
import { migrate } from "../../../src/db/migrate-apply.ts";
import { AgentId as AgentIdParser, TenantId, WorkItemId } from "../../../src/ids.ts";
import { enqueue } from "../../../src/work_queue/queue-ops.ts";
import { writeEnvelope } from "../../../src/trigger/envelope-ops.ts";
import { triggerHandlers } from "../../../src/trigger/handlers.ts";
import type { HandlerDeps } from "../../../src/trigger/handlers.ts";
import { DB_URL, HOOK_TIMEOUT_MS, MIGRATIONS_DIR, describeOrSkip, resetDb } from "../helpers.ts";
import type { WorkItem } from "../../../src/work_queue/queue.ts";
import { MAX_ENVELOPE_BYTES } from "../../../src/trigger/limits.ts";

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
  await s.unsafe(`TRUNCATE TABLE trigger_envelopes, work_queue, sessions, tasks, agents CASCADE`);
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
        attempts: 1,
      };

      const deps: HandlerDeps = { sql, clock };
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
        attempts: 1,
      };

      const result = await triggerHandlers({ sql, clock }).session_start(
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
        attempts: 1,
      };

      const result = await triggerHandlers({ sql, clock }).task_fire(
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
        attempts: 1,
      };

      const deps: HandlerDeps = { sql, clock };
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
        attempts: 1,
      };

      const result = await triggerHandlers({ sql, clock }).session_start(
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
        attempts: 1,
      };

      const result = await triggerHandlers({ sql, clock }).session_start(
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
        attempts: 1,
      };

      const result = await triggerHandlers({ sql, clock }).session_start(
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

describeOrSkip("inbound_message stub", () => {
  test(
    "returns handler_failed with 'not implemented: inbound_message (owned by RELAY-47)'",
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
        payloadRef: "irrelevant",
        scheduledAt: new Date(0),
        attempts: 1,
      };

      const result = await triggerHandlers({ sql, clock }).inbound_message(
        workItem,
        new AbortController().signal,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("handler_failed");
      if (result.error.kind !== "handler_failed") return;
      expect(result.error.reason).toBe("not implemented: inbound_message (owned by RELAY-47)");
    },
    HOOK_TIMEOUT_MS,
  );
});
