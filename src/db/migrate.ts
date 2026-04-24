// Versioned SQL migration runner — pure parts. The DB-touching shell lives in
// `migrate-apply.ts` so this file stays unit-testable without Postgres. CLAUDE.md §3
// allows mocking only for paid external services; the DB is not mocked, so integration
// coverage for the shell is provided by `test/integration/db/migrate.test.ts`.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { assert } from "../core/assert.ts";
import { sha256Hex } from "../core/hash.ts";
import { err, ok, type Result } from "../core/result.ts";
import { MAX_MIGRATION_FILENAME_LEN } from "./limits.ts";

// `NNNN_snake_case_name.sql` — the prefix is the authoritative version.
const FILENAME_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

// Max migration files applied per invocation. Applications with more than this accrete
// cruft — split into logical baselines (CLAUDE.md §5).
const MAX_MIGRATIONS = 10_000;

export type Migration = {
  readonly version: number;
  readonly name: string;
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
};

export type AppliedRow = {
  readonly version: number;
  readonly filename: string;
  readonly checksum: string;
};

export type MigrationError =
  | { kind: "invalid_filename"; filename: string }
  | { kind: "duplicate_version"; version: number; a: string; b: string }
  | { kind: "read_failed"; filename: string; cause: string }
  | {
      kind: "checksum_mismatch";
      version: number;
      filename: string;
      expected: string;
      actual: string;
    }
  | { kind: "apply_failed"; version: number; filename: string; cause: string };

export type MigrationOp =
  | { readonly kind: "apply"; readonly migration: Migration }
  | { readonly kind: "skip"; readonly version: number };

export type MigrationResult = {
  readonly applied: readonly number[];
  readonly skipped: readonly number[];
};

export function parseMigrationFilename(
  filename: string,
): Result<{ version: number; name: string }, MigrationError> {
  if (filename.length > MAX_MIGRATION_FILENAME_LEN) {
    return err({ kind: "invalid_filename", filename });
  }
  const m = FILENAME_RE.exec(filename);
  if (!m) return err({ kind: "invalid_filename", filename });
  const versionStr = m[1];
  const name = m[2];
  assert(versionStr !== undefined, "regex capture 1 present");
  assert(name !== undefined, "regex capture 2 present");
  const version = Number.parseInt(versionStr, 10);
  assert(Number.isInteger(version) && version >= 0, "version non-negative int", { versionStr });
  return ok({ version, name });
}

export { sha256Hex } from "../core/hash.ts";

export async function loadMigrations(
  dir: string,
): Promise<Result<readonly Migration[], MigrationError>> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (e) {
    return err({ kind: "read_failed", filename: dir, cause: (e as Error).message });
  }

  const sqlFiles = entries.filter((f) => f.endsWith(".sql")).sort();
  assert(sqlFiles.length <= MAX_MIGRATIONS, "too many migrations", { count: sqlFiles.length });

  const migrations: Migration[] = [];
  const seenVersions = new Map<number, string>();

  for (const filename of sqlFiles) {
    const parsed = parseMigrationFilename(filename);
    if (!parsed.ok) return parsed;
    const existing = seenVersions.get(parsed.value.version);
    if (existing !== undefined) {
      return err({
        kind: "duplicate_version",
        version: parsed.value.version,
        a: existing,
        b: filename,
      });
    }
    seenVersions.set(parsed.value.version, filename);

    let sql: string;
    try {
      sql = await readFile(path.join(dir, filename), "utf8");
    } catch (e) {
      return err({ kind: "read_failed", filename, cause: (e as Error).message });
    }

    migrations.push({
      version: parsed.value.version,
      name: parsed.value.name,
      filename,
      sql,
      checksum: sha256Hex(sql),
    });
  }

  migrations.sort((a, b) => a.version - b.version);
  return ok(migrations);
}

// Pure decision: given loaded migrations and the set already applied, produce the ordered
// list of ops (apply or skip). Returns `checksum_mismatch` if any applied migration's
// recorded checksum differs from the on-disk file — a refusal to silently drift
// (CLAUDE.md §14).
export function planMigrations(
  migrations: readonly Migration[],
  applied: ReadonlyMap<number, AppliedRow>,
): Result<readonly MigrationOp[], MigrationError> {
  const ops: MigrationOp[] = [];
  for (const m of migrations) {
    const prior = applied.get(m.version);
    if (prior === undefined) {
      ops.push({ kind: "apply", migration: m });
      continue;
    }
    if (prior.checksum !== m.checksum) {
      return err({
        kind: "checksum_mismatch",
        version: m.version,
        filename: m.filename,
        expected: prior.checksum,
        actual: m.checksum,
      });
    }
    ops.push({ kind: "skip", version: m.version });
  }
  return ok(ops);
}
