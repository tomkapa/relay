// Session close — idempotent write, observational SessionEnd hook seam.
// SPEC §Session Lifecycle. No migration: sessions.closed_at already exists (0001_init.sql).

import type { Sql } from "postgres";
import { assert } from "../core/assert.ts";
import type { Clock } from "../core/clock.ts";
import { err, ok, type Result } from "../core/result.ts";
import { firstRow } from "../db/utils.ts";
import { TenantId, type AgentId, type SessionId, type TenantId as TenantIdBrand } from "../ids.ts";
import { Attr, SpanName, counter, emit, histogram, withSpan } from "../telemetry/otel.ts";

// Close reason tags. Additive union — future tasks (abandoned-after-deadline, admin-force-close)
// extend here. RELAY-93 adds nothing: suspend is NOT a close.
export type SessionEndReason =
  | { readonly kind: "end_turn" }
  | { readonly kind: "turn_cap_exceeded"; readonly max: number };

export type SessionCloseSpec = Readonly<{
  sessionId: SessionId;
  tenantId: TenantIdBrand;
  agentId: AgentId;
  reason: SessionEndReason;
}>;

export type SessionCloseOutcome =
  | { readonly kind: "closed"; readonly at: Date }
  | { readonly kind: "already_closed"; readonly at: Date };

export type SessionCloseError =
  | { readonly kind: "session_not_found"; readonly sessionId: SessionId }
  | {
      readonly kind: "tenant_mismatch";
      readonly expected: TenantIdBrand;
      readonly got: TenantIdBrand;
    };

export type SessionEndPayload = Readonly<{
  sessionId: SessionId;
  tenantId: TenantIdBrand;
  agentId: AgentId;
  reason: SessionEndReason;
  closedAt: Date;
  createdAt: Date;
}>;

export type HookResult =
  | { readonly decision: "approve" }
  | { readonly decision: "deny"; readonly reason: string };

// Pass-through stub. RELAY-37 replaces this with the real evaluator call.
// Duplicated from src/trigger/handlers.ts deliberately — each stub keeps its own
// signature until RELAY-37 hoists the shared type into src/hook/.
export const sessionEndStub: (payload: SessionEndPayload) => Promise<HookResult> = () =>
  Promise.resolve({ decision: "approve" });

export async function closeSession(
  sql: Sql,
  clock: Clock,
  spec: SessionCloseSpec,
  hookFn: (payload: SessionEndPayload) => Promise<HookResult> = sessionEndStub,
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
    async () => {
      const now = new Date(clock.now());

      const lookup = await sql<
        {
          readonly tenant_id: string;
          readonly closed_at: Date | null;
          readonly created_at: Date;
        }[]
      >`
        SELECT tenant_id, closed_at, created_at
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

      // Fires after commit so RELAY-37 audit counts align with the closed_total counter.
      // A deny does not unwind the close — the loop has already returned; nothing to roll back.
      if (outcome.kind === "closed") {
        const hook = await hookFn({
          sessionId: spec.sessionId,
          tenantId: spec.tenantId,
          agentId: spec.agentId,
          reason: spec.reason,
          closedAt: outcome.at,
          createdAt: row.created_at,
        });
        if (hook.decision === "deny") {
          emit("WARN", "session.end.hook_denied", {
            [Attr.SessionId]: spec.sessionId,
            [Attr.TenantId]: spec.tenantId,
            [Attr.HookReason]: hook.reason,
          });
        }

        // already_closed path is silent — first closer already recorded; counting both double-counts.
        counter("session.closed_total").add(1, {
          [Attr.TenantId]: spec.tenantId,
          [Attr.SessionCloseReason]: spec.reason.kind,
        });
        histogram("session.duration_ms").record(outcome.at.getTime() - row.created_at.getTime(), {
          [Attr.TenantId]: spec.tenantId,
        });
      }

      return ok(outcome);
    },
  );
}

// Returns false for missing sessions — callers that need to distinguish "not-found" from "open"
// should use a richer lookup. The 90% case (RELAY-47, RELAY-59) maps cleanly to a boolean.
export async function isClosed(sql: Sql, sessionId: SessionId): Promise<boolean> {
  const rows = await sql<{ readonly closed_at: Date | null }[]>`
    SELECT closed_at FROM sessions WHERE id = ${sessionId}
  `;
  if (rows.length === 0) return false;
  const row = firstRow(rows, "isClosed");
  return row.closed_at !== null;
}
