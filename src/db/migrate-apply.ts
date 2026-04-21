// DB-touching migration shell. Reads/writes the `_migrations` table and applies pending
// migrations in their own transactions. Pure decision logic lives in `migrate.ts`; this
// file is covered by the integration suite (test/integration/db/migrate.test.ts), not unit
// tests, per CLAUDE.md §3 (real Postgres for integration, never mocked).

import type { Sql } from "postgres";
import { err, ok, type Result } from "../core/result.ts";
import { MIGRATION_STATEMENT_TIMEOUT_MS } from "./limits.ts";
import { Attr, SpanName, emit, withSpan } from "../telemetry/otel.ts";
import {
  loadMigrations,
  planMigrations,
  type AppliedRow,
  type Migration,
  type MigrationError,
  type MigrationResult,
} from "./migrate.ts";

async function ensureTrackingTable(sql: Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      filename    TEXT NOT NULL,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}

async function readApplied(sql: Sql): Promise<Map<number, AppliedRow>> {
  const rows = await sql<
    AppliedRow[]
  >`SELECT version, filename, checksum FROM _migrations ORDER BY version`;
  const map = new Map<number, AppliedRow>();
  for (const r of rows) map.set(r.version, r);
  return map;
}

async function applyOne(sql: Sql, m: Migration): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = ${MIGRATION_STATEMENT_TIMEOUT_MS.toString()}`);
    await tx.unsafe(m.sql);
    await tx`
      INSERT INTO _migrations (version, name, filename, checksum)
      VALUES (${m.version}, ${m.name}, ${m.filename}, ${m.checksum})
    `;
  });
}

// Apply pending migrations in version order. Each migration runs in its own transaction
// with a bounded statement timeout. Already-applied migrations are verified by checksum;
// a mismatch fails loudly rather than silently drifting (CLAUDE.md §14).
export async function migrate(
  sql: Sql,
  dir: string,
): Promise<Result<MigrationResult, MigrationError>> {
  return withSpan(SpanName.ConnectorDispatch, { "relay.db.op": "migrate" }, async (span) => {
    const loaded = await loadMigrations(dir);
    if (!loaded.ok) return loaded;

    await ensureTrackingTable(sql);
    const applied = await readApplied(sql);
    const plan = planMigrations(loaded.value, applied);
    if (!plan.ok) return plan;

    const appliedVersions: number[] = [];
    const skippedVersions: number[] = [];

    for (const op of plan.value) {
      if (op.kind === "skip") {
        skippedVersions.push(op.version);
        continue;
      }
      try {
        await applyOne(sql, op.migration);
      } catch (e) {
        return err({
          kind: "apply_failed",
          version: op.migration.version,
          filename: op.migration.filename,
          cause: (e as Error).message,
        });
      }
      appliedVersions.push(op.migration.version);
      emit("INFO", "db.migration.applied", {
        "relay.db.migration.version": op.migration.version,
        "relay.db.migration.filename": op.migration.filename,
      });
    }

    span.setAttribute(Attr.TriggerKind, "migrate");
    span.setAttribute("relay.db.migrations.applied", appliedVersions.length);
    span.setAttribute("relay.db.migrations.skipped", skippedVersions.length);

    return ok({ applied: appliedVersions, skipped: skippedVersions });
  });
}
