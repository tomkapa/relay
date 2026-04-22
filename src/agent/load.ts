// Loads an agent by ID for session synthesis. Tenant checking is deferred to
// createSession (which uses FOR SHARE to prevent races).

import type { Sql } from "postgres";
import { assert } from "../core/assert.ts";
import { err, ok, type Result } from "../core/result.ts";
import { firstRow } from "../db/utils.ts";
import {
  AgentId,
  TenantId,
  type AgentId as AgentIdBrand,
  type TenantId as TenantIdBrand,
} from "../ids.ts";

export type LoadedAgent = {
  readonly id: AgentIdBrand;
  readonly tenantId: TenantIdBrand;
  readonly systemPrompt: string;
};

export type AgentLoadError = { kind: "agent_not_found"; agentId: AgentIdBrand };

type AgentRow = {
  readonly id: string;
  readonly tenant_id: string;
  readonly system_prompt: string;
};

export async function loadAgent(
  sql: Sql,
  agentId: AgentIdBrand,
): Promise<Result<LoadedAgent, AgentLoadError>> {
  const rows = await sql<AgentRow[]>`
    SELECT id, tenant_id, system_prompt FROM agents WHERE id = ${agentId}
  `;
  if (rows.length === 0) return err({ kind: "agent_not_found", agentId });

  const row = firstRow(rows, "loadAgent");
  const tenantResult = TenantId.parse(row.tenant_id);
  assert(tenantResult.ok, "loadAgent: invalid tenant_id from DB", { tenant_id: row.tenant_id });
  const idResult = AgentId.parse(row.id);
  assert(idResult.ok, "loadAgent: invalid id from DB", { id: row.id });

  return ok({ id: idResult.value, tenantId: tenantResult.value, systemPrompt: row.system_prompt });
}
