// Single process-wide LISTEN on session_sync_close.
// One connection holds the LISTEN for process lifetime; an in-memory Map demultiplexes
// NOTIFY payloads to the right waiter by envelopeId (O(1) per notification).

import { z } from "zod";
import type { Sql } from "postgres";
import { assert } from "../core/assert.ts";
import { EnvelopeId, SessionId } from "../ids.ts";
import { emit } from "../telemetry/otel.ts";
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      emit("WARN", "sync_listener.malformed_json", { raw: raw.slice(0, 256) });
      return;
    }

    const result = NotifyPayloadSchema.safeParse(parsed);
    if (!result.success) {
      emit("WARN", "sync_listener.invalid_payload", { raw: raw.slice(0, 256) });
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
  });

  return { stop: () => listenHandle.unlisten() };
}
