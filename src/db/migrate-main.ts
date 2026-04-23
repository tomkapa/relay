// Migration runner entrypoint. Same image, different command — run before starting
// the HTTP server or worker to bring the schema up to date.
// Usage: bun run src/db/migrate-main.ts
//
// Exits 0 on success, 1 on any error. Prints applied/skipped versions to stdout.

import path from "node:path";
import { assert } from "../core/assert.ts";
import { connect } from "./client.ts";
import { migrate } from "./migrate-apply.ts";

const DATABASE_URL = process.env["DATABASE_URL"];
assert(DATABASE_URL !== undefined && DATABASE_URL.length > 0, "migrate: DATABASE_URL must be set");

const migrationsDir = path.resolve(import.meta.dirname, "migrations");

const sql = connect({ url: DATABASE_URL, applicationName: "relay-migrate" });

const result = await migrate(sql, migrationsDir);

await sql.end({ timeout: 5 });

if (!result.ok) {
  process.stderr.write(`migration failed: ${JSON.stringify(result.error, null, 2)}\n`);
  process.exit(1);
}

const { applied, skipped } = result.value;
process.stdout.write(`applied: [${applied.join(", ") || "none"}]\n`);
process.stdout.write(`skipped: [${skipped.join(", ") || "none"}]\n`);
