// Validate and load an open target session for the inbound_message handler.
// Defense-in-depth: refuses delivery to closed, missing, or wrong-tenant sessions.
// SPEC §Communication; RELAY-47.

import type { Sql } from "postgres";
import { assert } from "../core/assert.ts";
import { err, ok, type Result } from "../core/result.ts";
import { firstRow } from "../db/utils.ts";
import { AgentId, SessionId, TenantId } from "../ids.ts";
import type {
  AgentId as AgentIdBrand,
  SessionId as SessionIdBrand,
  TenantId as TenantIdBrand,
} from "../ids.ts";
import type { LoadedAgent } from "../agent/load.ts";

export type TargetSessionError =
  | { kind: "target_session_not_found"; id: SessionIdBrand }
  | { kind: "target_session_closed"; id: SessionIdBrand; closedAt: Date }
  | {
      kind: "target_session_tenant_mismatch";
      id: SessionIdBrand;
      expected: TenantIdBrand;
      got: TenantIdBrand;
    }
  | { kind: "agent_not_found"; id: AgentIdBrand };

type JoinRow = {
  readonly id: string;
  readonly agent_id: string;
  readonly tenant_id: string;
  readonly closed_at: Date | null;
  readonly agent_system_prompt: string | null;
  readonly agent_tenant_id: string | null;
};

export async function loadOpenTargetSession(
  sql: Sql,
  id: SessionIdBrand,
  expectedTenantId: TenantIdBrand,
): Promise<
  Result<
    {
      session: { id: SessionIdBrand; agentId: AgentIdBrand; tenantId: TenantIdBrand };
      agent: LoadedAgent;
    },
    TargetSessionError
  >
> {
  const rows = await sql<JoinRow[]>`
    SELECT s.id, s.agent_id, s.tenant_id, s.closed_at,
           a.system_prompt AS agent_system_prompt,
           a.tenant_id     AS agent_tenant_id
    FROM sessions s
    LEFT JOIN agents a ON a.id = s.agent_id
    WHERE s.id = ${id}
  `;

  if (rows.length === 0) return err({ kind: "target_session_not_found", id });

  const row = firstRow(rows, "loadOpenTargetSession");

  if (row.closed_at !== null) {
    return err({ kind: "target_session_closed", id, closedAt: row.closed_at });
  }

  const tenantResult = TenantId.parse(row.tenant_id);
  assert(tenantResult.ok, "loadOpenTargetSession: invalid tenant_id from DB", {
    tenant_id: row.tenant_id,
  });
  if (tenantResult.value !== expectedTenantId) {
    return err({
      kind: "target_session_tenant_mismatch",
      id,
      expected: expectedTenantId,
      got: tenantResult.value,
    });
  }

  const agentIdResult = AgentId.parse(row.agent_id);
  assert(agentIdResult.ok, "loadOpenTargetSession: invalid agent_id from DB", {
    agent_id: row.agent_id,
  });

  if (row.agent_system_prompt === null || row.agent_tenant_id === null) {
    return err({ kind: "agent_not_found", id: agentIdResult.value });
  }

  const sessionIdResult = SessionId.parse(row.id);
  assert(sessionIdResult.ok, "loadOpenTargetSession: invalid id from DB", { id: row.id });

  const agentTenantResult = TenantId.parse(row.agent_tenant_id);
  assert(agentTenantResult.ok, "loadOpenTargetSession: invalid agent tenant_id from DB", {
    agent_tenant_id: row.agent_tenant_id,
  });

  return ok({
    session: {
      id: sessionIdResult.value,
      agentId: agentIdResult.value,
      tenantId: tenantResult.value,
    },
    agent: {
      id: agentIdResult.value,
      tenantId: agentTenantResult.value,
      systemPrompt: row.agent_system_prompt,
    },
  });
}
