// Session close — idempotent write, observational SessionEnd hook via registry.
// SPEC §Session Lifecycle. No migration: sessions.closed_at already exists (0001_init.sql).

import type { Sql } from "postgres";
import { assert } from "../core/assert.ts";
import type { Clock } from "../core/clock.ts";
import { err, ok, type Result } from "../core/result.ts";
import { firstRow } from "../db/utils.ts";
import {
  SessionId,
  TenantId,
  ToolUseId,
  WorkItemId,
  type AgentId,
  type SessionId as SessionIdBrand,
  type TenantId as TenantIdBrand,
  type ToolUseId as ToolUseIdBrand,
} from "../ids.ts";
import { idempotencyKeyForAskReply, idempotencyKeyToUuid } from "../core/idempotency.ts";
import { Attr, SpanName, counter, emit, withSpan } from "../telemetry/otel.ts";
import { runHooks } from "../hook/run.ts";
import { snapshotHookConfig } from "../hook/snapshot.ts";
import { HOOK_EVENT } from "../hook/types.ts";
import { readFinalTurnResponse } from "./read-final-turn.ts";
import { writeInboundMessage } from "../trigger/inbound/inbound-ops.ts";
import { enqueue } from "../work_queue/queue-ops.ts";
import { markCascadeOrphaned } from "./pending-asks.ts";

// Close reason tags. Additive union — future tasks (abandoned-after-deadline, admin-force-close)
// extend here. RELAY-93 adds nothing: suspend is NOT a close.
export type SessionEndReason =
  | { readonly kind: "end_turn" }
  | { readonly kind: "turn_cap_exceeded"; readonly max: number };

export type SyncCloseReason = SessionEndReason["kind"];

export type SessionCloseSpec = Readonly<{
  sessionId: SessionIdBrand;
  tenantId: TenantIdBrand;
  agentId: AgentId;
  reason: SessionEndReason;
}>;

export type SessionCloseOutcome =
  | { readonly kind: "closed"; readonly at: Date }
  | { readonly kind: "already_closed"; readonly at: Date };

export type SessionCloseError =
  | { readonly kind: "session_not_found"; readonly sessionId: SessionIdBrand }
  | {
      readonly kind: "tenant_mismatch";
      readonly expected: TenantIdBrand;
      readonly got: TenantIdBrand;
    };

export async function closeSession(
  sql: Sql,
  clock: Clock,
  spec: SessionCloseSpec,
): Promise<Result<SessionCloseOutcome, SessionCloseError>> {
  assert(spec.sessionId.length > 0, "closeSession: sessionId non-empty");
  assert(spec.tenantId.length > 0, "closeSession: tenantId non-empty");

  return withSpan(
    SpanName.SessionClose,
    {
      [Attr.SessionId]: spec.sessionId,
      [Attr.TenantId]: spec.tenantId,
      [Attr.AgentId]: spec.agentId,
      [Attr.SessionCloseReason]: spec.reason.kind,
    },
    async (span) => {
      const now = new Date(clock.now());

      const lookup = await sql<
        {
          readonly tenant_id: string;
          readonly closed_at: Date | null;
          readonly created_at: Date;
          readonly envelope_id: string | null;
          readonly parent_session_id: string | null;
          readonly parent_tool_use_id: string | null;
        }[]
      >`
        SELECT tenant_id, closed_at, created_at,
               originating_trigger->>'envelopeId' AS envelope_id,
               parent_session_id, parent_tool_use_id
        FROM sessions
        WHERE id = ${spec.sessionId}
      `;
      if (lookup.length === 0) {
        return err({ kind: "session_not_found", sessionId: spec.sessionId });
      }
      const row = firstRow(lookup, "closeSession.lookup");
      const tenantParsed = TenantId.parse(row.tenant_id);
      assert(tenantParsed.ok, "closeSession: invalid tenant_id from DB");
      if (tenantParsed.value !== spec.tenantId) {
        return err({ kind: "tenant_mismatch", expected: spec.tenantId, got: tenantParsed.value });
      }

      // Only one worker wins under concurrent close attempts.
      const updated = await sql<{ readonly closed_at: Date }[]>`
        UPDATE sessions
        SET closed_at = ${now}, updated_at = ${now}
        WHERE id = ${spec.sessionId} AND closed_at IS NULL
        RETURNING closed_at
      `;

      const outcome: SessionCloseOutcome =
        updated.length === 0
          ? { kind: "already_closed", at: row.closed_at ?? now }
          : { kind: "closed", at: firstRow(updated, "closeSession.update").closed_at };

      // Fires after commit so audit counts align with the closed_total counter.
      // SessionEnd is observational — deny logs a warning but does NOT unwind the close.
      if (outcome.kind === "closed") {
        await emitSessionSyncClose(sql, {
          sessionId: spec.sessionId,
          reason: spec.reason.kind,
          envelopeId: row.envelope_id,
        });

        const hookConfig = snapshotHookConfig(clock);
        const aggregate = await runHooks(
          sql,
          clock,
          hookConfig,
          {
            event: HOOK_EVENT.SessionEnd,
            tenantId: spec.tenantId,
            agentId: spec.agentId,
            sessionId: spec.sessionId,
            turnId: null,
            toolName: null,
          },
          {
            tenantId: spec.tenantId,
            agentId: spec.agentId,
            sessionId: spec.sessionId,
            reason: spec.reason,
            closedAt: outcome.at,
            createdAt: row.created_at,
            durationMs: outcome.at.getTime() - row.created_at.getTime(),
          },
        );

        // SessionEnd modify has no semantically meaningful application. Crash on authoring bug.
        assert(
          aggregate.decision !== "modify",
          "closeSession: SessionEnd modify decision is not supported",
        );

        if (aggregate.decision === "deny") {
          emit("WARN", "session.end.hook_denied", {
            [Attr.SessionId]: spec.sessionId,
            [Attr.TenantId]: spec.tenantId,
            [Attr.HookReason]: aggregate.reason,
          });
        }

        // Safety net for any session that reaches closeSession with a parent link —
        // child sessions normally go through quiesceSession, so this should not fire.
        if (row.parent_session_id !== null && row.parent_tool_use_id !== null) {
          const toolUseIdResult = ToolUseId.parse(row.parent_tool_use_id);
          assert(toolUseIdResult.ok, "closeSession: invalid parent_tool_use_id from DB", {
            id: row.parent_tool_use_id,
          });
          await routeAskReplyOnClose(sql, clock, {
            childSessionId: spec.sessionId,
            parentSessionId: row.parent_session_id,
            parentToolUseId: toolUseIdResult.value,
            tenantId: spec.tenantId,
            childAgentId: spec.agentId,
          });
        }

        // Top-level sessions trigger a cascade_close to terminate all open descendants.
        if (row.parent_session_id === null) {
          await enqueueCascadeClose(sql, clock, spec.sessionId, spec.tenantId);
        }

        span.setAttribute(Attr.SessionDurationMs, outcome.at.getTime() - row.created_at.getTime());
      }

      return ok(outcome);
    },
  );
}

function dropLateReply(
  childSessionId: SessionIdBrand,
  tenantId: TenantIdBrand,
  parentSessionId: string,
  reason: "parent_not_found" | "parent_closed",
): void {
  counter("relay.session.late_reply_dropped_total").add(1, {
    [Attr.TenantId]: tenantId,
    [Attr.DropReason]: reason,
  });
  emit("WARN", `session.ask_reply.${reason}`, {
    [Attr.SessionId]: childSessionId,
    [Attr.TenantId]: tenantId,
    parent_session_id: parentSessionId,
  });
}

// Routes the child's final assistant text back to the parent as an inbound message.
// Called after the SessionEnd hook completes. Failures are caught and logged — they must
// NOT unwind the close. RELAY-144 §9.
async function routeAskReplyOnClose(
  sql: Sql,
  clock: Clock,
  spec: {
    readonly childSessionId: SessionIdBrand;
    readonly parentSessionId: string;
    readonly parentToolUseId: ToolUseIdBrand;
    readonly tenantId: TenantIdBrand;
    readonly childAgentId: AgentId;
  },
): Promise<void> {
  try {
    // 1. Read final assistant text from child session.
    const finalResult = await readFinalTurnResponse(sql, spec.childSessionId);
    const finalText =
      finalResult.ok && finalResult.value.text.length > 0
        ? finalResult.value.text
        : "<no response — session ended without text>";

    // 2. Check parent session status.
    const parentRows = await sql<{ closed_at: Date | null }[]>`
      SELECT closed_at FROM sessions WHERE id = ${spec.parentSessionId} AND tenant_id = ${spec.tenantId}
    `;
    if (parentRows.length === 0) {
      dropLateReply(spec.childSessionId, spec.tenantId, spec.parentSessionId, "parent_not_found");
      return;
    }
    const parentRow = parentRows[0];
    assert(parentRow !== undefined, "routeAskReplyOnClose: parentRow must exist");
    if (parentRow.closed_at !== null) {
      dropLateReply(spec.childSessionId, spec.tenantId, spec.parentSessionId, "parent_closed");
      return;
    }

    const iKey = idempotencyKeyForAskReply({
      childSessionId: spec.childSessionId,
      parentToolUseId: spec.parentToolUseId,
    });
    const workItemIdStr = idempotencyKeyToUuid(iKey);
    const workItemIdResult = WorkItemId.parse(workItemIdStr);
    assert(
      workItemIdResult.ok,
      "routeAskReplyOnClose: idempotencyKeyToUuid invalid UUID for work item",
    );
    const syntheticWorkItemId = workItemIdResult.value;

    const now = new Date(clock.now());

    const parentSessResult = SessionId.parse(spec.parentSessionId);
    assert(parentSessResult.ok, "routeAskReplyOnClose: invalid parentSessionId", {
      id: spec.parentSessionId,
    });

    const inboundResult = await writeInboundMessage(sql, {
      tenantId: spec.tenantId,
      targetSessionId: parentSessResult.value,
      sender: { type: "agent", id: spec.childAgentId },
      content: finalText,
      receivedAt: now,
      sourceWorkItemId: syntheticWorkItemId,
      sourceToolUseId: spec.parentToolUseId,
    });
    if (!inboundResult.ok) {
      emit("WARN", "session.ask_reply.write_inbound_failed", {
        [Attr.SessionId]: spec.childSessionId,
        error: inboundResult.error.kind,
      });
      return;
    }

    const workResult = await enqueue(sql, {
      tenantId: spec.tenantId,
      kind: "inbound_message",
      payloadRef: inboundResult.value,
      scheduledAt: now,
    });
    if (!workResult.ok) {
      emit("WARN", "session.ask_reply.enqueue_failed", {
        [Attr.SessionId]: spec.childSessionId,
        error: workResult.error.kind,
      });
    }
  } catch (e) {
    emit("WARN", "session.ask_reply.route_failed", {
      [Attr.SessionId]: spec.childSessionId,
      error: (e as Error).message,
    });
  }
}

// Reads originating_trigger->>'envelopeId'. If present, emits a Postgres NOTIFY so the
// HTTP server process can resolve its sync waiter. Sessions created without an envelope
// (task_fire, ask-reply) have a null envelopeId and are silently skipped.
// Errors are caught and logged — a notify failure must NOT unwind the close.
export async function emitSessionSyncClose(
  sql: Sql,
  spec: {
    readonly sessionId: SessionIdBrand;
    readonly reason: SyncCloseReason;
    readonly envelopeId: string | null;
  },
): Promise<void> {
  if (spec.envelopeId === null) return;

  const payload = JSON.stringify({
    envelopeId: spec.envelopeId,
    sessionId: spec.sessionId as string,
    reason: spec.reason,
  });

  try {
    await withSpan(SpanName.SessionSyncDispatch, { [Attr.SessionId]: spec.sessionId }, async () => {
      await sql.notify("session_sync_close", payload);
    });
  } catch (e) {
    emit("WARN", "session.sync_close.notify_failed", {
      [Attr.SessionId]: spec.sessionId,
      error: (e as Error).message,
    });
  }
}

// Enqueue a cascade_close work item for the root session. Failures are caught and logged —
// a notify failure must NOT unwind the close. The cascade worker handles descendant traversal.
async function enqueueCascadeClose(
  sql: Sql,
  clock: Clock,
  sessionId: SessionIdBrand,
  tenantId: TenantIdBrand,
): Promise<void> {
  try {
    const now = new Date(clock.now());
    const workResult = await enqueue(sql, {
      tenantId,
      kind: "cascade_close",
      payloadRef: sessionId,
      scheduledAt: now,
    });
    if (!workResult.ok) {
      emit("WARN", "session.cascade_close.enqueue_failed", {
        [Attr.SessionId]: sessionId,
        [Attr.TenantId]: tenantId,
        error: workResult.error.kind,
      });
    }
  } catch (e) {
    emit("WARN", "session.cascade_close.enqueue_threw", {
      [Attr.SessionId]: sessionId,
      error: (e as Error).message,
    });
  }
}

// Mark a session terminal (set closed_at) without firing SessionEnd hook or routing ask replies.
// Used by cascade_close to terminate child sessions without emitting SessionEnd events.
// Returns true if this call set the timestamp (won the race), false if already closed.
export async function markSessionTerminal(
  sql: Sql,
  sessionId: SessionIdBrand,
  now: Date,
): Promise<boolean> {
  assert(sessionId.length > 0, "markSessionTerminal: sessionId non-empty");

  const updated = await sql<{ readonly id: string }[]>`
    UPDATE sessions
    SET closed_at = ${now}, updated_at = ${now}
    WHERE id = ${sessionId} AND closed_at IS NULL
    RETURNING id
  `;

  if (updated.length > 0) {
    await markCascadeOrphaned(sql, sessionId, now);
    return true;
  }
  return false;
}

// Returns false for missing sessions — callers that need to distinguish "not-found" from "open"
// should use a richer lookup. The 90% case (RELAY-47, RELAY-59) maps cleanly to a boolean.
export async function isClosed(sql: Sql, sessionId: SessionIdBrand): Promise<boolean> {
  const rows = await sql<{ readonly closed_at: Date | null }[]>`
    SELECT closed_at FROM sessions WHERE id = ${sessionId}
  `;
  if (rows.length === 0) return false;
  const row = firstRow(rows, "isClosed");
  return row.closed_at !== null;
}
