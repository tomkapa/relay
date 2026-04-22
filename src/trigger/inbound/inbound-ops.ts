// DB-touching inbound message operations. Producers (ask/notify tool, HTTP ingress
// follow-ups) call writeInboundMessage *before* enqueueing the work item so the
// payload_ref is a durable row id. RELAY-47.

import type { Sql } from "postgres";
import { assert } from "../../core/assert.ts";
import { err, ok, type Result } from "../../core/result.ts";
import { firstRow } from "../../db/utils.ts";
import {
  InboundMessageId,
  mintId,
  type InboundMessageId as InboundMessageIdBrand,
  type SessionId as SessionIdBrand,
  type TenantId as TenantIdBrand,
  type WorkItemId,
} from "../../ids.ts";
import { MAX_INBOUND_CONTENT_BYTES, MAX_INBOUND_SENDER_EXTERNAL_ID_LEN } from "./limits.ts";
import type { InboundMessageRow } from "./payload.ts";

export type WriteInboundSpec = Readonly<{
  tenantId: TenantIdBrand;
  targetSessionId: SessionIdBrand;
  sender: { type: "human" | "agent" | "system"; id: string; displayName?: string };
  content: string;
  receivedAt: Date;
  sourceWorkItemId: WorkItemId;
}>;

export type InboundOpsError =
  | { kind: "content_too_long"; length: number; max: number }
  | { kind: "sender_id_too_long"; length: number; max: number }
  | { kind: "inbound_not_found"; id: InboundMessageIdBrand };

export async function writeInboundMessage(
  sql: Sql,
  spec: WriteInboundSpec,
): Promise<Result<InboundMessageIdBrand, InboundOpsError>> {
  if (spec.content.length > MAX_INBOUND_CONTENT_BYTES) {
    return err({
      kind: "content_too_long",
      length: spec.content.length,
      max: MAX_INBOUND_CONTENT_BYTES,
    });
  }
  if (spec.sender.id.length > MAX_INBOUND_SENDER_EXTERNAL_ID_LEN) {
    return err({
      kind: "sender_id_too_long",
      length: spec.sender.id.length,
      max: MAX_INBOUND_SENDER_EXTERNAL_ID_LEN,
    });
  }

  const id = mintId(InboundMessageId.parse, "writeInboundMessage");
  const displayName = spec.sender.displayName ?? null;

  // DO UPDATE with a no-op (received_at = itself) so RETURNING fires on both insert and
  // conflict paths, avoiding a second SELECT round-trip on the duplicate-key case.
  const rows = await sql<{ id: string }[]>`
    INSERT INTO inbound_messages (
      id, tenant_id, target_session_id,
      sender_type, sender_id, sender_display_name,
      kind, content, received_at, source_work_item_id
    )
    VALUES (
      ${id}, ${spec.tenantId}, ${spec.targetSessionId},
      ${spec.sender.type}, ${spec.sender.id}, ${displayName},
      'message', ${spec.content}, ${spec.receivedAt}, ${spec.sourceWorkItemId}
    )
    ON CONFLICT (source_work_item_id) WHERE source_work_item_id IS NOT NULL
    DO UPDATE SET received_at = inbound_messages.received_at
    RETURNING id
  `;

  const row = firstRow(rows, "writeInboundMessage");
  const parsed = InboundMessageId.parse(row.id);
  assert(parsed.ok, "writeInboundMessage: invalid id from DB", { id: row.id });
  return ok(parsed.value);
}

export async function readInboundMessage(
  sql: Sql,
  id: InboundMessageIdBrand,
): Promise<Result<InboundMessageRow, InboundOpsError>> {
  const rows = await sql<InboundMessageRow[]>`
    SELECT id, tenant_id, target_session_id,
           sender_type, sender_id, sender_display_name,
           kind, content, received_at
    FROM inbound_messages
    WHERE id = ${id}
  `;

  if (rows.length === 0) return err({ kind: "inbound_not_found", id });

  return ok(firstRow(rows, "readInboundMessage"));
}
