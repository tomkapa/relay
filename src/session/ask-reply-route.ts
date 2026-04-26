// Shared routing of a child session's final assistant text back to its parent as
// an inbound message. Used by both the quiescence path (child's loop ended with
// pending ask) and the close path (cascade-close edge case where a child happens
// to terminate carrying parent_tool_use_id metadata).

import type { Sql } from "postgres";
import { assert } from "../core/assert.ts";
import { err, ok, type Result } from "../core/result.ts";
import { idempotencyKeyForAskReply, idempotencyKeyToUuid } from "../core/idempotency.ts";
import {
  SessionId,
  WorkItemId,
  type AgentId,
  type SessionId as SessionIdBrand,
  type TenantId as TenantIdBrand,
  type ToolUseId as ToolUseIdBrand,
} from "../ids.ts";
import { writeInboundMessage } from "../trigger/inbound/inbound-ops.ts";
import { enqueue } from "../work_queue/queue-ops.ts";
import { readFinalTurnResponse } from "./read-final-turn.ts";

export type AskReplyRouteSpec = Readonly<{
  childSessionId: SessionIdBrand;
  parentSessionId: string;
  parentToolUseId: ToolUseIdBrand;
  tenantId: TenantIdBrand;
  childAgentId: AgentId;
  now: Date;
  noResponseFallback: string;
}>;

export type AskReplyRouteDrop =
  | { kind: "parent_not_found" }
  | { kind: "parent_closed" }
  | { kind: "write_inbound_failed"; detail: string }
  | { kind: "enqueue_failed"; detail: string };

export async function readChildFinalText(
  sql: Sql,
  childSessionId: SessionIdBrand,
  fallback: string,
): Promise<string> {
  const finalResult = await readFinalTurnResponse(sql, childSessionId);
  return finalResult.ok && finalResult.value.text.length > 0 ? finalResult.value.text : fallback;
}

// Routes the reply: parent-open check → write inbound → enqueue work item.
// Returns ok(undefined) on success or err(drop_reason). Caller owns logging,
// metric attribution, and any ledger updates.
export async function routeAskReplyToParent(
  sql: Sql,
  spec: AskReplyRouteSpec,
  finalText: string,
): Promise<Result<void, AskReplyRouteDrop>> {
  const parentRows = await sql<{ closed_at: Date | null }[]>`
    SELECT closed_at FROM sessions
    WHERE id = ${spec.parentSessionId} AND tenant_id = ${spec.tenantId}
  `;
  if (parentRows.length === 0) return err({ kind: "parent_not_found" });
  const parentRow = parentRows[0];
  assert(parentRow !== undefined, "routeAskReplyToParent: parentRow must exist");
  if (parentRow.closed_at !== null) return err({ kind: "parent_closed" });

  const parentSessResult = SessionId.parse(spec.parentSessionId);
  assert(parentSessResult.ok, "routeAskReplyToParent: invalid parentSessionId", {
    id: spec.parentSessionId,
  });

  const iKey = idempotencyKeyForAskReply({
    childSessionId: spec.childSessionId,
    parentToolUseId: spec.parentToolUseId,
  });
  const workItemIdResult = WorkItemId.parse(idempotencyKeyToUuid(iKey));
  assert(workItemIdResult.ok, "routeAskReplyToParent: invalid work item UUID");

  const inboundResult = await writeInboundMessage(sql, {
    tenantId: spec.tenantId,
    targetSessionId: parentSessResult.value,
    sender: { type: "agent", id: spec.childAgentId },
    content: finalText,
    receivedAt: spec.now,
    sourceWorkItemId: workItemIdResult.value,
    sourceToolUseId: spec.parentToolUseId,
  });
  if (!inboundResult.ok) {
    return err({ kind: "write_inbound_failed", detail: inboundResult.error.kind });
  }

  const workResult = await enqueue(sql, {
    tenantId: spec.tenantId,
    kind: "inbound_message",
    payloadRef: inboundResult.value,
    scheduledAt: spec.now,
  });
  if (!workResult.ok) {
    return err({ kind: "enqueue_failed", detail: workResult.error.kind });
  }

  return ok(undefined);
}
