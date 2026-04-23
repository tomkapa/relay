// Unit tests for POST /trigger route. Uses fake sql + fake registry; no real DB or network.

import { beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { Hono } from "hono";
import { assert } from "../../../src/core/assert.ts";
import { FakeClock } from "../../../src/core/clock.ts";
import { err } from "../../../src/core/result.ts";
import { SessionId } from "../../../src/ids.ts";
import type { SessionId as SessionIdBrand } from "../../../src/ids.ts";
import {
  makeReplyRegistry,
  type ReplyRegistry,
  type SyncOutcome,
} from "../../../src/http/reply-registry.ts";
import { triggerRoute } from "../../../src/http/routes/trigger.ts";
import { _setMeterForTest } from "../../../src/telemetry/otel.ts";
import { MAX_MESSAGE_CONTENT_BYTES } from "../../../src/trigger/limits.ts";

_setMeterForTest(undefined);

// Fake sql that handles tagged template calls as a queue of pre-canned responses.
// Also has a no-op .notify stub so emitSessionSyncClose-related paths don't throw.
type FakeRow = Record<string, unknown>;

function makeFakeSql(responses: FakeRow[][] = []): Sql {
  let idx = 0;
  const tag = () => {
    const resp = responses[idx];
    idx++;
    return Promise.resolve(resp ?? []);
  };
  (tag as unknown as Record<string, unknown>)["json"] = (v: unknown) => v;
  (tag as unknown as Record<string, unknown>)["notify"] = () => Promise.resolve();
  return tag as unknown as Sql;
}

function makeSessionId(): SessionIdBrand {
  const r = SessionId.parse(randomUUID());
  assert(r.ok, "fixture: invalid SessionId");
  return r.value;
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenantId: randomUUID(),
    targetAgentId: randomUUID(),
    sender: { type: "human", id: "user-1" },
    content: "Hello, agent!",
    ...overrides,
  };
}

async function postTrigger(app: Hono, body: unknown): Promise<Response> {
  return app.request("/trigger", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// A registry that immediately resolves any registered waiter with a preset outcome.
function makePreloadedRegistry(outcome: SyncOutcome, clock: FakeClock): ReplyRegistry {
  const inner = makeReplyRegistry(clock);
  return {
    register(envelopeId) {
      const result = inner.register(envelopeId);
      if (result.ok) {
        inner.resolve(envelopeId, outcome);
      }
      return result;
    },
    resolve: inner.resolve.bind(inner),
    drop: inner.drop.bind(inner),
    pending: inner.pending.bind(inner),
  };
}

describe("POST /trigger", () => {
  let clock: FakeClock;

  beforeEach(() => {
    clock = new FakeClock(1_700_000_000_000);
  });

  describe("validation", () => {
    test("missing content returns 400 validation_failed", async () => {
      const sql = makeFakeSql();
      const registry = makeReplyRegistry(clock);
      const app = triggerRoute({ sql, clock, registry });

      const res = await postTrigger(app, validBody({ content: undefined }));
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: { kind: string } };
      expect(json.error.kind).toBe("validation_failed");
    });

    test("invalid JSON body returns 400 validation_failed", async () => {
      const sql = makeFakeSql();
      const registry = makeReplyRegistry(clock);
      const app = triggerRoute({ sql, clock, registry });

      const res = await app.request("/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{{bad json",
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: { kind: string } };
      expect(json.error.kind).toBe("validation_failed");
    });

    test("invalid tenantId (not uuid) returns 400 tenant_id_invalid", async () => {
      const sql = makeFakeSql();
      const registry = makeReplyRegistry(clock);
      const app = triggerRoute({ sql, clock, registry });

      const res = await postTrigger(app, validBody({ tenantId: "not-a-uuid" }));
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: { kind: string } };
      // Zod catches the uuid shape first → validation_failed, or TenantId.parse catches it after → tenant_id_invalid
      expect(["validation_failed", "tenant_id_invalid"].includes(json.error.kind)).toBe(true);
    });

    test("content too long returns 400 validation_failed", async () => {
      const sql = makeFakeSql();
      const registry = makeReplyRegistry(clock);
      const app = triggerRoute({ sql, clock, registry });

      const res = await postTrigger(
        app,
        validBody({ content: "x".repeat(MAX_MESSAGE_CONTENT_BYTES + 1) }),
      );
      expect(res.status).toBe(400);
    });

    test("unknown top-level key returns 400 (strict schema)", async () => {
      const sql = makeFakeSql();
      const registry = makeReplyRegistry(clock);
      const app = triggerRoute({ sql, clock, registry });

      const res = await postTrigger(app, validBody({ rogue: "field" }));
      expect(res.status).toBe(400);
    });
  });

  describe("capacity exhausted", () => {
    test("registry at capacity returns 503 sync_capacity_exhausted", async () => {
      // Use a registry that always returns capacity error.
      const registry: ReplyRegistry = {
        register: () => err({ kind: "sync_capacity_exhausted", cap: 1_000 }),
        resolve: () => {
          return;
        },
        drop: () => {
          return;
        },
        pending: () => 1_000,
      };

      // SQL needs 1 response for writeEnvelope INSERT (returns empty = success)
      const fakeSql = makeFakeSql([[]]);
      const app = triggerRoute({ sql: fakeSql, clock, registry });

      const res = await postTrigger(app, validBody());
      expect(res.status).toBe(503);
      const json = (await res.json()) as { error: { kind: string } };
      expect(json.error.kind).toBe("sync_capacity_exhausted");
    });
  });

  describe("timeout", () => {
    test("unresolved registry returns 504 after maxWaitMs", async () => {
      const registry = makeReplyRegistry(clock);
      const smallWaitMs = 10;

      // Fake sql: writeEnvelope INSERT (empty ok), enqueue INSERT (returns id row)
      const fakeSql = makeFakeSql([[], [{ id: randomUUID() }]]);
      const app = triggerRoute({ sql: fakeSql, clock, registry, maxWaitMs: smallWaitMs });

      const pending = postTrigger(app, validBody());

      // Yield microtasks to let the route handler reach Promise.race, then advance clock.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      clock.advance(smallWaitMs + 1);

      const res = await pending;
      expect(res.status).toBe(504);
      const json = (await res.json()) as { session_id: null; error: { kind: string } };
      expect(json.session_id).toBeNull();
      expect(json.error.kind).toBe("sync_wait_timeout");
    });
  });

  describe("success", () => {
    test("resolved session returns 200 with session_id text stop_reason usage", async () => {
      const sessionId = makeSessionId();
      const closedOutcome: SyncOutcome = { kind: "closed", sessionId, reason: "end_turn" };
      const registry = makePreloadedRegistry(closedOutcome, clock);

      const fakeResponse = {
        content: [{ type: "text", text: "Hello there!" }],
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5 },
      };

      // SQL responses:
      // 1. writeEnvelope INSERT → empty (success, no RETURNING in writeEnvelope)
      // 2. enqueue INSERT → returns id row
      // 3. readFinalTurnResponse SELECT → returns turn row
      const fakeSql = makeFakeSql([[], [{ id: randomUUID() }], [{ response: fakeResponse }]]);
      const app = triggerRoute({ sql: fakeSql, clock, registry });

      const res = await postTrigger(app, validBody());
      expect(res.status).toBe(200);
      const json = (await res.json()) as { session_id: string; text: string; stop_reason: string };
      expect(json.session_id).toBe(sessionId as string);
      expect(json.text).toBe("Hello there!");
      expect(json.stop_reason).toBe("end_turn");
    });

    test("no text blocks returns empty string in text field", async () => {
      const sessionId = makeSessionId();
      const closedOutcome: SyncOutcome = { kind: "closed", sessionId, reason: "end_turn" };
      const registry = makePreloadedRegistry(closedOutcome, clock);

      const fakeResponse = {
        content: [{ type: "tool_use", id: "t1", name: "my_tool", input: {} }],
        stopReason: "tool_use",
        usage: { inputTokens: 5, outputTokens: 2 },
      };

      const fakeSql = makeFakeSql([[], [{ id: randomUUID() }], [{ response: fakeResponse }]]);
      const app = triggerRoute({ sql: fakeSql, clock, registry });

      const res = await postTrigger(app, validBody());
      expect(res.status).toBe(200);
      const json = (await res.json()) as { text: string };
      expect(json.text).toBe("");
    });

    test("no turns in DB returns 500 session_failed", async () => {
      const sessionId = makeSessionId();
      const closedOutcome: SyncOutcome = { kind: "closed", sessionId, reason: "end_turn" };
      const registry = makePreloadedRegistry(closedOutcome, clock);

      // readFinalTurnResponse SELECT returns empty — no turns
      const fakeSql = makeFakeSql([[], [{ id: randomUUID() }], []]);
      const app = triggerRoute({ sql: fakeSql, clock, registry });

      const res = await postTrigger(app, validBody());
      expect(res.status).toBe(500);
      const json = (await res.json()) as { session_id: string; error: { kind: string } };
      expect(json.session_id).toBe(sessionId as string);
      expect(json.error.kind).toBe("session_failed");
    });
  });
});
