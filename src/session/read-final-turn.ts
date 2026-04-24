// Read the final completed turn for a session and join text blocks into a single string.
// Used by POST /trigger to build the synchronous HTTP response body.

import { z } from "zod";
import type { Sql } from "postgres";
import { err, ok, type Result } from "../core/result.ts";
import { firstRow } from "../db/utils.ts";
import type { SessionId } from "../ids.ts";
import type { ModelUsage, StopReason } from "./turn.ts";

export type ReadFinalTurnError =
  | { readonly kind: "no_turns"; readonly sessionId: SessionId }
  | { readonly kind: "invalid_turn_response"; readonly detail: string };

const ModelResponseSchema = z.object({
  content: z.array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({
        type: z.literal("tool_use"),
        id: z.string(),
        name: z.string(),
        input: z.unknown(),
      }),
      z.object({
        type: z.literal("tool_result"),
        toolUseId: z.string(),
        content: z.string(),
        isError: z.boolean().optional(),
      }),
    ]),
  ),
  stopReason: z.enum([
    "end_turn",
    "tool_use",
    "max_tokens",
    "stop_sequence",
    "pause_turn",
    "refusal",
  ]),
  usage: z.object({
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    cacheReadInputTokens: z.number().int().min(0).optional(),
    cacheCreationInputTokens: z.number().int().min(0).optional(),
  }),
});

export async function readFinalTurnResponse(
  sql: Sql,
  sessionId: SessionId,
): Promise<
  Result<{ text: string; stopReason: StopReason; usage: ModelUsage }, ReadFinalTurnError>
> {
  const rows = await sql<{ response: unknown }[]>`
    SELECT response FROM turns
    WHERE session_id = ${sessionId} AND response IS NOT NULL
    ORDER BY turn_index DESC
    LIMIT 1
  `;

  if (rows.length === 0) return err({ kind: "no_turns", sessionId });

  const row = firstRow(rows, "readFinalTurnResponse");
  const parsed = ModelResponseSchema.safeParse(row.response);
  if (!parsed.success) {
    return err({ kind: "invalid_turn_response", detail: parsed.error.message });
  }

  const response = parsed.data;
  const text = response.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");

  // Explicitly construct to satisfy exactOptionalPropertyTypes: omit keys whose value is undefined.
  const rawUsage = response.usage;
  const usage: ModelUsage = {
    inputTokens: rawUsage.inputTokens,
    outputTokens: rawUsage.outputTokens,
    ...(rawUsage.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: rawUsage.cacheReadInputTokens }
      : {}),
    ...(rawUsage.cacheCreationInputTokens !== undefined
      ? { cacheCreationInputTokens: rawUsage.cacheCreationInputTokens }
      : {}),
  };

  return ok({ text, stopReason: response.stopReason, usage });
}
