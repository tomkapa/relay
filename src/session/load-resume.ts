// Reload the transcript for a session that is being resumed via an inbound message (RELAY-143).
// Single-resume only: reads opening_user_content + completed turns + the current inbound.
// Multi-resume (interleaving prior inbound rows with turns) is RELAY-232.

import { z } from "zod";
import type { Sql } from "postgres";
import { assert } from "../core/assert.ts";
import { err, ok, type Result } from "../core/result.ts";
import { firstRow } from "../db/utils.ts";
import { TenantId, type SessionId, type TenantId as TenantIdBrand } from "../ids.ts";
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

export async function loadResumeInput(
  sql: Sql,
  params: {
    readonly sessionId: SessionId;
    readonly tenantId: TenantIdBrand;
    readonly agentSystemPrompt: string;
    readonly inboundContent: string;
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

  let expectedIndex = 0;
  for (const row of turnRows) {
    assert(row.turn_index === expectedIndex, "loadResumeInput: turns gap or duplicate", {
      expected: expectedIndex,
      got: row.turn_index,
    });
    expectedIndex++;

    const respParsed = ModelResponseSchema.safeParse(row.response);
    assert(respParsed.success, "loadResumeInput: malformed turn.response from DB", {
      detail: respParsed.error?.message,
    });

    const toolsParsed = ToolResultsSchema.safeParse(row.tool_results);
    assert(toolsParsed.success, "loadResumeInput: malformed turn.tool_results from DB", {
      detail: toolsParsed.error?.message,
    });

    // Single boundary cast after Zod validation — brands are TypeScript fictions, shapes match.
    messages.push({
      role: "assistant",
      content: respParsed.data.content as readonly ContentBlock[],
    });
    if (toolsParsed.data.length > 0) {
      messages.push({ role: "user", content: toolsParsed.data as ToolResultBlock[] });
    }
  }

  messages.push({ role: "user", content: [{ type: "text", text: params.inboundContent }] });

  return ok({
    systemPrompt: params.agentSystemPrompt,
    initialMessages: messages,
    startTurnIndex: turnRows.length,
  });
}
