// Child session quiescence.
// Called instead of closeSession when a child session's turn loop ends without
// pending asks. Child sessions never set closed_at on quiescence; only cascade-terminate does.

import type { Sql } from "postgres";
import { assert } from "../core/assert.ts";
import type { Clock } from "../core/clock.ts";
import { err, ok, type Result } from "../core/result.ts";
import { firstRow } from "../db/utils.ts";
import {
  TenantId,
  type AgentId,
  type ChainId,
  type Depth,
  type SessionId as SessionIdBrand,
  type TenantId as TenantIdBrand,
  type ToolUseId as ToolUseIdBrand,
} from "../ids.ts";
import { Attr, SpanName, counter, emit, withSpan } from "../telemetry/otel.ts";
import { readMostRecentUnresolved, markResolved } from "./pending-asks.ts";
import {
  readChildFinalText,
  routeAskReplyToParent,
  type AskReplyRouteDrop,
} from "./ask-reply-route.ts";

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
    emit("WARN", "session.quiesce.no_parent_for_ask", {
      [Attr.SessionId]: spec.childSessionId,
      [Attr.TenantId]: spec.tenantId,
    });
    await markResolved(sql, spec.pendingRowId, "late_reply_dropped", spec.now);
    return;
  }

  try {
    const finalText = await readChildFinalText(
      sql,
      spec.childSessionId,
      "<no response — session quiesced without text>",
    );

    const result = await routeAskReplyToParent(
      sql,
      {
        childSessionId: spec.childSessionId,
        parentSessionId: spec.parentSessionId,
        parentToolUseId: spec.parentToolUseId,
        tenantId: spec.tenantId,
        childAgentId: spec.childAgentId,
        now: spec.now,
        noResponseFallback: "<no response — session quiesced without text>",
      },
      finalText,
    );

    if (result.ok) {
      await markResolved(sql, spec.pendingRowId, "reply_routed", spec.now);
      return;
    }

    logQuiesceRouteDrop(spec.childSessionId, spec.tenantId, result.error);
    await markResolved(sql, spec.pendingRowId, "late_reply_dropped", spec.now);
  } catch (e) {
    emit("WARN", "session.quiesce.route_failed", {
      [Attr.SessionId]: spec.childSessionId,
      error: (e as Error).message,
    });
    await markResolved(sql, spec.pendingRowId, "late_reply_dropped", spec.now);
  }
}

function logQuiesceRouteDrop(
  childSessionId: SessionIdBrand,
  tenantId: TenantIdBrand,
  drop: AskReplyRouteDrop,
): void {
  switch (drop.kind) {
    case "parent_not_found":
    case "parent_closed":
      counter("relay.session.late_reply_dropped_total").add(1, {
        [Attr.TenantId]: tenantId,
        [Attr.DropReason]: drop.kind,
      });
      emit("WARN", `session.ask_reply.${drop.kind}`, {
        [Attr.SessionId]: childSessionId,
        [Attr.TenantId]: tenantId,
      });
      return;
    case "write_inbound_failed":
      emit("WARN", "session.quiesce.write_inbound_failed", {
        [Attr.SessionId]: childSessionId,
        error: drop.detail,
      });
      return;
    case "enqueue_failed":
      emit("WARN", "session.quiesce.enqueue_failed", {
        [Attr.SessionId]: childSessionId,
        error: drop.detail,
      });
      return;
  }
}
