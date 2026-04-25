// Integration tests for POST /trigger: sync-response dispatch via Postgres LISTEN/NOTIFY.
// Real Postgres per CLAUDE.md §3. Skipped when INTEGRATION_DATABASE_URL is unset.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import type { Hono } from "hono";
import { assert } from "../../../src/core/assert.ts";
import { FakeClock } from "../../../src/core/clock.ts";
import { migrate } from "../../../src/db/migrate-apply.ts";
import { makeApp } from "../../../src/http/app.ts";
import { makeReplyRegistry } from "../../../src/http/reply-registry.ts";
import { startSyncListener } from "../../../src/http/sync-listener.ts";
import { FakeEmbeddingClient } from "../../fakes/embedding-fake.ts";
import {
  AgentId as AgentIdParser,
  SessionId as SessionIdParser,
  TenantId as TenantIdParser,
} from "../../../src/ids.ts";
import type { AgentId, SessionId, TenantId } from "../../../src/ids.ts";
import { closeSession } from "../../../src/session/close.ts";
import { DB_URL, HOOK_TIMEOUT_MS, MIGRATIONS_DIR, describeOrSkip, resetDb } from "../helpers.ts";

let sqlRef: Sql | undefined;
let appRef: Hono | undefined;
let stopListenerRef: (() => Promise<void>) | undefined;

function requireSql(): Sql {
  assert(sqlRef !== undefined, "integration test: sql initialized by beforeAll");
  return sqlRef;
}

function requireApp(): Hono {
  assert(appRef !== undefined, "integration test: app initialized by beforeAll");
  return appRef;
}

function makeTenant(): TenantId {
  const r = TenantIdParser.parse(randomUUID());
  assert(r.ok, "fixture: randomUUID produced invalid TenantId");
  return r.value;
}

async function insertAgent(sql: Sql, tenantId: TenantId): Promise<AgentId> {
  const raw = randomUUID();
  await sql`
    INSERT INTO agents (id, tenant_id, system_prompt)
    VALUES (${raw}, ${tenantId}, 'trigger test agent')
  `;
  const r = AgentIdParser.parse(raw);
  assert(r.ok, "fixture: randomUUID produced invalid AgentId");
  return r.value;
}

async function insertSession(
  sql: Sql,
  agentId: AgentId,
  tenantId: TenantId,
  envelopeId: string,
): Promise<SessionId> {
  const raw = randomUUID();
  const chainId = randomUUID();
  // originating_trigger includes envelopeId so closeSession emits NOTIFY.
  await sql`
    INSERT INTO sessions (id, agent_id, tenant_id, originating_trigger, chain_id, depth, opening_user_content, created_at, updated_at)
    VALUES (
      ${raw}, ${agentId}, ${tenantId},
      ${sql.json({ kind: "message", envelopeId })}::jsonb,
      ${chainId}, 0, 'test opening content', now(), now()
    )
  `;
  const r = SessionIdParser.parse(raw);
  assert(r.ok, "fixture: randomUUID produced invalid SessionId");
  return r.value;
}

async function insertSession_noEnvelope(
  sql: Sql,
  agentId: AgentId,
  tenantId: TenantId,
): Promise<SessionId> {
  const raw = randomUUID();
  const chainId = randomUUID();
  await sql`
    INSERT INTO sessions (id, agent_id, tenant_id, originating_trigger, chain_id, depth, opening_user_content, created_at, updated_at)
    VALUES (${raw}, ${agentId}, ${tenantId}, '{"kind":"task_fire"}'::jsonb, ${chainId}, 0, 'test opening content', now(), now())
  `;
  const r = SessionIdParser.parse(raw);
  assert(r.ok, "fixture: randomUUID produced invalid SessionId");
  return r.value;
}

async function insertTurn(
  sql: Sql,
  sessionId: SessionId,
  agentId: AgentId,
  tenantId: TenantId,
): Promise<void> {
  const turnId = randomUUID();
  const response = {
    content: [{ type: "text", text: "Integration test response." }],
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 5 },
  };
  await sql`
    INSERT INTO turns (id, session_id, tenant_id, agent_id, turn_index, started_at, completed_at, response, tool_results, usage)
    VALUES (
      ${turnId}, ${sessionId}, ${tenantId}, ${agentId},
      0, now(), now(),
      ${sql.json(response)}::jsonb,
      '[]'::jsonb,
      ${sql.json(response.usage)}::jsonb
    )
  `;
}

async function postTrigger(app: Hono, body: unknown): Promise<Response> {
  return app.request("/trigger", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  if (!DB_URL) return;
  const s = postgres(DB_URL, { max: 5, idle_timeout: 2 });
  await s`SELECT 1`;
  await resetDb(s);
  const mig = await migrate(s, MIGRATIONS_DIR);
  if (!mig.ok) throw new Error(`migration setup failed: ${mig.error.kind}`);
  sqlRef = s;
  const appClock = new FakeClock(Date.now());
  const registry = makeReplyRegistry(appClock);
  const { stop } = await startSyncListener(s, registry);
  stopListenerRef = stop;
  appRef = makeApp({ sql: s, clock: appClock, registry, embedder: new FakeEmbeddingClient() });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  if (stopListenerRef) await stopListenerRef();
  if (sqlRef !== undefined) await sqlRef.end({ timeout: 5 });
}, 10_000);

beforeEach(async () => {
  if (!DB_URL) return;
  await requireSql()`TRUNCATE TABLE agents CASCADE`;
});

describeOrSkip("POST /trigger (integration)", () => {
  test(
    "closeSession emits NOTIFY — HTTP waiter resolves and returns 200",
    async () => {
      const sql = requireSql();
      const app = requireApp();
      const clock = new FakeClock(Date.now());
      const tenantId = makeTenant();
      const agentId = await insertAgent(sql, tenantId);

      // POST /trigger enqueues a session_start. We bypass the worker and manually
      // insert the session + turn rows to simulate a completed run.
      const triggerBody = {
        tenantId,
        targetAgentId: agentId,
        sender: { type: "human", id: "test-user" },
        content: "integration test message",
      };

      // Start the HTTP request (don't await — it will hold until NOTIFY).
      const responsePending = postTrigger(app, triggerBody);

      // Poll work_queue until the route handler's enqueue commits. Each SQL
      // round-trip yields the event loop, giving writeEnvelope + enqueue time
      // to complete without relying on a fixed real-time wait.
      let envelopeId: string | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = await sql<{ payload_ref: string }[]>`
          SELECT payload_ref FROM work_queue ORDER BY created_at DESC LIMIT 1
        `;
        if (rows.length > 0) {
          envelopeId = rows[0]!.payload_ref;
          break;
        }
      }
      assert(envelopeId !== undefined, "fixture: work item never appeared in work_queue");

      // Insert session referencing envelopeId (simulates worker createSession).
      const sessionId = await insertSession(sql, agentId, tenantId, envelopeId);

      // Insert a turn (simulates worker turn-loop completion).
      await insertTurn(sql, sessionId, agentId, tenantId);

      // closeSession writes closed_at and emits NOTIFY — this unblocks the HTTP handler.
      const closeResult = await closeSession(sql, clock, {
        sessionId,
        agentId,
        tenantId,
        reason: { kind: "end_turn" },
      });
      assert(closeResult.ok, "fixture: closeSession must succeed");

      const res = await responsePending;
      expect(res.status).toBe(200);
      const body = (await res.json()) as { session_id: string; text: string; stop_reason: string };
      expect(body.session_id).toBe(sessionId);
      expect(body.text).toBe("Integration test response.");
      expect(body.stop_reason).toBe("end_turn");
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "timeout: session never closes — returns 504 JSON with session_id null",
    async () => {
      const sql = requireSql();
      const { realClock } = await import("../../../src/core/clock.ts");
      const registry = makeReplyRegistry(realClock);
      const { stop } = await startSyncListener(sql, registry);
      try {
        const tenantId = makeTenant();
        const agentId = await insertAgent(sql, tenantId);
        const { triggerRoute } = await import("../../../src/http/routes/trigger.ts");
        // Use a real clock with a short timeout. Session is never closed so we expect 504.
        const smallRoute = triggerRoute({ sql, clock: realClock, registry, maxWaitMs: 500 });

        const triggerBody = {
          tenantId,
          targetAgentId: agentId,
          sender: { type: "human", id: "u1" },
          content: "timeout test",
        };

        const res = await smallRoute.request("/trigger", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(triggerBody),
        });

        expect(res.status).toBe(504);
        const body = (await res.json()) as { session_id: null; error: { kind: string } };
        expect(body.session_id).toBeNull();
        expect(body.error.kind).toBe("sync_wait_timeout");
      } finally {
        await stop();
      }
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "closeSession on session without envelopeId does NOT send NOTIFY — registry untouched",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(Date.now());
      const tenantId = makeTenant();
      const agentId = await insertAgent(sql, tenantId);

      // Session has no envelopeId in originating_trigger (task_fire trigger).
      const sessionId = await insertSession_noEnvelope(sql, agentId, tenantId);

      const registry = makeReplyRegistry(new FakeClock(Date.now()));
      let notifyReceived = false;
      const { stop } = await startSyncListener(sql, {
        ...registry,
        resolve: (eid, outcome) => {
          notifyReceived = true;
          registry.resolve(eid, outcome);
        },
      });

      try {
        const closeResult = await closeSession(sql, clock, {
          sessionId,
          agentId,
          tenantId,
          reason: { kind: "end_turn" },
        });
        assert(closeResult.ok, "fixture: close must succeed");

        // No wait needed: emitSessionSyncClose checks envelope_id === null and
        // returns before calling sql.notify, so no notification is ever sent and
        // the LISTEN callback cannot fire for this session.
        expect(notifyReceived).toBe(false);
      } finally {
        await stop();
      }
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "multi-replica: NOTIFY delivered to both listeners, only the holder resolves",
    async () => {
      const sql = requireSql();
      const clock = new FakeClock(Date.now());
      const tenantId = makeTenant();
      const agentId = await insertAgent(sql, tenantId);

      // Simulate two HTTP replicas with independent registries + listeners.
      const replicaA_sql = postgres(DB_URL!, { max: 2, idle_timeout: 2 });
      const replicaB_sql = postgres(DB_URL!, { max: 2, idle_timeout: 2 });

      const registryA = makeReplyRegistry(new FakeClock(Date.now()));
      const registryB = makeReplyRegistry(new FakeClock(Date.now()));

      const listenerA = await startSyncListener(replicaA_sql, registryA);
      const listenerB = await startSyncListener(replicaB_sql, registryB);

      try {
        const envelopeId = randomUUID();
        const { EnvelopeId } = await import("../../../src/ids.ts");
        const envResult = EnvelopeId.parse(envelopeId);
        assert(envResult.ok, "fixture: invalid EnvelopeId");

        // Register a waiter only on replica A.
        const deferredA = registryA.register(envResult.value);
        assert(deferredA.ok, "fixture: register must succeed");
        expect(registryA.pending()).toBe(1);
        expect(registryB.pending()).toBe(0);

        const sessionId = await insertSession(sql, agentId, tenantId, envelopeId);
        await insertTurn(sql, sessionId, agentId, tenantId);

        await closeSession(sql, clock, {
          sessionId,
          agentId,
          tenantId,
          reason: { kind: "end_turn" },
        });

        // Awaiting the deferred proves replica A's listener received the NOTIFY.
        const outcome = await deferredA.value;
        expect(outcome.kind).toBe("closed");

        // Replica A's waiter was consumed; B never had one (pending stays 0).
        expect(registryA.pending()).toBe(0);
        expect(registryB.pending()).toBe(0);
      } finally {
        await listenerA.stop();
        await listenerB.stop();
        await replicaA_sql.end({ timeout: 3 });
        await replicaB_sql.end({ timeout: 3 });
      }
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "validation failure returns 400",
    async () => {
      const app = requireApp();
      const res = await postTrigger(app, { tenantId: randomUUID() }); // missing fields
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { kind: string } };
      expect(body.error.kind).toBe("validation_failed");
    },
    HOOK_TIMEOUT_MS,
  );
});
