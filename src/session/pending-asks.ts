// Pending-ask ledger operations.
// Each ask dispatched from a parent session to a child session gets a row here,
// so quiesceSession knows which parent to reply to on child completion.

import type { Sql } from "postgres";
import { assert } from "../core/assert.ts";
import { WorkItemId, mintId } from "../ids.ts";
import { ToolUseId } from "../ids.ts";
import type { SessionId, TenantId, ToolUseId as ToolUseIdBrand } from "../ids.ts";

export type WritePendingAskSpec = Readonly<{
  tenantId: TenantId;
  parentSessionId: SessionId;
  childSessionId: SessionId;
  parentToolUseId: ToolUseIdBrand;
}>;

export type PendingAskResolvedRow = {
  readonly id: string;
  readonly parentToolUseId: ToolUseIdBrand;
};

export type ResolveKind = "reply_routed" | "timeout" | "late_reply_dropped";

export async function writePendingAsk(sql: Sql, spec: WritePendingAskSpec): Promise<void> {
  assert(spec.parentToolUseId.length > 0, "writePendingAsk: parentToolUseId non-empty");
  assert(spec.parentSessionId.length > 0, "writePendingAsk: parentSessionId non-empty");
  assert(spec.childSessionId.length > 0, "writePendingAsk: childSessionId non-empty");
  assert(spec.tenantId.length > 0, "writePendingAsk: tenantId non-empty");

  const id = mintId(WorkItemId.parse, "writePendingAsk");

  await sql`
    INSERT INTO session_pending_asks
      (id, tenant_id, parent_session_id, child_session_id, parent_tool_use_id)
    VALUES
      (${id}, ${spec.tenantId}, ${spec.parentSessionId}, ${spec.childSessionId}, ${spec.parentToolUseId})
    ON CONFLICT (parent_session_id, parent_tool_use_id) DO NOTHING
  `;
}

// Returns the most recent unresolved ask row for the given child session, or null.
export async function readMostRecentUnresolved(
  sql: Sql,
  childSessionId: SessionId,
): Promise<PendingAskResolvedRow | null> {
  assert(childSessionId.length > 0, "readMostRecentUnresolved: childSessionId non-empty");

  const rows = await sql<{ readonly id: string; readonly parent_tool_use_id: string }[]>`
    SELECT id, parent_tool_use_id
    FROM session_pending_asks
    WHERE child_session_id = ${childSessionId}
      AND resolved_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `;

  if (rows.length === 0) return null;

  const row = rows[0];
  assert(row !== undefined, "readMostRecentUnresolved: row must exist");

  const toolUseIdResult = ToolUseId.parse(row.parent_tool_use_id);
  assert(toolUseIdResult.ok, "readMostRecentUnresolved: invalid parent_tool_use_id from DB", {
    id: row.parent_tool_use_id,
  });

  return { id: row.id, parentToolUseId: toolUseIdResult.value };
}

export async function markResolved(
  sql: Sql,
  rowId: string,
  kind: ResolveKind,
  now: Date,
): Promise<void> {
  assert(rowId.length > 0, "markResolved: rowId non-empty");
  await sql`
    UPDATE session_pending_asks
    SET resolved_at = ${now}, resolved_kind = ${kind}
    WHERE id = ${rowId} AND resolved_at IS NULL
  `;
}

export async function markCascadeOrphaned(
  sql: Sql,
  childSessionId: SessionId,
  now: Date,
): Promise<void> {
  assert(childSessionId.length > 0, "markCascadeOrphaned: childSessionId non-empty");
  await sql`
    UPDATE session_pending_asks
    SET resolved_at = ${now}, resolved_kind = 'cascade_orphan'
    WHERE child_session_id = ${childSessionId} AND resolved_at IS NULL
  `;
}
