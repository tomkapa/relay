// Single process-wide LISTEN on session_sync_close.
// One connection holds the LISTEN for process lifetime; an in-memory Map demultiplexes
// NOTIFY payloads to the right waiter by envelopeId (O(1) per notification).

import { z } from "zod";
import { SpanStatusCode } from "@opentelemetry/api";
import type { Sql } from "postgres";
import { assert } from "../core/assert.ts";
import { EnvelopeId, SessionId } from "../ids.ts";
import { SpanName, emit, tracer } from "../telemetry/otel.ts";
import type { ReplyRegistry, SyncOutcome } from "./reply-registry.ts";

export const SYNC_CHANNEL = "session_sync_close";

const NotifyPayloadSchema = z.object({
  envelopeId: z.string().uuid(),
  sessionId: z.string().uuid(),
  reason: z.enum(["end_turn", "turn_cap_exceeded"]),
});

export async function startSyncListener(
  sql: Sql,
  registry: ReplyRegistry,
): Promise<{ stop: () => Promise<void> }> {
  const listenHandle = await sql.listen(SYNC_CHANNEL, (raw) => {
    tracer.startActiveSpan(SpanName.SessionSyncDispatch, (span) => {
      try {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw) as unknown;
        } catch (e) {
          emit("WARN", "sync_listener.malformed_json", { raw: raw.slice(0, 256) });
          span.recordException(e as Error);
          span.setStatus({ code: SpanStatusCode.ERROR, message: "malformed_json" });
          return;
        }

        const result = NotifyPayloadSchema.safeParse(parsed);
        if (!result.success) {
          emit("WARN", "sync_listener.invalid_payload", { raw: raw.slice(0, 256) });
          span.setStatus({ code: SpanStatusCode.ERROR, message: "invalid_payload" });
          return;
        }

        const { envelopeId: envStr, sessionId: sessStr, reason } = result.data;

        const envelopeIdResult = EnvelopeId.parse(envStr);
        const sessionIdResult = SessionId.parse(sessStr);
        // Zod validates uuid() shape; parse should always succeed post-Zod.
        assert(envelopeIdResult.ok, "startSyncListener: NOTIFY envelopeId invalid post-zod");
        assert(sessionIdResult.ok, "startSyncListener: NOTIFY sessionId invalid post-zod");

        const outcome: SyncOutcome = {
          kind: "closed",
          sessionId: sessionIdResult.value,
          reason,
        };
        registry.resolve(envelopeIdResult.value, outcome);
      } catch (e) {
        span.recordException(e as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
        throw e;
      } finally {
        span.end();
      }
    });
  });

  return { stop: () => listenHandle.unlisten() };
}
