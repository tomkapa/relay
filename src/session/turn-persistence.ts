// Single-phase turn persistence: one INSERT per completed turn.
// RELAY-73 evolves this into INSERT-on-start + UPDATE-on-complete without a schema change.

import type { Sql } from "postgres";
import { err, ok, type Result } from "../core/result.ts";
import type { AgentId, SessionId, TenantId } from "../ids.ts";
import type { Turn, TurnLoopError } from "./turn.ts";

// Domain types are JSON-serializable but contain `unknown`-typed fields from external inputs.
// postgres.js's JSONValue doesn't accept `unknown`, so we bridge through `unknown` first —
// a necessary boundary assertion, not a type-narrowing shortcut.
type JsonArg = Parameters<Sql["json"]>[0];
const asJson = (v: unknown): JsonArg => v as JsonArg;

export async function insertTurn(
  sql: Sql,
  params: {
    readonly turn: Turn;
    readonly sessionId: SessionId;
    readonly tenantId: TenantId;
    readonly agentId: AgentId;
  },
): Promise<Result<void, TurnLoopError>> {
  const { turn, sessionId, tenantId, agentId } = params;
  try {
    await sql`
      INSERT INTO turns (
        id, session_id, tenant_id, agent_id, turn_index,
        started_at, completed_at, response, tool_results, usage
      ) VALUES (
        ${turn.id},
        ${sessionId},
        ${tenantId},
        ${agentId},
        ${turn.index},
        ${turn.startedAt},
        ${turn.completedAt},
        ${sql.json(asJson(turn.response))},
        ${sql.json(asJson(turn.toolResults))},
        ${sql.json(asJson(turn.response.usage))}
      )
    `;
    return ok(undefined);
  } catch (e) {
    return err({ kind: "persist_turn_failed", detail: (e as Error).message });
  }
}
