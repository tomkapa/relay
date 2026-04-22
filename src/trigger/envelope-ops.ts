// DB-touching envelope operations. trigger_envelopes rows are written by producers
// (HTTP ingress, event connectors) and read once per session by the session_start handler.
// See SPEC §Triggers and migration 0003.

import type { Sql } from "postgres";
import { assert } from "../core/assert.ts";
import { err, ok, type Result } from "../core/result.ts";
import { type DbJson, firstRow } from "../db/utils.ts";
import {
  EnvelopeId,
  TenantId,
  mintId,
  type EnvelopeId as EnvelopeIdBrand,
  type TenantId as TenantIdBrand,
} from "../ids.ts";
import { MAX_ENVELOPE_BYTES } from "./limits.ts";

export type Envelope = {
  readonly id: EnvelopeIdBrand;
  readonly tenantId: TenantIdBrand;
  readonly kind: "message" | "event";
  readonly payload: unknown;
  readonly createdAt: Date;
};

export type EnvelopeError =
  | { kind: "envelope_not_found"; id: EnvelopeIdBrand }
  | { kind: "envelope_too_large"; bytes: number; max: number }
  | { kind: "id_invalid"; reason: string }
  | { kind: "tenant_id_invalid"; reason: string };

type EnvelopeRow = {
  readonly id: string;
  readonly tenant_id: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly created_at: Date;
};

export async function writeEnvelope(
  sql: Sql,
  tenantId: TenantIdBrand,
  kind: "message" | "event",
  payload: unknown,
): Promise<Result<EnvelopeIdBrand, EnvelopeError>> {
  const payloadBytes = JSON.stringify(payload).length;
  if (payloadBytes > MAX_ENVELOPE_BYTES) {
    return err({ kind: "envelope_too_large", bytes: payloadBytes, max: MAX_ENVELOPE_BYTES });
  }

  const id = mintId(EnvelopeId.parse, "writeEnvelope");

  await sql`
    INSERT INTO trigger_envelopes (id, tenant_id, kind, payload)
    VALUES (${id}, ${tenantId}, ${kind}, ${sql.json(payload as DbJson)})
  `;

  return ok(id);
}

export async function readEnvelope(
  sql: Sql,
  id: EnvelopeIdBrand,
): Promise<Result<Envelope, EnvelopeError>> {
  const rows = await sql<EnvelopeRow[]>`
    SELECT id, tenant_id, kind, payload, created_at
    FROM trigger_envelopes
    WHERE id = ${id}
  `;

  if (rows.length === 0) return err({ kind: "envelope_not_found", id });

  const row = firstRow(rows, "readEnvelope");

  assert(row.kind === "message" || row.kind === "event", "readEnvelope: unexpected kind from DB", {
    kind: row.kind,
  });

  const tenantResult = TenantId.parse(row.tenant_id);
  assert(tenantResult.ok, "readEnvelope: invalid tenant_id from DB", { tenant_id: row.tenant_id });

  const idResult = EnvelopeId.parse(row.id);
  assert(idResult.ok, "readEnvelope: invalid id from DB", { id: row.id });

  return ok({
    id: idResult.value,
    tenantId: tenantResult.value,
    kind: row.kind,
    payload: row.payload,
    createdAt: row.created_at,
  });
}
