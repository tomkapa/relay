// Find an open child session by (parent_session_id, agent_id).
// Returns the child session id or null if none exists.

import type { Sql } from "postgres";
import { assert } from "../core/assert.ts";
import { SessionId } from "../ids.ts";
import type { AgentId, SessionId as SessionIdBrand, TenantId } from "../ids.ts";

export type FindOpenChildSpec = Readonly<{
  parentSessionId: SessionIdBrand;
  targetAgentId: AgentId;
  tenantId: TenantId;
}>;

export async function findOpenChildSession(
  sql: Sql,
  spec: FindOpenChildSpec,
): Promise<{ readonly childSessionId: SessionIdBrand } | null> {
  assert(spec.parentSessionId.length > 0, "findOpenChildSession: parentSessionId non-empty");
  assert(spec.targetAgentId.length > 0, "findOpenChildSession: targetAgentId non-empty");
  assert(spec.tenantId.length > 0, "findOpenChildSession: tenantId non-empty");

  const rows = await sql<{ readonly id: string }[]>`
    SELECT id FROM sessions
    WHERE parent_session_id = ${spec.parentSessionId}
      AND agent_id = ${spec.targetAgentId}
      AND tenant_id = ${spec.tenantId}
      AND closed_at IS NULL
    LIMIT 1
  `;

  if (rows.length === 0) return null;

  const row = rows[0];
  assert(row !== undefined, "findOpenChildSession: row must exist");

  const parsed = SessionId.parse(row.id);
  assert(parsed.ok, "findOpenChildSession: invalid session id from DB", { id: row.id });

  return { childSessionId: parsed.value };
}
