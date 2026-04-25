// SPEC: "Prompt synthesis depends on trigger kind. The rest of the pipeline does not."
// Keep the kind-switch contained here; every other step is kind-uniform.

import { assert } from "../core/assert.ts";
import type { Clock } from "../core/clock.ts";
import { unreachable } from "../core/result.ts";
import type { Sql } from "postgres";
import type { LoadedAgent } from "../agent/load.ts";
import type { EmbeddingClient } from "../memory/embedding.ts";
import { RetrievalK } from "../ids.ts";
import type { AgentId, TenantId } from "../ids.ts";
import { MAX_MEMORY_INJECTION, MAX_MEMORY_PREAMBLE_BYTES } from "../memory/limits.ts";
import { retrieveMemory } from "../memory/retrieve.ts";
import type { RankedMemory } from "../memory/retrieve.ts";
import type { TranscriptEntry } from "../session/transcript.ts";
import { Attr, SpanName, counter, emit, histogram, withSpan } from "../telemetry/otel.ts";
import { MAX_OPENING_USER_CONTENT } from "./limits.ts";
import type { TriggerPayload } from "./payload.ts";

export type SynthesizeDeps = {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly embedder: EmbeddingClient;
};

// Synthesis now needs id + tenantId for memory retrieval, in addition to systemPrompt.
type SynthesisAgent = Pick<LoadedAgent, "id" | "tenantId" | "systemPrompt">;

// Parsed once at module load — MAX_MEMORY_INJECTION is a compile-time constant.
const _kResult = RetrievalK.parse(MAX_MEMORY_INJECTION);
assert(_kResult.ok, "synthesize: MAX_MEMORY_INJECTION is out of RetrievalK range");
const INJECTION_K: RetrievalK = _kResult.value;

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

type BaseEntries = {
  readonly entries: readonly [TranscriptEntry, TranscriptEntry];
  readonly userText: string;
};

export function buildBaseEntries(payload: TriggerPayload, systemPrompt: string): BaseEntries {
  const system: TranscriptEntry = { role: "system", content: systemPrompt };

  switch (payload.kind) {
    case "message": {
      const content = truncateWithMarker(payload.content, MAX_OPENING_USER_CONTENT);
      return {
        entries: [
          system,
          {
            role: "user",
            content,
            sender: payload.sender,
            receivedAt: payload.receivedAt.toISOString(),
          },
        ],
        userText: content,
      };
    }
    case "event": {
      const content = renderEvent(payload.source, payload.data);
      return {
        entries: [system, { role: "user", content, receivedAt: payload.receivedAt.toISOString() }],
        userText: content,
      };
    }
    case "task_fire": {
      const content = renderTaskIntent(payload.intent, payload.firedAt);
      return {
        entries: [system, { role: "user", content }],
        userText: content,
      };
    }
    default:
      throw unreachable(payload);
  }
}

export function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 512 ? flat.slice(0, 509) + "..." : flat;
}

export function humanizeAge(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 3600) return `${Math.floor(sec / 60).toString()}m ago`;
  if (sec < 86_400) return `${Math.floor(sec / 3600).toString()}h ago`;
  if (sec < 7 * 86_400) return `${Math.floor(sec / 86_400).toString()}d ago`;
  return `${Math.floor(sec / (7 * 86_400)).toString()}w ago`;
}

export function formatMemoryPreamble(
  systemPrompt: string,
  memories: readonly RankedMemory[],
  now: Date,
): { readonly content: string; readonly truncated: boolean } {
  assert(memories.length > 0, "formatMemoryPreamble: callers must guard empty input");
  const lines: string[] = [];
  let bytes = 0;
  let truncated = false;
  for (const m of memories) {
    const ageLabel = humanizeAge(now.getTime() - m.createdAt.getTime());
    const line = `- [${m.kind}, importance ${m.importance.toFixed(1)}, ${ageLabel}] ${oneLine(m.text)}`;
    const lineBytes = Buffer.byteLength(line, "utf8") + 1; // +1 for newline
    if (bytes + lineBytes > MAX_MEMORY_PREAMBLE_BYTES) {
      truncated = true;
      break;
    }
    lines.push(line);
    bytes += lineBytes;
  }
  const preamble = `\n\n# Recalled memories\n${lines.join("\n")}`;
  return { content: systemPrompt + preamble, truncated };
}

async function tryRetrieveMemoryContext(
  deps: SynthesizeDeps,
  agent: { readonly id: AgentId; readonly tenantId: TenantId },
  queryText: string,
  signal: AbortSignal,
): Promise<readonly RankedMemory[]> {
  const embedResult = await deps.embedder.embed(queryText, signal);
  if (!embedResult.ok) {
    const reason = `embed_${embedResult.error.kind}`;
    counter(
      "relay.memory.injection.skipped_total",
      "Times memory injection was skipped due to a soft failure.",
    ).add(1, { [Attr.MemoryInjectionSkipped]: reason });
    emit("WARN", "memory.injection.embed_failed", {
      [Attr.AgentId]: agent.id,
      [Attr.TenantId]: agent.tenantId,
      [Attr.MemoryInjectionSkipped]: reason,
    });
    return [];
  }

  const retrieveResult = await retrieveMemory(deps.sql, deps.clock, {
    agentId: agent.id,
    tenantId: agent.tenantId,
    queryEmbed: embedResult.value,
    k: INJECTION_K,
  });
  // agent_not_found here is a programmer error: the handler already loaded this agent
  // successfully via loadAgent. If retrieval cannot find the same agent, the world model
  // is broken. Assert per CLAUDE §6 — crash the worker.
  assert(retrieveResult.ok, "synthesize: retrieveMemory failed for an already-loaded agent", {
    agentId: agent.id,
    tenantId: agent.tenantId,
  });
  return retrieveResult.value;
}

export type OpeningContext = {
  readonly entries: readonly TranscriptEntry[];
  readonly userText: string;
};

export async function synthesizeOpeningContext(
  deps: SynthesizeDeps,
  payload: TriggerPayload,
  agent: SynthesisAgent,
  signal: AbortSignal,
): Promise<OpeningContext> {
  const { entries, userText } = buildBaseEntries(payload, agent.systemPrompt);

  return withSpan(
    SpanName.TriggerSynthesize,
    { [Attr.AgentId]: agent.id, [Attr.TenantId]: agent.tenantId, [Attr.TriggerKind]: payload.kind },
    async (span) => {
      const memories = await tryRetrieveMemoryContext(deps, agent, userText, signal);

      if (memories.length === 0) {
        span.setAttribute(Attr.MemoryInjectedCount, 0);
        return { entries, userText };
      }

      const now = new Date(deps.clock.now());
      const { content, truncated } = formatMemoryPreamble(agent.systemPrompt, memories, now);

      if (truncated) {
        counter(
          "relay.memory.injection.skipped_total",
          "Times memory injection was skipped due to a soft failure.",
        ).add(1, { [Attr.MemoryInjectionSkipped]: "preamble_truncated" });
      }

      counter(
        "relay.memory.injection.injected_total",
        "Memories injected into an opening prompt. Sum across triggers.",
      ).add(memories.length);
      histogram(
        "relay.memory.injection.k",
        "Per-call distribution of injected memory count.",
        "memories",
      ).record(memories.length);
      span.setAttribute(Attr.MemoryInjectedCount, memories.length);

      return { entries: [{ role: "system", content }, entries[1]], userText };
    },
  );
}
