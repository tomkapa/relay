// Reload the transcript for a session that is being resumed via an inbound message (RELAY-143).
// RELAY-144 extends: when the last turn has unanswered ask tool_uses, builds tool_result blocks
// instead of plain-text wrapping. Multi-resume interleaving (RELAY-232) is not implemented here.

import { z } from "zod";
import type { Sql } from "postgres";
import { assert } from "../core/assert.ts";
import { err, ok, type Result } from "../core/result.ts";
import { firstRow } from "../db/utils.ts";
import {
  TenantId,
  type InboundMessageId,
  type SessionId,
  type TenantId as TenantIdBrand,
  type ToolUseId,
} from "../ids.ts";
import type { ContentBlock, Message, ToolResultBlock } from "./turn.ts";
import { ModelResponseSchema, ToolResultBlockSchema } from "./turn-schema.ts";

const ToolResultsSchema = z.array(ToolResultBlockSchema);

export type ResumeInput = {
  readonly systemPrompt: string;
  readonly initialMessages: readonly Message[];
  readonly startTurnIndex: number; // first turn_index runTurnLoop should write
};

export type ResumeInputError =
  | { readonly kind: "session_not_found"; readonly sessionId: SessionId }
  | {
      readonly kind: "tenant_mismatch";
      readonly expected: TenantIdBrand;
      readonly got: TenantIdBrand;
    };

type SessionRow = { readonly tenant_id: string; readonly opening_user_content: string };
type TurnRow = {
  readonly turn_index: number;
  readonly response: unknown;
  readonly tool_results: unknown;
};
type InboundAskRow = {
  readonly source_tool_use_id: string;
  readonly content: string;
};

export async function loadResumeInput(
  sql: Sql,
  params: {
    readonly sessionId: SessionId;
    readonly tenantId: TenantIdBrand;
    readonly agentSystemPrompt: string;
    readonly inboundContent: string;
    readonly inboundMessageId: InboundMessageId;
    readonly sourceToolUseId: ToolUseId | null;
  },
): Promise<Result<ResumeInput, ResumeInputError>> {
  assert(
    params.agentSystemPrompt.length > 0,
    "loadResumeInput: agentSystemPrompt must be non-empty",
  );
  assert(params.inboundContent.length > 0, "loadResumeInput: inboundContent must be non-empty");

  const sessRows = await sql<SessionRow[]>`
    SELECT tenant_id, opening_user_content FROM sessions WHERE id = ${params.sessionId}
  `;
  if (sessRows.length === 0) {
    return err({ kind: "session_not_found", sessionId: params.sessionId });
  }
  const sess = firstRow(sessRows, "loadResumeInput.session");

  const tenantParsed = TenantId.parse(sess.tenant_id);
  assert(tenantParsed.ok, "loadResumeInput: invalid tenant_id from DB", {
    tenant_id: sess.tenant_id,
  });
  if (tenantParsed.value !== params.tenantId) {
    return err({ kind: "tenant_mismatch", expected: params.tenantId, got: tenantParsed.value });
  }

  const turnRows = await sql<TurnRow[]>`
    SELECT turn_index, response, tool_results
    FROM turns
    WHERE session_id = ${params.sessionId}
    ORDER BY turn_index ASC
  `;

  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: sess.opening_user_content }] },
  ];

  // Cache parsed results from the last iteration — reused in the ask-resume path below.
  type ParsedTurnData = {
    resp: ReturnType<(typeof ModelResponseSchema)["parse"]>;
    tools: ReturnType<(typeof ToolResultsSchema)["parse"]>;
  };
  let lastParsed: ParsedTurnData | null = null;

  let expectedIndex = 0;
  for (const row of turnRows) {
    assert(row.turn_index === expectedIndex, "loadResumeInput: turns gap or duplicate", {
      expected: expectedIndex,
      got: row.turn_index,
    });
    expectedIndex++;

    const resp = ModelResponseSchema.safeParse(row.response);
    assert(resp.success, "loadResumeInput: malformed turn.response from DB", {
      detail: resp.error?.message,
    });

    const tools = ToolResultsSchema.safeParse(row.tool_results);
    assert(tools.success, "loadResumeInput: malformed turn.tool_results from DB", {
      detail: tools.error?.message,
    });

    lastParsed = { resp: resp.data, tools: tools.data };

    // Single boundary cast after Zod validation — brands are TypeScript fictions, shapes match.
    messages.push({
      role: "assistant",
      content: resp.data.content as readonly ContentBlock[],
    });
    if (tools.data.length > 0) {
      messages.push({ role: "user", content: tools.data as ToolResultBlock[] });
    }
  }

  // Only attempt ask-resume path when sourceToolUseId is non-null (caller flagged it as ask-reply)
  // and there is at least one prior turn (the suspended one).
  if (params.sourceToolUseId !== null && lastParsed !== null) {
    type ToolUseShape = { type: "tool_use"; id: string; name: string; input: unknown };
    const lastToolUses = lastParsed.resp.content.filter(
      (b): b is ToolUseShape => b.type === "tool_use",
    );

    if (lastToolUses.length > 0) {
      const pairedIds = new Set(lastParsed.tools.map((tr) => tr.toolUseId));
      const unansweredIds = lastToolUses.map((b) => b.id).filter((id) => !pairedIds.has(id));

      if (unansweredIds.length > 0) {
        const inboundRows = await sql<InboundAskRow[]>`
          SELECT source_tool_use_id, content
          FROM inbound_messages
          WHERE target_session_id = ${params.sessionId}
            AND source_tool_use_id IS NOT NULL
            AND source_tool_use_id = ANY(${unansweredIds})
        `;
        const inboundMap = new Map<string, string>(
          inboundRows.map((r) => [r.source_tool_use_id, r.content]),
        );

        const toolResultBlocks: ToolResultBlock[] = [];
        for (const toolUse of lastToolUses) {
          if (pairedIds.has(toolUse.id)) {
            const stored = lastParsed.tools.find((tr) => tr.toolUseId === toolUse.id);
            assert(stored !== undefined, "loadResumeInput: paired tool result must exist");
            toolResultBlocks.push(stored as ToolResultBlock);
          } else {
            const replyContent = inboundMap.get(toolUse.id);
            toolResultBlocks.push({
              type: "tool_result",
              toolUseId: toolUse.id as ToolUseId,
              content: replyContent ?? "<no reply yet>",
            });
          }
        }

        // The suspended turn has no tool_results persisted; the last message pushed was the
        // assistant message. Append the newly built tool_result user message for the ask slots.
        messages.push({ role: "user", content: toolResultBlocks });

        // If the triggering inbound is not itself an ask-reply, append it as plain user-text.
        if (!inboundMap.has(params.sourceToolUseId)) {
          messages.push({ role: "user", content: [{ type: "text", text: params.inboundContent }] });
        }

        return ok({
          systemPrompt: params.agentSystemPrompt,
          initialMessages: messages,
          startTurnIndex: turnRows.length,
        });
      }
    }
  }

  // Fresh inbound path: append as plain user-text message.
  messages.push({ role: "user", content: [{ type: "text", text: params.inboundContent }] });

  return ok({
    systemPrompt: params.agentSystemPrompt,
    initialMessages: messages,
    startTurnIndex: turnRows.length,
  });
}
