import path from "node:path";
import { describe } from "bun:test";
import type { Sql } from "postgres";

export const DB_URL = process.env["INTEGRATION_DATABASE_URL"];
export const MIGRATIONS_DIR = path.resolve(import.meta.dir, "../../src/db/migrations");
export const HOOK_TIMEOUT_MS = 30_000;
export const describeOrSkip = DB_URL ? describe : describe.skip;

export async function resetDb(s: Sql): Promise<void> {
  await s.unsafe(`
    DROP TABLE IF EXISTS trigger_envelopes CASCADE;
    DROP TABLE IF EXISTS work_queue CASCADE;
    DROP TABLE IF EXISTS tasks CASCADE;
    DROP TABLE IF EXISTS sessions CASCADE;
    DROP TABLE IF EXISTS agents CASCADE;
    DROP TABLE IF EXISTS _migrations CASCADE;
    DROP EXTENSION IF EXISTS vector CASCADE;
  `);
}
