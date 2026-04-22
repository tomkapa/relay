// Integration tests for POST /agents via the Hono app.
// Uses app.request() — no real socket needed.
// Real Postgres per CLAUDE.md §3; skipped when INTEGRATION_DATABASE_URL is unset.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import type { Hono } from "hono";
import { assert } from "../../../src/core/assert.ts";
import { FakeClock } from "../../../src/core/clock.ts";
import { migrate } from "../../../src/db/migrate-apply.ts";
import { makeApp } from "../../../src/http/app.ts";
import { MAX_REQUEST_BYTES } from "../../../src/http/limits.ts";
import { MAX_SYSTEM_PROMPT_LEN } from "../../../src/agent/limits.ts";
import { DB_URL, HOOK_TIMEOUT_MS, MIGRATIONS_DIR, describeOrSkip, resetDb } from "../helpers.ts";

let sqlRef: Sql | undefined;
let appRef: Hono | undefined;

function requireSql(): Sql {
  assert(sqlRef !== undefined, "integration test: sql initialized by beforeAll");
  return sqlRef;
}

function requireApp(): Hono {
  assert(appRef !== undefined, "integration test: app initialized by beforeAll");
  return appRef;
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenantId: randomUUID(),
    systemPrompt: "You are a helpful assistant.",
    toolSet: [],
    hookRules: [],
    ...overrides,
  };
}

async function post(app: Hono, body: unknown): Promise<Response> {
  return app.request("/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  if (!DB_URL) return;
  const s = postgres(DB_URL, { max: 4, idle_timeout: 2 });
  await s`SELECT 1`;
  await resetDb(s);
  const mig = await migrate(s, MIGRATIONS_DIR);
  if (!mig.ok) throw new Error(`migration setup failed: ${mig.error.kind}`);
  sqlRef = s;
  appRef = makeApp({ sql: s, clock: new FakeClock(1_700_000_000_000) });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  if (sqlRef !== undefined) await sqlRef.end({ timeout: 5 });
}, 10_000);

beforeEach(async () => {
  if (!DB_URL) return;
  const s = requireSql();
  await s`TRUNCATE TABLE agents CASCADE`;
});

describeOrSkip("POST /agents (integration)", () => {
  test(
    "valid request returns 201 with id and createdAt",
    async () => {
      const app = requireApp();
      const res = await post(app, validBody());
      expect(res.status).toBe(201);
      const json = (await res.json()) as { id: string; createdAt: string };
      expect(typeof json.id).toBe("string");
      expect(typeof json.createdAt).toBe("string");
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "valid request inserts a row in agents table",
    async () => {
      const app = requireApp();
      const sql = requireSql();
      const res = await post(app, validBody());
      expect(res.status).toBe(201);
      const json = (await res.json()) as { id: string };
      const rows = await sql<{ id: string }[]>`SELECT id FROM agents WHERE id = ${json.id}`;
      expect(rows.length).toBe(1);
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "invalid JSON body returns 400",
    async () => {
      const app = requireApp();
      const res = await app.request("/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json{{{",
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: { kind: string } };
      expect(json.error.kind).toBe("validation_failed");
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "missing systemPrompt returns 400 with validation_failed",
    async () => {
      const app = requireApp();
      const body = Object.fromEntries(
        Object.entries(validBody()).filter(([k]) => k !== "systemPrompt"),
      );
      const res = await post(app, body);
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: { kind: string } };
      expect(json.error.kind).toBe("validation_failed");
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "systemPrompt too long returns 400 with system_prompt_too_long",
    async () => {
      const app = requireApp();
      const res = await post(
        app,
        validBody({ systemPrompt: "x".repeat(MAX_SYSTEM_PROMPT_LEN + 1) }),
      );
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: { kind: string } };
      expect(json.error.kind).toBe("system_prompt_too_long");
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "unknown top-level key returns 400 with validation_failed",
    async () => {
      const app = requireApp();
      const res = await post(app, validBody({ rogue: "field" }));
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: { kind: string } };
      expect(json.error.kind).toBe("validation_failed");
    },
    HOOK_TIMEOUT_MS,
  );

  test(
    "oversized body returns 413",
    async () => {
      const app = requireApp();
      const res = await app.request("/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "x".repeat(MAX_REQUEST_BYTES + 1),
      });
      expect(res.status).toBe(413);
    },
    HOOK_TIMEOUT_MS,
  );
});
