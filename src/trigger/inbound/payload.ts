// Boundary parser for inbound message rows. Zod validates shape at the DB boundary;
// smart constructors produce branded types. No raw strings escape into the handler core.
// CLAUDE.md §1 (Parse, don't validate) and §12 (one error type per boundary).

import { z } from "zod";
import { err, ok, type Result } from "../../core/result.ts";
import { SessionId, type SessionId as SessionIdBrand } from "../../ids.ts";
import {
  MAX_INBOUND_CONTENT_BYTES,
  MAX_INBOUND_SENDER_DISPLAY_NAME_LEN,
  MAX_INBOUND_SENDER_EXTERNAL_ID_LEN,
} from "./limits.ts";

export type InboundMessagePayload = {
  readonly kind: "message";
  readonly sender: {
    readonly type: "human" | "agent" | "system";
    readonly id: string;
    readonly displayName?: string;
  };
  readonly targetSessionId: SessionIdBrand;
  readonly content: string;
  readonly receivedAt: Date;
};

export type InboundPayloadError =
  | { kind: "validation_failed"; issues: readonly { path: string; message: string }[] }
  | { kind: "content_too_long"; length: number; max: number }
  | { kind: "unknown_kind"; value: string }
  | { kind: "session_id_invalid"; reason: string }
  | { kind: "sender_id_too_long"; length: number; max: number };

export type InboundMessageRow = {
  readonly id: string;
  readonly tenant_id: string;
  readonly target_session_id: string;
  readonly sender_type: string;
  readonly sender_id: string;
  readonly sender_display_name: string | null;
  readonly kind: string;
  readonly content: string;
  readonly received_at: Date;
};

const InboundRowSchema = z.object({
  id: z.uuid(),
  tenant_id: z.uuid(),
  target_session_id: z.string().min(1),
  sender_type: z.enum(["human", "agent", "system"]),
  sender_id: z.string().min(1),
  sender_display_name: z.string().max(MAX_INBOUND_SENDER_DISPLAY_NAME_LEN).nullable(),
  kind: z.literal("message"),
  content: z.string().min(1),
  received_at: z.date(),
});

export function parseInboundMessageRow(
  row: InboundMessageRow,
): Result<InboundMessagePayload, InboundPayloadError> {
  if (row.kind !== "message") return err({ kind: "unknown_kind", value: row.kind });

  const parsed = InboundRowSchema.safeParse(row);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    }));
    return err({ kind: "validation_failed", issues });
  }

  const body = parsed.data;

  if (body.sender_id.length > MAX_INBOUND_SENDER_EXTERNAL_ID_LEN) {
    return err({
      kind: "sender_id_too_long",
      length: body.sender_id.length,
      max: MAX_INBOUND_SENDER_EXTERNAL_ID_LEN,
    });
  }
  if (body.content.length > MAX_INBOUND_CONTENT_BYTES) {
    return err({
      kind: "content_too_long",
      length: body.content.length,
      max: MAX_INBOUND_CONTENT_BYTES,
    });
  }

  const sessionResult = SessionId.parse(body.target_session_id);
  if (!sessionResult.ok) {
    return err({ kind: "session_id_invalid", reason: sessionResult.error.kind });
  }

  type Sender = InboundMessagePayload["sender"];
  const sender: Sender =
    body.sender_display_name !== null
      ? { type: body.sender_type, id: body.sender_id, displayName: body.sender_display_name }
      : { type: body.sender_type, id: body.sender_id };

  return ok({
    kind: "message",
    sender,
    targetSessionId: sessionResult.value,
    content: body.content,
    receivedAt: body.received_at,
  });
}
