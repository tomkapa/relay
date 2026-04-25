// Fake Sql for unit tests that need the turn loop without a real Postgres instance.
// Returns appropriate fake rows for hook_audit and agent queries so evaluateHook
// succeeds. Not suitable for testing DB-specific behavior — use integration tests for that.

import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { TenantId } from "../../src/ids.ts";

// Build a fake sql handle that handles hook-audit-related queries.
// tenantId: the tenant ID to return for agent lookups (must match the test's tenantId).
export function makeFakeSql(tenantId: TenantId): Sql {
  const tenantIdStr: string = tenantId;
  const fake = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const firstChunk = strings[0] ?? "";

    if (firstChunk.includes("SELECT tenant_id FROM agents")) {
      // insertHookAudit agent lookup — return matching tenant so the check passes.
      return Promise.resolve([{ tenant_id: tenantIdStr }]);
    }

    if (firstChunk.includes("INSERT INTO hook_audit")) {
      // insertHookAudit INSERT RETURNING — return a minimal valid row.
      return Promise.resolve([
        {
          id: randomUUID(),
          hook_id: "test/stub",
          layer: "system",
          event: "pre_tool_use",
          matcher_result: true,
          decision: "approve",
          reason: null,
          latency_ms: 0,
          tenant_id: tenantIdStr,
          session_id: null,
          agent_id: randomUUID(),
          turn_id: null,
          tool_name: null,
          created_at: new Date(),
        },
      ]);
    }

    // INSERT INTO pending_system_messages, UPDATE pending_system_messages,
    // INSERT INTO turns, UPDATE consumed_by_turn — all return empty.
    return Promise.resolve([]);
  };

  Object.assign(fake, {
    json: (v: unknown) => v,
    // sql.begin(fn) — run fn with the same fake handle (no real transaction).
    begin: (fn: (tx: unknown) => Promise<unknown>) => fn(fake),
    unsafe: () => Promise.resolve([]),
  });

  return fake as unknown as Sql;
}
