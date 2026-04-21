// Postgres client factory. Single point of configuration so pool sizing, timeouts, and
// prepared-statement settings are applied uniformly (CLAUDE.md §9 — static allocation).
// The source of truth for structured state per SPEC.md §Architecture.

import postgres, { type Sql } from "postgres";
import { assert } from "../core/assert.ts";
import { CONNECT_TIMEOUT_MS, DEFAULT_POOL_MAX, DEFAULT_STATEMENT_TIMEOUT_MS } from "./limits.ts";

export type ConnectOptions = {
  readonly url: string;
  readonly poolMax?: number;
  readonly statementTimeoutMs?: number;
  readonly applicationName?: string;
};

// Create a postgres.js client. Callers are expected to reuse the returned `Sql` for the
// lifetime of the process and call `sql.end()` on shutdown.
export function connect(opts: ConnectOptions): Sql {
  assert(opts.url.length > 0, "db: empty url");
  const poolMax = opts.poolMax ?? DEFAULT_POOL_MAX;
  assert(poolMax > 0 && poolMax <= 1000, "db: poolMax out of range", { poolMax });
  const statementTimeoutMs = opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  assert(statementTimeoutMs > 0, "db: statementTimeoutMs must be positive");

  return postgres(opts.url, {
    max: poolMax,
    connect_timeout: Math.ceil(CONNECT_TIMEOUT_MS / 1000),
    idle_timeout: 30,
    prepare: true,
    connection: {
      application_name: opts.applicationName ?? "relay",
      statement_timeout: statementTimeoutMs,
    },
  });
}
