// Child session quiescence.
// Called instead of closeSession when a child session's turn loop ends without
// pending asks. Child sessions never set closed_at on quiescence; only cascade-terminate does.

import type { Sql } from "postgres";
import { assert } from "../core/assert.ts";
import type { Clock } from "../core/clock.ts";
import { err, ok, type Result } from "../core/result.ts";
import { firstRow } from "../db/utils.ts";
import {
  SessionId,
  TenantId,
  WorkItemId,
  type AgentId,
  type ChainId,
  type Depth,
  type SessionId as SessionIdBrand,
  type TenantId as TenantIdBrand,
  type ToolUseId as ToolUseIdBrand,
} from "../ids.ts";
import { idempotencyKeyForAskReply, idempotencyKeyToUuid } from "../core/idempotency.ts";
import { Attr, SpanName, counter, emit, withSpan } from "../telemetry/otel.ts";
import { readFinalTurnResponse } from "./read-final-turn.ts";
import { writeInboundMessage } from "../trigger/inbound/inbound-ops.ts";
import { enqueue } from "../work_queue/queue-ops.ts";
import { readMostRecentUnresolved, markResolved } from "./pending-asks.ts";

export type SessionQuiesceSpec = Readonly<{
  sessionId: SessionIdBrand;
  tenantId: TenantIdBrand;
  agentId: AgentId;
  chainId: ChainId;
  depth: Depth;
  reason: { kind: "loop_end_no_pending" };
}>;

export type SessionQuiesceError =
  | { kind: "session_not_found"; sessionId: SessionIdBrand }
  | { kind: "tenant_mismatch"; expected: TenantIdBrand; got: TenantIdBrand }
  | { kind: "session_already_terminal"; sessionId: SessionIdBrand; closedAt: Date };

export async function quiesceSession(
  sql: Sql,
  clock: Clock,
  spec: SessionQuiesceSpec,
): Promise<Result<void, SessionQuiesceError>> {
  assert(spec.sessionId.length > 0, "quiesceSession: sessionId non-empty");
  assert(spec.tenantId.length > 0, "quiesceSession: tenantId non-empty");

  return withSpan(
    SpanName.SessionQuiesce,
    {
      [Attr.SessionId]: spec.sessionId,
      [Attr.TenantId]: spec.tenantId,
      [Attr.AgentId]: spec.agentId,
    },
    async () => {
      const rows = await sql<
        {
          readonly tenant_id: string;
          readonly closed_at: Date | null;
          readonly parent_session_id: string | null;
        }[]
      >`
        SELECT tenant_id, closed_at, parent_session_id
        FROM sessions WHERE id = ${spec.sessionId}
      `;

      if (rows.length === 0) {
        return err({ kind: "session_not_found", sessionId: spec.sessionId });
      }

      const row = firstRow(rows, "quiesceSession.lookup");
      const tenantParsed = TenantId.parse(row.tenant_id);
      assert(tenantParsed.ok, "quiesceSession: invalid tenant_id from DB");

      if (tenantParsed.value !== spec.tenantId) {
        return err({ kind: "tenant_mismatch", expected: spec.tenantId, got: tenantParsed.value });
      }

      if (row.closed_at !== null) {
        return err({
          kind: "session_already_terminal",
          sessionId: spec.sessionId,
          closedAt: row.closed_at,
        });
      }

      const now = new Date(clock.now());
      const pending = await readMostRecentUnresolved(sql, spec.sessionId);
      const hasPendingAsk = pending !== null;

      if (pending !== null) {
        await routeAskReplyOnQuiesce(sql, {
          childSessionId: spec.sessionId,
          parentSessionId: row.parent_session_id,
          parentToolUseId: pending.parentToolUseId,
          pendingRowId: pending.id,
          tenantId: spec.tenantId,
          childAgentId: spec.agentId,
          now,
        });
      }

      counter("relay.session.quiesced_total").add(1, {
        [Attr.TenantId]: spec.tenantId,
        [Attr.AgentId]: spec.agentId,
        [Attr.HasPendingAsk]: hasPendingAsk,
      });
      emit("INFO", "session.quiesced", {
        [Attr.SessionId]: spec.sessionId,
        [Attr.TenantId]: spec.tenantId,
        [Attr.HasPendingAsk]: hasPendingAsk,
      });

      return ok(undefined);
    },
  );
}

type RouteSpec = {
  readonly childSessionId: SessionIdBrand;
  readonly parentSessionId: string | null;
  readonly parentToolUseId: ToolUseIdBrand;
  readonly pendingRowId: string;
  readonly tenantId: TenantIdBrand;
  readonly childAgentId: AgentId;
  readonly now: Date;
};

async function routeAskReplyOnQuiesce(sql: Sql, spec: RouteSpec): Promise<void> {
  assert(spec.pendingRowId.length > 0, "routeAskReplyOnQuiesce: pendingRowId non-empty");

  if (spec.parentSessionId === null) {
    // Child with a pending ask but no parent reference — authoring bug; log and drop.
    emit("WARN", "session.quiesce.no_parent_for_ask", {
      [Attr.SessionId]: spec.childSessionId,
      [Attr.TenantId]: spec.tenantId,
    });
    await markResolved(sql, spec.pendingRowId, "late_reply_dropped", spec.now);
    return;
  }

  try {
    const finalResult = await readFinalTurnResponse(sql, spec.childSessionId);
    const finalText =
      finalResult.ok && finalResult.value.text.length > 0
        ? finalResult.value.text
        : "<no response — session quiesced without text>";

    const parentRows = await sql<{ closed_at: Date | null }[]>`
      SELECT closed_at FROM sessions WHERE id = ${spec.parentSessionId} AND tenant_id = ${spec.tenantId}
    `;

    if (parentRows.length === 0) {
      counter("relay.session.late_reply_dropped_total").add(1, {
        [Attr.TenantId]: spec.tenantId,
        [Attr.DropReason]: "parent_not_found",
      });
      emit("WARN", "session.ask_reply.parent_not_found", {
        [Attr.SessionId]: spec.childSessionId,
        [Attr.TenantId]: spec.tenantId,
      });
      await markResolved(sql, spec.pendingRowId, "late_reply_dropped", spec.now);
      return;
    }

    const parentRow = parentRows[0];
    assert(parentRow !== undefined, "routeAskReplyOnQuiesce: parentRow must exist");

    if (parentRow.closed_at !== null) {
      counter("relay.session.late_reply_dropped_total").add(1, {
        [Attr.TenantId]: spec.tenantId,
        [Attr.DropReason]: "parent_closed",
      });
      emit("WARN", "session.ask_reply.parent_closed", {
        [Attr.SessionId]: spec.childSessionId,
        [Attr.TenantId]: spec.tenantId,
      });
      await markResolved(sql, spec.pendingRowId, "late_reply_dropped", spec.now);
      return;
    }

    const iKey = idempotencyKeyForAskReply({
      childSessionId: spec.childSessionId,
      parentToolUseId: spec.parentToolUseId,
    });
    const workItemIdStr = idempotencyKeyToUuid(iKey);
    const workItemIdResult = WorkItemId.parse(workItemIdStr);
    assert(workItemIdResult.ok, "routeAskReplyOnQuiesce: invalid work item UUID");

    const parentSessResult = SessionId.parse(spec.parentSessionId);
    assert(parentSessResult.ok, "routeAskReplyOnQuiesce: invalid parentSessionId", {
      id: spec.parentSessionId,
    });

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
      emit("WARN", "session.quiesce.write_inbound_failed", {
        [Attr.SessionId]: spec.childSessionId,
        error: inboundResult.error.kind,
      });
      await markResolved(sql, spec.pendingRowId, "late_reply_dropped", spec.now);
      return;
    }

    const workResult = await enqueue(sql, {
      tenantId: spec.tenantId,
      kind: "inbound_message",
      payloadRef: inboundResult.value,
      scheduledAt: spec.now,
    });

    if (!workResult.ok) {
      emit("WARN", "session.quiesce.enqueue_failed", {
        [Attr.SessionId]: spec.childSessionId,
        error: workResult.error.kind,
      });
      await markResolved(sql, spec.pendingRowId, "late_reply_dropped", spec.now);
      return;
    }

    await markResolved(sql, spec.pendingRowId, "reply_routed", spec.now);
  } catch (e) {
    emit("WARN", "session.quiesce.route_failed", {
      [Attr.SessionId]: spec.childSessionId,
      error: (e as Error).message,
    });
    await markResolved(sql, spec.pendingRowId, "late_reply_dropped", spec.now);
  }
}
