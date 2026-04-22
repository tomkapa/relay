// Idempotent session creation. If a worker crashes after INSERT but before completing the
// queue item, the next worker re-runs the handler; the ON CONFLICT path returns the existing
// row rather than creating a duplicate. SPEC §Retry and idempotency.

import type { Sql, TransactionSql } from "postgres";
import { assert } from "../core/assert.ts";
import type { Clock } from "../core/clock.ts";
import { err, ok, type Result } from "../core/result.ts";
import { type DbJson, firstRow } from "../db/utils.ts";
import {
  SessionId,
  TenantId,
  mintId,
  type AgentId as AgentIdBrand,
  type ChainId as ChainIdBrand,
  type Depth,
  type SessionId as SessionIdBrand,
  type TenantId as TenantIdBrand,
  type WorkItemId,
} from "../ids.ts";
import { Attr, SpanName, withSpan } from "../telemetry/otel.ts";
import type { TranscriptEntry } from "./transcript.ts";

export type CreateSessionSpec = Readonly<{
  agentId: AgentIdBrand;
  tenantId: TenantIdBrand;
  originatingTrigger: unknown;
  parentSessionId: SessionIdBrand | null;
  chainId: ChainIdBrand;
  depth: Depth;
  openingContext: readonly TranscriptEntry[]; // computed by trigger synthesizer; passed to runTurnLoop (RELAY-8)
  sourceWorkItemId: WorkItemId;
}>;

export type SessionCreateError =
  | { kind: "agent_not_found"; agentId: AgentIdBrand }
  | { kind: "tenant_mismatch"; expected: TenantIdBrand; got: TenantIdBrand };

// Sentinel thrown inside sql.begin to abort with a typed error; never escapes createSession.
class TxAbort extends Error {
  public readonly txError: SessionCreateError;
  public constructor(txError: SessionCreateError) {
    super("tx_abort");
    this.txError = txError;
  }
}

type AgentRow = { readonly tenant_id: string };
type InsertRow = { readonly id: string };

async function checkAgent(
  tx: TransactionSql,
  agentId: AgentIdBrand,
  expectedTenantId: TenantIdBrand,
): Promise<void> {
  const rows = await tx<AgentRow[]>`
    SELECT tenant_id FROM agents WHERE id = ${agentId} FOR SHARE
  `;
  if (rows.length === 0) throw new TxAbort({ kind: "agent_not_found", agentId });

  const row = firstRow(rows, "checkAgent");
  const tenantResult = TenantId.parse(row.tenant_id);
  assert(tenantResult.ok, "checkAgent: invalid tenant_id from DB", { tenant_id: row.tenant_id });
  const agentTenant = tenantResult.value;
  if (agentTenant !== expectedTenantId) {
    throw new TxAbort({ kind: "tenant_mismatch", expected: expectedTenantId, got: agentTenant });
  }
}

async function insertSession(
  tx: TransactionSql,
  id: SessionIdBrand,
  spec: CreateSessionSpec,
  createdAt: Date,
): Promise<SessionIdBrand | null> {
  const rows = await tx<InsertRow[]>`
    INSERT INTO sessions (
      id, agent_id, tenant_id, originating_trigger,
      parent_session_id, chain_id, depth,
      source_work_item_id,
      created_at, updated_at
    )
    VALUES (
      ${id},
      ${spec.agentId},
      ${spec.tenantId},
      ${tx.json(spec.originatingTrigger as DbJson)},
      ${spec.parentSessionId},
      ${spec.chainId},
      ${spec.depth as number},
      ${spec.sourceWorkItemId},
      ${createdAt},
      ${createdAt}
    )
    ON CONFLICT (source_work_item_id) WHERE source_work_item_id IS NOT NULL DO NOTHING
    RETURNING id
  `;
  if (rows.length === 0) return null;
  const row = firstRow(rows, "insertSession");
  const parsedId = SessionId.parse(row.id);
  assert(parsedId.ok, "insertSession: invalid id from DB", { id: row.id });
  return parsedId.value;
}

async function findByWorkItem(sql: Sql, sourceWorkItemId: WorkItemId): Promise<SessionIdBrand> {
  const rows = await sql<InsertRow[]>`
    SELECT id FROM sessions WHERE source_work_item_id = ${sourceWorkItemId}
  `;
  assert(rows.length > 0, "findByWorkItem: no session row for known work item", {
    sourceWorkItemId,
  });
  const row = firstRow(rows, "findByWorkItem");
  const parsedId = SessionId.parse(row.id);
  assert(parsedId.ok, "findByWorkItem: invalid id from DB", { id: row.id });
  return parsedId.value;
}

export async function createSession(
  sql: Sql,
  clock: Clock,
  spec: CreateSessionSpec,
): Promise<Result<{ id: SessionIdBrand; isDuplicate: boolean }, SessionCreateError>> {
  const newId = mintId(SessionId.parse, "createSession");
  const createdAt = new Date(clock.now());

  return withSpan(
    SpanName.SessionCreate,
    {
      [Attr.TenantId]: spec.tenantId,
      [Attr.AgentId]: spec.agentId,
      [Attr.ChainId]: spec.chainId,
      [Attr.Depth]: spec.depth,
    },
    async () => {
      let insertedId: SessionIdBrand | null;

      try {
        insertedId = await sql.begin(async (tx) => {
          await checkAgent(tx, spec.agentId, spec.tenantId);
          return insertSession(tx, newId, spec, createdAt);
        });
      } catch (e) {
        if (e instanceof TxAbort) return err(e.txError);
        throw e;
      }

      if (insertedId !== null) {
        return ok({ id: insertedId, isDuplicate: false });
      }

      const existingId = await findByWorkItem(sql, spec.sourceWorkItemId);
      return ok({ id: existingId, isDuplicate: true });
    },
  );
}
