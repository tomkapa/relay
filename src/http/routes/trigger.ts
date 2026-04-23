// POST /trigger — synchronous relay endpoint. Holds the HTTP response open until the
// session closes, then returns the model's final text as JSON. Closes Iter 0's release gate.
// Cross-process coordination via Postgres LISTEN/NOTIFY; see ReplyRegistry + SyncListener.

import { Hono } from "hono";
import { z } from "zod";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { Sql } from "postgres";
import type { Clock } from "../../core/clock.ts";
import { assertNever } from "../../core/assert.ts";
import { err, ok, type Result } from "../../core/result.ts";
import { AgentId, TenantId } from "../../ids.ts";
import type { AgentId as AgentIdBrand, TenantId as TenantIdBrand } from "../../ids.ts";
import { Attr, SpanName, counter, emit, histogram, tracer } from "../../telemetry/otel.ts";
import { writeEnvelope } from "../../trigger/envelope-ops.ts";
import {
  MAX_MESSAGE_CONTENT_BYTES,
  MAX_SENDER_DISPLAY_NAME_LEN,
  MAX_SENDER_EXTERNAL_ID_LEN,
} from "../../trigger/limits.ts";
import { enqueue } from "../../work_queue/queue-ops.ts";
import { readFinalTurnResponse } from "../../session/read-final-turn.ts";
import type { ReplyRegistry, SyncOutcome } from "../reply-registry.ts";
import { MAX_SYNC_WAIT_MS } from "../limits.ts";

export type TriggerRouteError =
  | {
      readonly kind: "validation_failed";
      readonly issues: readonly { path: string; message: string }[];
    }
  | { readonly kind: "envelope_too_large"; readonly bytes: number; readonly max: number }
  | { readonly kind: "content_too_long"; readonly length: number; readonly max: number }
  | { readonly kind: "agent_id_invalid"; readonly reason: string }
  | { readonly kind: "tenant_id_invalid"; readonly reason: string }
  | { readonly kind: "enqueue_failed"; readonly detail: string }
  | { readonly kind: "sync_wait_timeout"; readonly waitedMs: number }
  | { readonly kind: "sync_capacity_exhausted"; readonly cap: number };

type TriggerBody = {
  readonly tenantId: TenantIdBrand;
  readonly agentId: AgentIdBrand;
  readonly sender: {
    readonly type: "human" | "agent" | "system";
    readonly id: string;
    readonly displayName?: string;
  };
  readonly content: string;
};

const TriggerBodySchema = z
  .object({
    tenantId: z.string().uuid(),
    targetAgentId: z.string().uuid(),
    sender: z.object({
      type: z.enum(["human", "agent", "system"]),
      id: z.string().min(1).max(MAX_SENDER_EXTERNAL_ID_LEN),
      displayName: z.string().max(MAX_SENDER_DISPLAY_NAME_LEN).optional(),
    }),
    content: z.string().min(1).max(MAX_MESSAGE_CONTENT_BYTES),
  })
  .strict();

function parseTriggerBody(raw: unknown): Result<TriggerBody, TriggerRouteError> {
  const zResult = TriggerBodySchema.safeParse(raw);
  if (!zResult.success) {
    const issues = zResult.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    }));
    return err({ kind: "validation_failed", issues });
  }
  const d = zResult.data;
  const tenantResult = TenantId.parse(d.tenantId);
  if (!tenantResult.ok) return err({ kind: "tenant_id_invalid", reason: tenantResult.error.kind });
  const agentResult = AgentId.parse(d.targetAgentId);
  if (!agentResult.ok) return err({ kind: "agent_id_invalid", reason: agentResult.error.kind });
  const sender =
    d.sender.displayName !== undefined
      ? { type: d.sender.type, id: d.sender.id, displayName: d.sender.displayName }
      : { type: d.sender.type, id: d.sender.id };
  return ok({
    tenantId: tenantResult.value,
    agentId: agentResult.value,
    sender,
    content: d.content,
  });
}

export type TriggerDeps = {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly registry: ReplyRegistry;
  /** Override for tests; defaults to MAX_SYNC_WAIT_MS. */
  readonly maxWaitMs?: number;
};

export function triggerRoute(deps: TriggerDeps): Hono {
  const app = new Hono();

  app.post("/trigger", (c) => {
    return tracer.startActiveSpan(
      SpanName.HttpTriggerPost,
      { kind: SpanKind.SERVER },
      async (span) => {
        try {
          let raw: unknown;
          try {
            raw = await c.req.json();
          } catch (e) {
            if (!(e instanceof SyntaxError)) throw e;
            span.recordException(e);
            span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
            return c.json(
              {
                error: {
                  kind: "validation_failed",
                  issues: [{ path: "", message: "invalid JSON body" }],
                },
              },
              400,
            );
          }

          const parseResult = parseTriggerBody(raw);
          if (!parseResult.ok) {
            emit("INFO", "http.trigger.rejected", { kind: parseResult.error.kind });
            span.setStatus({ code: SpanStatusCode.ERROR, message: parseResult.error.kind });
            return c.json({ error: parseResult.error }, triggerErrorStatus(parseResult.error));
          }
          const { tenantId, agentId, sender, content } = parseResult.value;

          const receivedAt = new Date(deps.clock.now());
          const envelopePayload = {
            kind: "message",
            sender,
            targetAgentId: agentId as string,
            content,
            receivedAt: receivedAt.toISOString(),
          };

          const envelopeResult = await writeEnvelope(
            deps.sql,
            tenantId,
            "message",
            envelopePayload,
          );
          if (!envelopeResult.ok) {
            emit("INFO", "http.trigger.rejected", { kind: envelopeResult.error.kind });
            span.setStatus({ code: SpanStatusCode.ERROR, message: envelopeResult.error.kind });
            return c.json({ error: envelopeResult.error }, 400);
          }
          const envelopeId = envelopeResult.value;

          const registerResult = deps.registry.register(envelopeId);
          if (!registerResult.ok) {
            counter("http.trigger.sync_capacity_exhausted_total").add(1);
            emit("INFO", "http.trigger.capacity_exhausted", { cap: registerResult.error.cap });
            span.setStatus({ code: SpanStatusCode.ERROR, message: registerResult.error.kind });
            return c.json({ error: registerResult.error }, 503);
          }
          const deferred = registerResult.value;

          const enqueueResult = await enqueue(deps.sql, {
            tenantId,
            kind: "session_start",
            payloadRef: envelopeId,
            scheduledAt: receivedAt,
          });
          if (!enqueueResult.ok) {
            deps.registry.drop(envelopeId);
            emit("INFO", "http.trigger.enqueue_failed", {
              [Attr.TenantId]: tenantId,
              detail: enqueueResult.error.kind,
            });
            span.setStatus({ code: SpanStatusCode.ERROR, message: enqueueResult.error.kind });
            return c.json(
              { error: { kind: "enqueue_failed", detail: enqueueResult.error.kind } },
              503,
            );
          }

          counter("http.trigger.received_total").add(1, { [Attr.TenantId]: tenantId });
          emit("INFO", "http.trigger.enqueued", {
            [Attr.EnvelopeId]: envelopeId,
            [Attr.TenantId]: tenantId,
          });

          const startWaitMs = deps.clock.monotonic();
          const ac = new AbortController();
          const timeoutMs = deps.maxWaitMs ?? MAX_SYNC_WAIT_MS;
          const timeoutP = new Promise<SyncOutcome>((resolve) => {
            void deps.clock.sleep(timeoutMs, ac.signal).then(
              () => {
                resolve({ kind: "timeout", waitedMs: timeoutMs });
              },
              () => {
                return undefined;
              }, // aborted — deferred already resolved via ac.abort()
            );
          });

          const outcome = await Promise.race([deferred, timeoutP]);
          ac.abort();
          deps.registry.drop(envelopeId); // idempotent — no-op if NOTIFY already resolved it

          const elapsedMs = deps.clock.monotonic() - startWaitMs;
          histogram("http.trigger.sync_wait_ms").record(elapsedMs, { [Attr.TenantId]: tenantId });

          if (outcome.kind === "timeout") {
            counter("http.trigger.timeout_total").add(1, { [Attr.TenantId]: tenantId });
            emit("INFO", "http.trigger.timeout", {
              [Attr.TenantId]: tenantId,
              waited_ms: timeoutMs,
            });
            span.setStatus({ code: SpanStatusCode.ERROR, message: "sync_wait_timeout" });
            return c.json(
              { session_id: null, error: { kind: "sync_wait_timeout", waited_ms: timeoutMs } },
              504,
            );
          }

          const finalTurnResult = await readFinalTurnResponse(deps.sql, outcome.sessionId);
          if (!finalTurnResult.ok) {
            emit("WARN", "http.trigger.final_turn_missing", {
              [Attr.SessionId]: outcome.sessionId,
            });
            span.setStatus({ code: SpanStatusCode.ERROR, message: finalTurnResult.error.kind });
            return c.json(
              {
                session_id: outcome.sessionId,
                error: { kind: "session_failed", detail: finalTurnResult.error.kind },
              },
              500,
            );
          }

          const { text, stopReason, usage } = finalTurnResult.value;
          emit("INFO", "http.trigger.completed", {
            [Attr.SessionId]: outcome.sessionId,
            stop_reason: stopReason,
            duration_ms: elapsedMs,
          });
          return c.json(
            { session_id: outcome.sessionId, text, stop_reason: stopReason, usage },
            200,
          );
        } catch (e) {
          span.recordException(e as Error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
          throw e;
        } finally {
          span.end();
        }
      },
    );
  });

  return app;
}

export function triggerErrorStatus(error: TriggerRouteError): 400 | 503 | 504 | 500 {
  switch (error.kind) {
    case "validation_failed":
    case "envelope_too_large":
    case "content_too_long":
    case "agent_id_invalid":
    case "tenant_id_invalid":
      return 400;
    case "enqueue_failed":
    case "sync_capacity_exhausted":
      return 503;
    case "sync_wait_timeout":
      return 504;
    default:
      return assertNever(error);
  }
}
