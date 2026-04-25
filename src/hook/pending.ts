// Durable queue for deny reasons waiting to surface as synthetic messages on the next turn.
// drainPendingSystemMessages: UPDATE consumed_at (marks drained) + RETURNING content.
// consumed_by_turn is filled later, inside the same transaction as insertTurn (CLAUDE.md §5).

import type { Sql, TransactionSql } from "postgres";
import { assert } from "../core/assert.ts";
import { err, ok, type Result } from "../core/result.ts";
import {
  PendingSystemMessageId,
  mintId,
  type HookAuditId,
  type PendingSystemMessageId as PendingSystemMessageIdBrand,
  type SessionId,
  type TenantId,
  type TurnId,
} from "../ids.ts";
import { MAX_PENDING_MESSAGES_PER_TURN } from "./limits.ts";

export type EnqueueInput = {
  readonly tenantId: TenantId;
  readonly targetSessionId: SessionId;
  readonly kind: "hook_deny";
  readonly hookAuditId: HookAuditId;
  readonly content: string;
};

export type DrainInput = {
  readonly targetSessionId: SessionId;
  readonly tenantId: TenantId;
};

export type DrainedRow = {
  readonly id: PendingSystemMessageIdBrand;
  readonly content: string;
  readonly hookAuditId: HookAuditId;
  readonly createdAt: Date;
};

export type EnqueuePendingError = { readonly kind: "enqueue_failed"; readonly detail: string };
export type DrainPendingError = { readonly kind: "drain_failed"; readonly detail: string };

type PendingDbRow = {
  readonly id: string;
  readonly content: string;
  readonly hook_audit_id: string;
  readonly created_at: Date;
  readonly consumed_at: Date | null;
};

function toDrainedRow(row: PendingDbRow): DrainedRow {
  const parsedId = PendingSystemMessageId.parse(row.id);
  assert(parsedId.ok, "drainPendingSystemMessages: id from DB is invalid", { id: row.id });
  assert(row.consumed_at !== null, "drainPendingSystemMessages: UPDATE did not stamp consumed_at", {
    id: row.id,
  });
  return {
    id: parsedId.value,
    content: row.content,
    hookAuditId: row.hook_audit_id as HookAuditId,
    createdAt: row.created_at,
  };
}

export async function enqueuePendingSystemMessage(
  tx: Sql | TransactionSql,
  input: EnqueueInput,
): Promise<Result<void, EnqueuePendingError>> {
  assert(input.content.length > 0, "enqueuePendingSystemMessage: content must be non-empty");

  const id = mintId(PendingSystemMessageId.parse, "enqueuePendingSystemMessage");

  try {
    await tx`
      INSERT INTO pending_system_messages (
        id, tenant_id, target_session_id, kind, hook_audit_id, content
      ) VALUES (
        ${id},
        ${input.tenantId},
        ${input.targetSessionId},
        ${input.kind},
        ${input.hookAuditId},
        ${input.content}
      )
    `;
    return ok(undefined);
  } catch (e) {
    return err({ kind: "enqueue_failed", detail: (e as Error).message });
  }
}

export async function drainPendingSystemMessages(
  sql: Sql | TransactionSql,
  input: DrainInput,
): Promise<Result<readonly DrainedRow[], DrainPendingError>> {
  try {
    // CTE wraps UPDATE RETURNING so ORDER BY can be applied — RETURNING alone has no order guarantee.
    const rows = await sql<PendingDbRow[]>`
      WITH updated AS (
        UPDATE pending_system_messages
        SET consumed_at = now()
        WHERE id IN (
          SELECT id FROM pending_system_messages
          WHERE target_session_id = ${input.targetSessionId}
            AND consumed_at IS NULL
          ORDER BY created_at
          LIMIT ${MAX_PENDING_MESSAGES_PER_TURN}
        )
        RETURNING id, content, hook_audit_id, created_at, consumed_at
      )
      SELECT id, content, hook_audit_id, created_at, consumed_at FROM updated ORDER BY created_at
    `;

    assert(
      rows.length <= MAX_PENDING_MESSAGES_PER_TURN,
      "drainPendingSystemMessages: result exceeded cap",
      { count: rows.length, cap: MAX_PENDING_MESSAGES_PER_TURN },
    );

    return ok(rows.map(toDrainedRow));
  } catch (e) {
    return err({ kind: "drain_failed", detail: (e as Error).message });
  }
}

// Mark drained messages with the turn ID that consumed them. Called inside the
// insertTurn transaction so consumed_by_turn is set atomically with the turn row.
export async function markPendingMessagesConsumed(
  tx: TransactionSql,
  ids: readonly PendingSystemMessageIdBrand[],
  consumedByTurn: TurnId,
): Promise<void> {
  if (ids.length === 0) return;
  assert(
    ids.length <= MAX_PENDING_MESSAGES_PER_TURN,
    "markPendingMessagesConsumed: ids exceed cap",
  );

  const idStrings = ids.map((id) => id as string);
  await tx`
    UPDATE pending_system_messages
    SET consumed_by_turn = ${consumedByTurn as string}
    WHERE id = ANY(${idStrings}::uuid[])
      AND consumed_at IS NOT NULL
  `;
}
