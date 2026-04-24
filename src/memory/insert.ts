// Canonical write path for memory rows. Callers compose this inside their own transaction
// so related writes (idempotency key, audit row) are atomic.

import type { TransactionSql } from "postgres";
import { assert } from "../core/assert.ts";
import { err, ok, type Result } from "../core/result.ts";
import { firstRow } from "../db/utils.ts";
import {
  MemoryId,
  TenantId,
  mintId,
  type AgentId,
  type Importance,
  type MemoryId as MemoryIdBrand,
  type TenantId as TenantIdBrand,
} from "../ids.ts";
import { Attr, SpanName, withSpan } from "../telemetry/otel.ts";
import { EMBEDDING_DIM, MAX_ENTRY_TEXT_BYTES } from "./limits.ts";
import type { MemoryKind } from "./kind.ts";

export type InsertMemoryInput = {
  readonly agentId: AgentId;
  readonly tenantId: TenantIdBrand;
  readonly kind: MemoryKind;
  readonly text: string;
  readonly embedding: Float32Array;
  readonly importance: Importance;
};

export type MemoryRow = {
  readonly id: MemoryIdBrand;
  readonly agentId: AgentId;
  readonly tenantId: TenantIdBrand;
  readonly kind: MemoryKind;
  readonly text: string;
  readonly importance: Importance;
  readonly createdAt: Date;
  readonly lastRetrievedAt: Date | null;
  readonly retrievalCount: number;
};

export type InsertMemoryError =
  | {
      readonly kind: "tenant_mismatch";
      readonly expected: TenantIdBrand;
      readonly got: TenantIdBrand;
    }
  | { readonly kind: "agent_not_found"; readonly agentId: AgentId }
  | { readonly kind: "text_too_long"; readonly bytes: number; readonly max: number };

type AgentDbRow = { readonly tenant_id: string };
type MemoryDbRow = {
  readonly id: string;
  readonly agent_id: string;
  readonly tenant_id: string;
  readonly kind: string;
  readonly text: string;
  readonly importance: number;
  readonly created_at: Date;
  readonly last_retrieved_at: Date | null;
  readonly retrieval_count: number;
};

export async function insertMemory(
  tx: TransactionSql,
  input: InsertMemoryInput,
): Promise<Result<MemoryRow, InsertMemoryError>> {
  assert(input.embedding.length === EMBEDDING_DIM, "insertMemory: embedding dimension mismatch", {
    got: input.embedding.length,
    expected: EMBEDDING_DIM,
  });

  const bytes = Buffer.byteLength(input.text, "utf8");
  if (bytes > MAX_ENTRY_TEXT_BYTES) {
    return err({ kind: "text_too_long", bytes, max: MAX_ENTRY_TEXT_BYTES });
  }

  const id = mintId(MemoryId.parse, "insertMemory");

  return withSpan(
    SpanName.MemoryWrite,
    {
      [Attr.AgentId]: input.agentId,
      [Attr.TenantId]: input.tenantId,
      [Attr.MemoryKind]: input.kind,
    },
    async () => {
      const agentRows = await tx<AgentDbRow[]>`
        SELECT tenant_id FROM agents WHERE id = ${input.agentId} FOR SHARE
      `;

      if (agentRows.length === 0) {
        return err({ kind: "agent_not_found", agentId: input.agentId });
      }

      const agentRow = firstRow(agentRows, "insertMemory.checkAgent");
      const agentTenantResult = TenantId.parse(agentRow.tenant_id);
      assert(agentTenantResult.ok, "insertMemory: invalid tenant_id from DB", {
        tenant_id: agentRow.tenant_id,
      });
      const agentTenantId = agentTenantResult.value;

      if (agentTenantId !== input.tenantId) {
        return err({ kind: "tenant_mismatch", expected: input.tenantId, got: agentTenantId });
      }

      // Pass embedding as a parameterized string; ::vector cast is in the SQL template (CLAUDE §10).
      const embeddingStr = `[${input.embedding.join(",")}]`;

      const rows = await tx<MemoryDbRow[]>`
        INSERT INTO memory (id, tenant_id, agent_id, kind, text, embedding, importance)
        VALUES (
          ${id},
          ${input.tenantId},
          ${input.agentId},
          ${input.kind as string},
          ${input.text},
          ${embeddingStr}::vector,
          ${input.importance as number}
        )
        RETURNING id, agent_id, tenant_id, kind, text, importance,
                  created_at, last_retrieved_at, retrieval_count
      `;

      const row = firstRow(rows, "insertMemory.insert");

      const parsedId = MemoryId.parse(row.id);
      assert(parsedId.ok, "insertMemory: id from DB is invalid", { id: row.id });

      return ok({
        id: parsedId.value,
        agentId: row.agent_id as AgentId,
        tenantId: row.tenant_id as TenantIdBrand,
        kind: input.kind,
        text: row.text,
        importance: row.importance as Importance,
        createdAt: row.created_at,
        lastRetrievedAt: row.last_retrieved_at,
        retrievalCount: row.retrieval_count,
      });
    },
  );
}
