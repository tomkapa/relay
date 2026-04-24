// Boundary parsers for trigger payloads. Zod validates shape at the DB-JSON boundary;
// smart constructors produce branded types. No raw strings escape into the domain core.
// See CLAUDE.md §1 (Parse, don't validate) and §12 (one error type per boundary).

import { z } from "zod";
import { err, ok, type Result } from "../core/result.ts";
import {
  AgentId,
  TaskId,
  type AgentId as AgentIdBrand,
  type TaskId as TaskIdBrand,
} from "../ids.ts";
import {
  MAX_ENVELOPE_BYTES,
  MAX_EVENT_SOURCE_LEN,
  MAX_MESSAGE_CONTENT_BYTES,
  MAX_SENDER_DISPLAY_NAME_LEN,
  MAX_SENDER_EXTERNAL_ID_LEN,
  MAX_TASK_INTENT_LEN,
} from "./limits.ts";

export type TriggerPayload =
  | {
      readonly kind: "message";
      readonly sender: {
        readonly type: "human" | "agent" | "system";
        readonly id: string;
        readonly displayName?: string;
      };
      readonly targetAgentId: AgentIdBrand;
      readonly content: string;
      readonly receivedAt: Date;
    }
  | {
      readonly kind: "event";
      readonly source: string;
      readonly targetAgentId: AgentIdBrand;
      readonly data: unknown;
      readonly receivedAt: Date;
    }
  | {
      readonly kind: "task_fire";
      readonly taskId: TaskIdBrand;
      readonly agentId: AgentIdBrand;
      readonly intent: string;
      readonly firedAt: Date;
    };

export type TriggerPayloadError =
  | { kind: "validation_failed"; issues: readonly { path: string; message: string }[] }
  | { kind: "content_too_long"; length: number; max: number }
  | { kind: "unknown_kind"; value: string }
  | { kind: "agent_id_invalid"; reason: string }
  | { kind: "task_id_invalid"; reason: string }
  | { kind: "envelope_too_large"; bytes: number; max: number };

export type TaskRow = {
  readonly id: string;
  readonly agent_id: string;
  readonly tenant_id: string;
  readonly intent: string;
};

const SenderSchema = z.object({
  type: z.enum(["human", "agent", "system"]),
  id: z.string().min(1).max(MAX_SENDER_EXTERNAL_ID_LEN),
  displayName: z.string().max(MAX_SENDER_DISPLAY_NAME_LEN).optional(),
});

const MessagePayloadSchema = z.object({
  kind: z.literal("message"),
  sender: SenderSchema,
  targetAgentId: z.uuid(),
  content: z.string().min(1),
  receivedAt: z.iso.datetime(),
});

const EventPayloadSchema = z.object({
  kind: z.literal("event"),
  source: z.string().min(1).max(MAX_EVENT_SOURCE_LEN),
  targetAgentId: z.uuid(),
  data: z.unknown(),
  receivedAt: z.iso.datetime(),
});

const EnvelopePayloadSchema = z.discriminatedUnion("kind", [
  MessagePayloadSchema,
  EventPayloadSchema,
]);

export function parseEnvelopePayload(
  raw: unknown,
): Result<Extract<TriggerPayload, { kind: "message" | "event" }>, TriggerPayloadError> {
  const serialized = JSON.stringify(raw);
  if (serialized.length > MAX_ENVELOPE_BYTES) {
    return err({ kind: "envelope_too_large", bytes: serialized.length, max: MAX_ENVELOPE_BYTES });
  }

  const parsed = EnvelopePayloadSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    }));
    return err({ kind: "validation_failed", issues });
  }

  const body = parsed.data;

  if (body.kind === "message") {
    if (body.content.length > MAX_MESSAGE_CONTENT_BYTES) {
      return err({
        kind: "content_too_long",
        length: body.content.length,
        max: MAX_MESSAGE_CONTENT_BYTES,
      });
    }
    const agentResult = AgentId.parse(body.targetAgentId);
    if (!agentResult.ok) {
      return err({ kind: "agent_id_invalid", reason: agentResult.error.kind });
    }
    type MessageSender = Extract<TriggerPayload, { kind: "message" }>["sender"];
    const sender: MessageSender =
      body.sender.displayName !== undefined
        ? { type: body.sender.type, id: body.sender.id, displayName: body.sender.displayName }
        : { type: body.sender.type, id: body.sender.id };
    return ok({
      kind: "message",
      sender,
      targetAgentId: agentResult.value,
      content: body.content,
      receivedAt: new Date(body.receivedAt),
    });
  }

  const agentResult = AgentId.parse(body.targetAgentId);
  if (!agentResult.ok) {
    return err({ kind: "agent_id_invalid", reason: agentResult.error.kind });
  }
  return ok({
    kind: "event",
    source: body.source,
    targetAgentId: agentResult.value,
    data: body.data,
    receivedAt: new Date(body.receivedAt),
  });
}

export function parseTaskRow(
  row: TaskRow,
  firedAt: Date,
): Result<Extract<TriggerPayload, { kind: "task_fire" }>, TriggerPayloadError> {
  if (row.intent.length > MAX_TASK_INTENT_LEN) {
    return err({ kind: "content_too_long", length: row.intent.length, max: MAX_TASK_INTENT_LEN });
  }

  const taskResult = TaskId.parse(row.id);
  if (!taskResult.ok) {
    return err({ kind: "task_id_invalid", reason: taskResult.error.kind });
  }

  const agentResult = AgentId.parse(row.agent_id);
  if (!agentResult.ok) {
    return err({ kind: "agent_id_invalid", reason: agentResult.error.kind });
  }

  return ok({
    kind: "task_fire",
    taskId: taskResult.value,
    agentId: agentResult.value,
    intent: row.intent,
    firedAt,
  });
}
