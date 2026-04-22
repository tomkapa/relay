// SPEC: "Prompt synthesis depends on trigger kind. The rest of the pipeline does not."
// Keep the kind-switch contained here; every other step is kind-uniform.

import { unreachable } from "../core/result.ts";
import type { LoadedAgent } from "../agent/load.ts";
import type { TranscriptEntry } from "../session/transcript.ts";

// Synthesize only reads the system prompt; id/tenantId are not needed here.
type SynthesisAgent = Pick<LoadedAgent, "systemPrompt">;
import { MAX_OPENING_USER_CONTENT } from "./limits.ts";
import type { TriggerPayload } from "./payload.ts";

const TRUNCATION_MARKER = "\n[…truncated]";

function truncateWithMarker(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

function renderEvent(source: string, data: unknown): string {
  const compact = JSON.stringify(data);
  const summary = truncateWithMarker(compact, MAX_OPENING_USER_CONTENT - source.length - 16);
  return `Event from ${source}: ${summary}`;
}

function renderTaskIntent(intent: string, firedAt: Date): string {
  return `Scheduled task fired at ${firedAt.toISOString()}: ${intent}`;
}

export function synthesizeOpeningContext(
  payload: TriggerPayload,
  agent: SynthesisAgent,
): readonly TranscriptEntry[] {
  const system: TranscriptEntry = { role: "system", content: agent.systemPrompt };

  switch (payload.kind) {
    case "message":
      return [
        system,
        {
          role: "user",
          content: truncateWithMarker(payload.content, MAX_OPENING_USER_CONTENT),
          sender: payload.sender,
          receivedAt: payload.receivedAt.toISOString(),
        },
      ];
    case "event":
      return [
        system,
        {
          role: "user",
          content: renderEvent(payload.source, payload.data),
          receivedAt: payload.receivedAt.toISOString(),
        },
      ];
    case "task_fire":
      return [
        system,
        {
          role: "user",
          content: renderTaskIntent(payload.intent, payload.firedAt),
        },
      ];
    default:
      throw unreachable(payload);
  }
}
