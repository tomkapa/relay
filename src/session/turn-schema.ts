// Shared Zod schemas for parsing turn rows read back from the DB.
// Used by read-final-turn.ts and load-resume.ts to avoid schema duplication.

import { z } from "zod";

export const ModelResponseSchema = z.object({
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

export const ToolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  toolUseId: z.string(),
  content: z.string(),
  isError: z.boolean().optional(),
});
