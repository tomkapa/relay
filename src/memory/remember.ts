import type { Sql } from "postgres";
import { assert } from "../core/assert.ts";
import { idempotencyKey } from "../core/idempotency.ts";
import { err, ok, type Result } from "../core/result.ts";
import { Importance } from "../ids.ts";
import type { ToolDefinition } from "../session/tools-inmemory.ts";
import type { ToolInvocationContext, ToolResult } from "../session/tools.ts";
import { Attr, counter } from "../telemetry/otel.ts";
import type { EmbedError, EmbeddingClient } from "./embedding.ts";
import { WRITER as MEMORY_WRITER, insertMemory } from "./insert.ts";
import type { MemoryRow } from "./insert.ts";
import { MemoryKind } from "./kind.ts";
import { DEFAULT_IMPORTANCE, MAX_ENTRY_TEXT_BYTES } from "./limits.ts";

export const REMEMBER_TOOL_NAME = "remember";

export type RememberToolError =
  | {
      readonly kind: "input_invalid";
      readonly field: "text" | "importance";
      readonly reason: string;
    }
  | { readonly kind: "text_too_long"; readonly bytes: number; readonly max: number }
  | { readonly kind: "embed_transient"; readonly message: string }
  | { readonly kind: "embed_permanent"; readonly message: string }
  | { readonly kind: "embed_timeout"; readonly elapsedMs: number };

const kindResult = MemoryKind.parse("event");
assert(kindResult.ok, "remember: MemoryKind.parse('event') failed at module load");
const EVENT_KIND = kindResult.value;

const importanceResult = Importance.parse(DEFAULT_IMPORTANCE);
assert(importanceResult.ok, "remember: DEFAULT_IMPORTANCE is out of [0,1] at module load");
const PARSED_DEFAULT_IMPORTANCE = importanceResult.value;

const REMEMBER_INPUT_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string", description: "The memory text to store." },
    importance: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "Optional importance weight in [0,1]; default 0.5.",
    },
  },
  required: ["text"],
  additionalProperties: false,
} as const;

type ParsedRememberInput = { readonly text: string; readonly importance: Importance };

export function parseRememberInput(
  raw: Readonly<Record<string, unknown>>,
): Result<ParsedRememberInput, RememberToolError> {
  const text = raw["text"];
  if (typeof text !== "string" || text.length === 0) {
    return err({ kind: "input_invalid", field: "text", reason: "must be a non-empty string" });
  }

  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_ENTRY_TEXT_BYTES) {
    return err({ kind: "text_too_long", bytes, max: MAX_ENTRY_TEXT_BYTES });
  }

  const rawImportance = raw["importance"];
  if (rawImportance === undefined) {
    return ok({ text, importance: PARSED_DEFAULT_IMPORTANCE });
  }

  if (typeof rawImportance !== "number") {
    return err({
      kind: "input_invalid",
      field: "importance",
      reason: "must be a number in [0, 1]",
    });
  }

  const importanceResult = Importance.parse(rawImportance);
  if (!importanceResult.ok) {
    return err({
      kind: "input_invalid",
      field: "importance",
      reason: `must be a finite number in [0, 1]; got ${String(rawImportance)}`,
    });
  }

  return ok({ text, importance: importanceResult.value });
}

function mapEmbedError(e: EmbedError): RememberToolError {
  switch (e.kind) {
    case "transient":
      return { kind: "embed_transient", message: e.message };
    case "permanent":
      return { kind: "embed_permanent", message: e.message };
    case "timeout":
      return { kind: "embed_timeout", elapsedMs: e.elapsedMs };
    case "input_too_long":
      // Pre-checked by parseRememberInput; arriving here means byte limits diverged — programmer bug.
      assert(false, "remember: embed reported input_too_long after parser check", {
        bytes: e.bytes,
        max: e.max,
      });
  }
}

function rememberErrorMessage(e: RememberToolError): string {
  switch (e.kind) {
    case "input_invalid":
      return `${e.field}: ${e.reason}`;
    case "text_too_long":
      return `text is ${String(e.bytes)} bytes; max is ${String(e.max)}. Shorten and retry.`;
    case "embed_transient":
      return `embedding service temporarily unavailable; please retry. (${e.message})`;
    case "embed_permanent":
      return `embedding service rejected input. (${e.message})`;
    case "embed_timeout":
      return `embedding timed out after ${String(e.elapsedMs)} ms`;
  }
}

function toToolResult(r: Result<MemoryRow, RememberToolError>): ToolResult {
  if (r.ok) {
    return { ok: true, content: JSON.stringify({ memoryId: r.value.id, kind: r.value.kind }) };
  }
  return { ok: false, errorMessage: `remember: ${rememberErrorMessage(r.error)}` };
}

function outcomeOf(r: Result<MemoryRow, RememberToolError>): string {
  if (r.ok) return "written";
  return r.error.kind;
}

async function runRemember(
  deps: { readonly sql: Sql; readonly embedding: EmbeddingClient },
  input: Readonly<Record<string, unknown>>,
  ctx: ToolInvocationContext,
  signal: AbortSignal,
): Promise<Result<MemoryRow, RememberToolError>> {
  assert(ctx.toolUseId.length > 0, "remember: toolUseId must be non-empty");
  assert(ctx.sessionId.length > 0, "remember: sessionId must be non-empty");

  const parsed = parseRememberInput(input);
  if (!parsed.ok) return parsed;

  const embedResult = await deps.embedding.embed(parsed.value.text, signal);
  if (!embedResult.ok) return err(mapEmbedError(embedResult.error));

  const key = idempotencyKey({
    writer: MEMORY_WRITER,
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    toolCallId: ctx.toolUseId,
  });

  const insertResult = await deps.sql.begin((tx) =>
    insertMemory(tx, {
      agentId: ctx.agentId,
      tenantId: ctx.tenantId,
      kind: EVENT_KIND,
      text: parsed.value.text,
      embedding: embedResult.value,
      importance: parsed.value.importance,
      idempotencyKey: key,
    }),
  );

  if (!insertResult.ok) {
    // tenant_mismatch and agent_not_found are programmer errors here — the loop always
    // supplies the calling agent's own context. Crash so the lease expires loudly.
    assert(false, "remember: insertMemory returned unexpected error", {
      error: insertResult.error,
    });
  }

  return ok(insertResult.value);
}

export function makeRememberTool(deps: {
  readonly sql: Sql;
  readonly embedding: EmbeddingClient;
}): ToolDefinition {
  return {
    schema: {
      name: REMEMBER_TOOL_NAME,
      description:
        "Save a long-term memory the agent can recall in future sessions. Use sparingly for facts worth persisting.",
      inputSchema: REMEMBER_INPUT_SCHEMA,
    },
    invoke: async (input, ctx, signal) => {
      const result = await runRemember(deps, input, ctx, signal);
      counter(
        "relay.tool.remember.outcome_total",
        "remember(...) outcomes. relay.outcome ∈ {written, input_invalid, text_too_long, embed_transient, embed_permanent, embed_timeout}.",
      ).add(1, {
        [Attr.TenantId]: ctx.tenantId,
        [Attr.AgentId]: ctx.agentId,
        [Attr.Outcome]: outcomeOf(result),
      });
      return toToolResult(result);
    },
  };
}
