// Durable audit log for every hook evaluation. One row per call to evaluateHook.
// SPEC §Audit mandates this for system hooks; invariant violations crash the process (CLAUDE.md §6).

import type { Sql, TransactionSql } from "postgres";
import { assert } from "../core/assert.ts";
import { err, ok, type Result } from "../core/result.ts";
import { firstRow } from "../db/utils.ts";
import {
  HookAuditId,
  TenantId,
  mintId,
  type AgentId,
  type HookAuditId as HookAuditIdBrand,
  type SessionId,
  type TenantId as TenantIdBrand,
  type TurnId,
} from "../ids.ts";
import { MAX_DENY_REASON_CHARS } from "./limits.ts";
import type { HookEvent, HookLayer } from "./types.ts";

export type InsertHookAuditInput = {
  // hook_id is TEXT until hook_rules ships (RELAY-138+). Not a UUID brand.
  readonly hookId: string;
  readonly layer: HookLayer;
  readonly event: HookEvent;
  readonly matcherResult: boolean;
  readonly decision: "approve" | "deny" | "modify";
  readonly reason: string | null;
  readonly latencyMs: number;
  readonly tenantId: TenantIdBrand;
  readonly sessionId: SessionId | null;
  readonly agentId: AgentId;
  readonly turnId: TurnId | null;
  readonly toolName: string | null;
};

export type HookAuditRow = {
  readonly id: HookAuditIdBrand;
  readonly hookId: string;
  readonly layer: HookLayer;
  readonly event: HookEvent;
  readonly matcherResult: boolean;
  readonly decision: "approve" | "deny" | "modify";
  readonly reason: string | null;
  readonly latencyMs: number;
  readonly tenantId: TenantIdBrand;
  readonly sessionId: string | null;
  readonly agentId: AgentId;
  readonly turnId: TurnId | null;
  readonly toolName: string | null;
  readonly createdAt: Date;
};

export type InsertHookAuditError =
  | { readonly kind: "agent_not_found" }
  | { readonly kind: "tenant_mismatch" }
  | { readonly kind: "reason_too_long"; readonly length: number; readonly max: number };

type AgentDbRow = { readonly tenant_id: string };
type AuditDbRow = {
  readonly id: string;
  readonly hook_id: string;
  readonly layer: string;
  readonly event: string;
  readonly matcher_result: boolean;
  readonly decision: string;
  readonly reason: string | null;
  readonly latency_ms: number;
  readonly tenant_id: string;
  readonly session_id: string | null;
  readonly agent_id: string;
  readonly turn_id: string | null;
  readonly tool_name: string | null;
  readonly created_at: Date;
};

function toDomain(row: AuditDbRow): HookAuditRow {
  const parsedId = HookAuditId.parse(row.id);
  assert(parsedId.ok, "insertHookAudit: id from DB is invalid", { id: row.id });
  return {
    id: parsedId.value,
    hookId: row.hook_id,
    layer: row.layer as HookLayer,
    event: row.event as HookEvent,
    matcherResult: row.matcher_result,
    decision: row.decision as "approve" | "deny" | "modify",
    reason: row.reason,
    latencyMs: row.latency_ms,
    tenantId: row.tenant_id as TenantIdBrand,
    sessionId: row.session_id,
    agentId: row.agent_id as AgentId,
    turnId: row.turn_id as TurnId | null,
    toolName: row.tool_name,
    createdAt: row.created_at,
  };
}

export async function insertHookAudit(
  tx: Sql | TransactionSql,
  input: InsertHookAuditInput,
): Promise<Result<HookAuditRow, InsertHookAuditError>> {
  assert(input.latencyMs >= 0, "insertHookAudit: latencyMs must be non-negative", {
    latencyMs: input.latencyMs,
  });
  assert(
    input.decision !== "deny" || input.reason !== null,
    "insertHookAudit: deny decision must have reason",
  );

  if (input.reason !== null && input.reason.length > MAX_DENY_REASON_CHARS) {
    return err({
      kind: "reason_too_long",
      length: input.reason.length,
      max: MAX_DENY_REASON_CHARS,
    });
  }

  const id = mintId(HookAuditId.parse, "insertHookAudit");

  const agentRows = await tx<AgentDbRow[]>`
    SELECT tenant_id FROM agents WHERE id = ${input.agentId}
  `;

  if (agentRows.length === 0) {
    return err({ kind: "agent_not_found" });
  }

  const agentRow = firstRow(agentRows, "insertHookAudit.checkAgent");
  const agentTenantResult = TenantId.parse(agentRow.tenant_id);
  assert(agentTenantResult.ok, "insertHookAudit: invalid tenant_id from DB", {
    tenant_id: agentRow.tenant_id,
  });

  if (agentTenantResult.value !== input.tenantId) {
    return err({ kind: "tenant_mismatch" });
  }

  const rows = await tx<AuditDbRow[]>`
    INSERT INTO hook_audit (
      id, tenant_id, session_id, agent_id, turn_id,
      hook_id, layer, event, matcher_result,
      decision, reason, latency_ms, tool_name
    ) VALUES (
      ${id},
      ${input.tenantId},
      ${input.sessionId ?? null},
      ${input.agentId},
      ${input.turnId ?? null},
      ${input.hookId},
      ${input.layer},
      ${input.event},
      ${input.matcherResult},
      ${input.decision},
      ${input.reason ?? null},
      ${input.latencyMs},
      ${input.toolName ?? null}
    )
    RETURNING
      id, hook_id, layer, event, matcher_result,
      decision, reason, latency_ms, tenant_id, session_id,
      agent_id, turn_id, tool_name, created_at
  `;

  const row = firstRow(rows, "insertHookAudit.insert");
  return ok(toDomain(row));
}
