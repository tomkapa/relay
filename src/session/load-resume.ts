// Reload the transcript for a session being resumed via an inbound message (RELAY-143).
// RELAY-232 extends: full multi-cycle interleave — every prior inbound is bucketed by
// which turn it followed, ask replies are paired as tool_result blocks across all turns,
// and unrelated inbounds appear as plain user-text in chronological order.

import { z } from "zod";
import type { Sql } from "postgres";
import { assert } from "../core/assert.ts";
import { err, ok, type Result } from "../core/result.ts";
import { firstRow } from "../db/utils.ts";
import {
  TenantId,
  ToolUseId,
  type InboundMessageId,
  type SessionId,
  type TenantId as TenantIdBrand,
} from "../ids.ts";
import { MAX_INBOUNDS_REPLAYED_PER_RESUME } from "./limits.ts";
import type { ContentBlock, Message, ToolResultBlock } from "./turn.ts";
import { ModelResponseSchema, ToolResultBlockSchema } from "./turn-schema.ts";
import { Attr, SpanName, counter, withSpan } from "../telemetry/otel.ts";

const ToolResultsSchema = z.array(ToolResultBlockSchema);

export type ResumeInput = {
  readonly systemPrompt: string;
  readonly initialMessages: readonly Message[];
  readonly startTurnIndex: number;
};

export type ResumeInputError =
  | { readonly kind: "session_not_found"; readonly sessionId: SessionId }
  | {
      readonly kind: "tenant_mismatch";
      readonly expected: TenantIdBrand;
      readonly got: TenantIdBrand;
    };

type SessionRow = {
  readonly tenant_id: string;
  readonly opening_user_content: string;
};
type TurnRow = {
  readonly turn_index: number;
  readonly started_at: Date;
  readonly completed_at: Date | null;
  readonly response: unknown;
  readonly tool_results: unknown;
};
type InboundRow = {
  readonly id: string;
  readonly received_at: Date;
  readonly content: string;
  readonly source_tool_use_id: string | null;
};

type DecodedTurn = {
  readonly turnIndex: number;
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly response: ReturnType<(typeof ModelResponseSchema)["parse"]>;
  readonly toolResults: ReturnType<(typeof ToolResultsSchema)["parse"]>;
};
type InboundParsed = {
  readonly id: string;
  readonly receivedAt: Date;
  readonly content: string;
  readonly sourceToolUseId: ToolUseId | null;
};
// Unbranded tool_use block as it comes out of ModelResponseSchema.
type ToolUseShape = { type: "tool_use"; id: string; name: string; input: unknown };

function decodeTurns(rows: readonly TurnRow[]): readonly DecodedTurn[] {
  const decoded: DecodedTurn[] = [];
  let expectedIndex = 0;
  for (const row of rows) {
    assert(row.turn_index === expectedIndex, "loadResumeInput: turns gap or duplicate", {
      expected: expectedIndex,
      got: row.turn_index,
    });
    expectedIndex++;
    assert(row.completed_at !== null, "loadResumeInput: completed_at is null for completed turn", {
      turn_index: row.turn_index,
    });
    assert(row.completed_at >= row.started_at, "loadResumeInput: completed_at < started_at", {
      turn_index: row.turn_index,
    });
    if (decoded.length > 0) {
      const prev = decoded[decoded.length - 1];
      assert(prev !== undefined, "loadResumeInput: decoded turns state invariant");
      assert(
        row.started_at >= prev.completedAt,
        "loadResumeInput: clock skew — turn.started_at < prev.completed_at",
        { turn_index: row.turn_index },
      );
    }
    const resp = ModelResponseSchema.safeParse(row.response);
    assert(resp.success, "loadResumeInput: malformed turn.response from DB", {
      detail: resp.error?.message,
    });
    const tools = ToolResultsSchema.safeParse(row.tool_results);
    assert(tools.success, "loadResumeInput: malformed turn.tool_results from DB", {
      detail: tools.error?.message,
    });
    decoded.push({
      turnIndex: row.turn_index,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      response: resp.data,
      toolResults: tools.data,
    });
  }
  return decoded;
}

function parseInboundRows(rows: readonly InboundRow[]): readonly InboundParsed[] {
  return rows.map((row) => {
    let sourceToolUseId: ToolUseId | null = null;
    if (row.source_tool_use_id !== null) {
      const parsed = ToolUseId.parse(row.source_tool_use_id);
      assert(parsed.ok, "loadResumeInput: invalid source_tool_use_id from DB", {
        id: row.source_tool_use_id,
      });
      sourceToolUseId = parsed.value;
    }
    return { id: row.id, receivedAt: row.received_at, content: row.content, sourceToolUseId };
  });
}

// processTurnToolUses — builds the tool_result message for one turn.
// Walks tool_use blocks in order: stored results first, then bucket-paired inbound replies,
// then <no reply yet> synthetics for any remaining unanswered asks.
function processTurnToolUses(
  toolUses: readonly ToolUseShape[],
  storedMap: ReadonlyMap<string, ToolResultBlock>,
  bucket: readonly InboundParsed[],
  pairedInboundIds: Set<string>,
): { blocks: ToolResultBlock[]; synthCount: number } {
  const blocks: ToolResultBlock[] = [];
  let synthCount = 0;
  for (const toolUse of toolUses) {
    if (storedMap.has(toolUse.id)) {
      const stored = storedMap.get(toolUse.id);
      assert(stored !== undefined, "processTurnToolUses: stored tool result undefined");
      blocks.push(stored);
    } else {
      const idResult = ToolUseId.parse(toolUse.id);
      assert(idResult.ok, "processTurnToolUses: invalid tool_use id from DB", { id: toolUse.id });
      const toolUseId = idResult.value;
      const match = bucket.find(
        (inb) => inb.sourceToolUseId === toolUseId && !pairedInboundIds.has(inb.id),
      );
      if (match !== undefined) {
        pairedInboundIds.add(match.id);
        blocks.push({ type: "tool_result", toolUseId, content: match.content });
      } else {
        synthCount++;
        blocks.push({ type: "tool_result", toolUseId, content: "<no reply yet>" });
      }
    }
  }
  return { blocks, synthCount };
}

// buildTranscript — pure reconstruction of the full message array.
// Implements the bucketing algorithm from RELAY-232 §Reconstruction algorithm.
function buildTranscript(
  openingUserContent: string,
  turns: readonly DecodedTurn[],
  inbounds: readonly InboundParsed[],
): { messages: readonly Message[]; synthNoReplyCount: number } {
  const N = turns.length;
  // buckets[0] = pre-turn-0; buckets[i+1] = inbounds after turn[i] completes.
  const buckets: InboundParsed[][] = Array.from({ length: N + 1 }, () => []);

  const firstTurn = turns[0]; // undefined when N=0
  for (const inbound of inbounds) {
    let slot = N; // default: after the last turn
    if (firstTurn !== undefined && inbound.receivedAt < firstTurn.startedAt) {
      slot = 0;
    } else {
      for (let i = 0; i < N - 1; i++) {
        const cur = turns[i];
        const next = turns[i + 1];
        assert(cur !== undefined, "buildTranscript: cur turn must exist");
        assert(next !== undefined, "buildTranscript: next turn must exist");
        if (inbound.receivedAt >= cur.completedAt && inbound.receivedAt < next.startedAt) {
          slot = i + 1;
          break;
        }
      }
    }
    const targetBucket = buckets[slot];
    assert(targetBucket !== undefined, "buildTranscript: bucket slot out of range", { slot });
    targetBucket.push(inbound);
  }

  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: openingUserContent }] },
  ];
  const preTurnBucket = buckets[0];
  assert(preTurnBucket !== undefined, "buildTranscript: buckets[0] must exist");
  for (const inbound of preTurnBucket) {
    messages.push({ role: "user", content: [{ type: "text", text: inbound.content }] });
  }

  let synthNoReplyCount = 0;
  for (let i = 0; i < N; i++) {
    const turn = turns[i];
    const turnBucket = buckets[i + 1];
    assert(
      turn !== undefined && turnBucket !== undefined,
      "buildTranscript: turn/bucket invariant",
    );
    const pairedInboundIds = new Set<string>();

    messages.push({ role: "assistant", content: turn.response.content as readonly ContentBlock[] });

    const toolUses = turn.response.content.filter((b): b is ToolUseShape => b.type === "tool_use");
    if (toolUses.length > 0) {
      const storedMap = new Map(
        turn.toolResults.map((tr) => [tr.toolUseId, tr as ToolResultBlock]),
      );
      const { blocks, synthCount } = processTurnToolUses(
        toolUses,
        storedMap,
        turnBucket,
        pairedInboundIds,
      );
      synthNoReplyCount += synthCount;
      messages.push({ role: "user", content: blocks });
    }

    for (const inbound of turnBucket) {
      if (!pairedInboundIds.has(inbound.id)) {
        messages.push({ role: "user", content: [{ type: "text", text: inbound.content }] });
      }
    }
  }

  return { messages, synthNoReplyCount };
}

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

  return withSpan(
    SpanName.SessionLoadResume,
    { [Attr.SessionId]: params.sessionId },
    async (span) => {
      const [sessRows, turnRows, inboundRows] = await Promise.all([
        sql<SessionRow[]>`
          SELECT tenant_id, opening_user_content FROM sessions WHERE id = ${params.sessionId}
        `,
        sql<TurnRow[]>`
          SELECT turn_index, started_at, completed_at, response, tool_results
          FROM turns WHERE session_id = ${params.sessionId} ORDER BY turn_index ASC
        `,
        sql<InboundRow[]>`
          SELECT id, received_at, content, source_tool_use_id
          FROM inbound_messages WHERE target_session_id = ${params.sessionId}
          ORDER BY received_at ASC, id ASC
        `,
      ]);

      if (sessRows.length === 0) {
        return err({ kind: "session_not_found", sessionId: params.sessionId });
      }
      const sess = firstRow(sessRows, "loadResumeInput.session");

      const tenantParsed = TenantId.parse(sess.tenant_id);
      assert(tenantParsed.ok, "loadResumeInput: invalid tenant_id from DB", {
        tenant_id: sess.tenant_id,
      });
      if (tenantParsed.value !== params.tenantId) {
        return err({
          kind: "tenant_mismatch",
          expected: params.tenantId,
          got: tenantParsed.value,
        });
      }

      assert(
        inboundRows.length <= MAX_INBOUNDS_REPLAYED_PER_RESUME,
        "loadResumeInput: inbound replay cap exceeded — runaway session",
        { count: inboundRows.length, cap: MAX_INBOUNDS_REPLAYED_PER_RESUME },
      );

      const lastInbound = inboundRows[inboundRows.length - 1];
      assert(lastInbound !== undefined, "loadResumeInput: no inbound rows found for session");
      assert(
        lastInbound.content === params.inboundContent,
        "loadResumeInput: inboundContent mismatch with last inbound_messages row",
        { expected: params.inboundContent },
      );

      const turns = decodeTurns(turnRows);
      const inboundParsed = parseInboundRows(inboundRows);

      span.setAttribute(Attr.InboundsReplayed, inboundParsed.length);

      const { messages, synthNoReplyCount } = buildTranscript(
        sess.opening_user_content,
        turns,
        inboundParsed,
      );

      span.setAttribute(Attr.UnansweredToolUses, synthNoReplyCount);

      if (synthNoReplyCount > 0) {
        counter(
          "relay.session.resume_with_synth_no_reply_total",
          "No-reply-yet synthetics injected on multi-cycle resume",
        ).add(synthNoReplyCount, { reason: "ask_unmatched" });
      }

      return ok({
        systemPrompt: params.agentSystemPrompt,
        initialMessages: messages,
        startTurnIndex: turns.length,
      });
    },
  );
}
