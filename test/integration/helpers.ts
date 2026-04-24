import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe } from "bun:test";
import type { Sql } from "postgres";
import { assert } from "../../src/core/assert.ts";
import { idempotencyKey, type IdempotencyKey } from "../../src/core/idempotency.ts";
import { SessionId, TurnId } from "../../src/ids.ts";
import { WRITER } from "../../src/memory/insert.ts";

export const DB_URL = process.env["INTEGRATION_DATABASE_URL"];
export const MIGRATIONS_DIR = path.resolve(import.meta.dir, "../../src/db/migrations");
export const HOOK_TIMEOUT_MS = 30_000;
export const describeOrSkip = DB_URL ? describe : describe.skip;

export async function resetDb(s: Sql): Promise<void> {
  await s.unsafe(`
    DROP TABLE IF EXISTS inbound_messages CASCADE;
    DROP TABLE IF EXISTS turns CASCADE;
    DROP TABLE IF EXISTS trigger_envelopes CASCADE;
    DROP TABLE IF EXISTS work_queue CASCADE;
    DROP TABLE IF EXISTS memory CASCADE;
    DROP TABLE IF EXISTS tasks CASCADE;
    DROP TABLE IF EXISTS sessions CASCADE;
    DROP TABLE IF EXISTS agents CASCADE;
    DROP TABLE IF EXISTS _migrations CASCADE;
    DROP EXTENSION IF EXISTS vector CASCADE;
  `);
}

export function makeTestKey(): IdempotencyKey {
  const r1 = SessionId.parse(randomUUID());
  const r2 = TurnId.parse(randomUUID());
  assert(r1.ok, "fixture: invalid SessionId");
  assert(r2.ok, "fixture: invalid TurnId");
  return idempotencyKey({
    writer: WRITER,
    sessionId: r1.value,
    turnId: r2.value,
    toolCallId: randomUUID(),
  });
}
