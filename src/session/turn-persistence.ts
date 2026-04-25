// Single-phase turn persistence: one INSERT per completed turn.
// RELAY-73 evolves this into INSERT-on-start + UPDATE-on-complete without a schema change.
// When drainedPendingIds is non-empty, the INSERT and the consumed_by_turn UPDATE run in
// a single transaction so a turn persist failure leaves messages unconsumed (RELAY-136).

import type { Sql, TransactionSql } from "postgres";
import { err, ok, type Result } from "../core/result.ts";
import { markPendingMessagesConsumed } from "../hook/pending.ts";
import type { AgentId, PendingSystemMessageId, SessionId, TenantId } from "../ids.ts";
import type { Turn, TurnLoopError } from "./turn.ts";

// Domain types are JSON-serializable but contain `unknown`-typed fields from external inputs.
// postgres.js's JSONValue doesn't accept `unknown`, so we bridge through `unknown` first.
type JsonArg = Parameters<Sql["json"]>[0];
const asJson = (v: unknown): JsonArg => v as JsonArg;

async function insertTurnRow(
  sql: Sql | TransactionSql,
  turn: Turn,
  sessionId: SessionId,
  tenantId: TenantId,
  agentId: AgentId,
): Promise<void> {
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
}

async function persistTurnInTx(
  tx: TransactionSql,
  turn: Turn,
  sessionId: SessionId,
  tenantId: TenantId,
  agentId: AgentId,
  drainedPendingIds: readonly PendingSystemMessageId[],
): Promise<void> {
  await insertTurnRow(tx, turn, sessionId, tenantId, agentId);
  await markPendingMessagesConsumed(tx, drainedPendingIds, turn.id);
}

export async function insertTurn(
  sql: Sql,
  params: {
    readonly turn: Turn;
    readonly sessionId: SessionId;
    readonly tenantId: TenantId;
    readonly agentId: AgentId;
    readonly drainedPendingIds?: readonly PendingSystemMessageId[];
  },
): Promise<Result<void, TurnLoopError>> {
  const { turn, sessionId, tenantId, agentId } = params;
  const drainedPendingIds = params.drainedPendingIds ?? [];

  try {
    if (drainedPendingIds.length === 0) {
      await insertTurnRow(sql, turn, sessionId, tenantId, agentId);
    } else {
      await sql.begin((tx) =>
        persistTurnInTx(tx, turn, sessionId, tenantId, agentId, drainedPendingIds),
      );
    }
    return ok(undefined);
  } catch (e) {
    return err({ kind: "persist_turn_failed", detail: (e as Error).message });
  }
}
