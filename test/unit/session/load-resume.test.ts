// Unit tests for loadResumeInput. Pure-function tests using a hand-rolled fake Sql.
// Integration-level correctness (real DB, real turns from runTurnLoop) is in
// test/integration/trigger/handlers.test.ts under "inbound_message — resume turn loop wiring".

import { describe, expect, test } from "bun:test";
import type { Sql } from "postgres";
import type { InboundMessageId, SessionId, TenantId } from "../../../src/ids.ts";
import { AssertionError } from "../../../src/core/assert.ts";
import { loadResumeInput } from "../../../src/session/load-resume.ts";

const SESS_ID = "11111111-1111-4111-a111-111111111111" as SessionId;
const TENANT_ID = "22222222-2222-4222-a222-222222222222" as TenantId;
const OTHER_TENANT = "33333333-3333-4333-a333-333333333333" as TenantId;
const INBOUND_ID = "44444444-4444-4444-a444-444444444444" as InboundMessageId;
const SYS_PROMPT = "You are a helpful assistant.";

type SqlCallSpec = {
  rows: unknown[];
};

function makeSql(
  sessionRows: SqlCallSpec,
  turnRows: SqlCallSpec,
  inboundRows: SqlCallSpec = { rows: [] },
): Sql {
  const fake = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const chunk = strings[0] ?? "";
    if (chunk.includes("inbound_messages")) return Promise.resolve(inboundRows.rows);
    if (chunk.includes("sessions")) return Promise.resolve(sessionRows.rows);
    return Promise.resolve(turnRows.rows);
  };
  Object.assign(fake, {
    json: (v: unknown) => v,
    begin: (fn: (tx: unknown) => Promise<unknown>) => fn(fake),
    unsafe: () => Promise.resolve([]),
  });
  return fake as unknown as Sql;
}

function sessRow(tenantId: string = TENANT_ID, openingContent = "Hello") {
  return { tenant_id: tenantId, opening_user_content: openingContent };
}

function turnRow(turnIndex: number, responseText: string, toolResults: unknown[] = []): unknown {
  return {
    turn_index: turnIndex,
    response: {
      content: [{ type: "text", text: responseText }],
      stopReason: "end_turn",
      usage: { inputTokens: 5, outputTokens: 3 },
    },
    tool_results: toolResults,
  };
}

describe("loadResumeInput — no prior turns", () => {
  test("session with no turns: 2 messages — opening user + inbound", async () => {
    const sql = makeSql({ rows: [sessRow()] }, { rows: [] });
    const result = await loadResumeInput(sql, {
      sessionId: SESS_ID,
      tenantId: TENANT_ID,
      agentSystemPrompt: SYS_PROMPT,
      inboundContent: "Reply",
      inboundMessageId: INBOUND_ID,
      sourceToolUseId: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const msgs = result.value.initialMessages;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.role).toBe("user");
    const first = msgs[0]?.content[0];
    expect(first?.type === "text" && first.text).toBe("Hello");
    expect(msgs[1]?.role).toBe("user");
    const last = msgs[1]?.content[0];
    expect(last?.type === "text" && last.text).toBe("Reply");
    expect(result.value.startTurnIndex).toBe(0);
  });

  test("systemPrompt in result comes from params", async () => {
    const sql = makeSql({ rows: [sessRow()] }, { rows: [] });
    const result = await loadResumeInput(sql, {
      sessionId: SESS_ID,
      tenantId: TENANT_ID,
      agentSystemPrompt: SYS_PROMPT,
      inboundContent: "Hi",
      inboundMessageId: INBOUND_ID,
      sourceToolUseId: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.systemPrompt).toBe(SYS_PROMPT);
  });
});

describe("loadResumeInput — with prior turns (no tool results)", () => {
  test("one assistant turn: 3 messages — opening, assistant, inbound", async () => {
    const sql = makeSql({ rows: [sessRow()] }, { rows: [turnRow(0, "First reply")] });
    const result = await loadResumeInput(sql, {
      sessionId: SESS_ID,
      tenantId: TENANT_ID,
      agentSystemPrompt: SYS_PROMPT,
      inboundContent: "Follow-up",
      inboundMessageId: INBOUND_ID,
      sourceToolUseId: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const msgs = result.value.initialMessages;
    expect(msgs).toHaveLength(3);
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[1]?.role).toBe("assistant");
    expect(msgs[2]?.role).toBe("user");
    const last = msgs[2]?.content[0];
    expect(last?.type === "text" && last.text).toBe("Follow-up");
    expect(result.value.startTurnIndex).toBe(1);
  });

  test("two turns: 4 messages — opening, assistant, assistant, inbound", async () => {
    const sql = makeSql(
      { rows: [sessRow()] },
      { rows: [turnRow(0, "Reply 0"), turnRow(1, "Reply 1")] },
    );
    const result = await loadResumeInput(sql, {
      sessionId: SESS_ID,
      tenantId: TENANT_ID,
      agentSystemPrompt: SYS_PROMPT,
      inboundContent: "Follow-up",
      inboundMessageId: INBOUND_ID,
      sourceToolUseId: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const msgs = result.value.initialMessages;
    expect(msgs).toHaveLength(4);
  });
});

describe("loadResumeInput — with tool results", () => {
  test("turn with tool_results: 4 messages — opening, assistant, user(tool_results), inbound", async () => {
    const toolResult = {
      type: "tool_result",
      toolUseId: "toolu_01",
      content: "42",
      isError: false,
    };
    const sql = makeSql(
      { rows: [sessRow()] },
      { rows: [turnRow(0, "tool_use response", [toolResult])] },
    );
    const result = await loadResumeInput(sql, {
      sessionId: SESS_ID,
      tenantId: TENANT_ID,
      agentSystemPrompt: SYS_PROMPT,
      inboundContent: "Next question",
      inboundMessageId: INBOUND_ID,
      sourceToolUseId: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const msgs = result.value.initialMessages;
    expect(msgs).toHaveLength(4);
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[1]?.role).toBe("assistant");
    expect(msgs[2]?.role).toBe("user");
    expect(msgs[3]?.role).toBe("user");
    const toolBlock = msgs[2]?.content[0];
    expect(toolBlock?.type).toBe("tool_result");
  });
});

describe("loadResumeInput — error cases", () => {
  test("session not found: returns session_not_found error", async () => {
    const sql = makeSql({ rows: [] }, { rows: [] });
    const result = await loadResumeInput(sql, {
      sessionId: SESS_ID,
      tenantId: TENANT_ID,
      agentSystemPrompt: SYS_PROMPT,
      inboundContent: "Hi",
      inboundMessageId: INBOUND_ID,
      sourceToolUseId: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("session_not_found");
  });

  test("tenant mismatch: returns tenant_mismatch error", async () => {
    const sql = makeSql({ rows: [sessRow(OTHER_TENANT)] }, { rows: [] });
    const result = await loadResumeInput(sql, {
      sessionId: SESS_ID,
      tenantId: TENANT_ID,
      agentSystemPrompt: SYS_PROMPT,
      inboundContent: "Hi",
      inboundMessageId: INBOUND_ID,
      sourceToolUseId: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("tenant_mismatch");
  });

  test("turns out of order: throws AssertionError", () => {
    const sql = makeSql({ rows: [sessRow()] }, { rows: [turnRow(1, "Wrong index")] });
    expect(
      loadResumeInput(sql, {
        sessionId: SESS_ID,
        tenantId: TENANT_ID,
        agentSystemPrompt: SYS_PROMPT,
        inboundContent: "Hi",
        inboundMessageId: INBOUND_ID,
        sourceToolUseId: null,
      }),
    ).rejects.toThrow(AssertionError);
  });

  test("malformed response JSON: throws AssertionError", () => {
    const sql = makeSql(
      { rows: [sessRow()] },
      {
        rows: [
          {
            turn_index: 0,
            response: { invalid: "shape" },
            tool_results: [],
          },
        ],
      },
    );
    expect(
      loadResumeInput(sql, {
        sessionId: SESS_ID,
        tenantId: TENANT_ID,
        agentSystemPrompt: SYS_PROMPT,
        inboundContent: "Hi",
        inboundMessageId: INBOUND_ID,
        sourceToolUseId: null,
      }),
    ).rejects.toThrow(AssertionError);
  });
});

describe("loadResumeInput — precondition assertions", () => {
  test("empty agentSystemPrompt throws AssertionError", () => {
    const sql = makeSql({ rows: [] }, { rows: [] });
    expect(
      loadResumeInput(sql, {
        sessionId: SESS_ID,
        tenantId: TENANT_ID,
        agentSystemPrompt: "",
        inboundContent: "Hi",
        inboundMessageId: INBOUND_ID,
        sourceToolUseId: null,
      }),
    ).rejects.toThrow(AssertionError);
  });

  test("empty inboundContent throws AssertionError", () => {
    const sql = makeSql({ rows: [] }, { rows: [] });
    expect(
      loadResumeInput(sql, {
        sessionId: SESS_ID,
        tenantId: TENANT_ID,
        agentSystemPrompt: SYS_PROMPT,
        inboundContent: "",
        inboundMessageId: INBOUND_ID,
        sourceToolUseId: null,
      }),
    ).rejects.toThrow(AssertionError);
  });
});

describe("loadResumeInput — ask-resume path", () => {
  const ASK_TOOL_USE_ID = "toolu_ask_01";

  function askTurnRow(toolUseId: string): unknown {
    return {
      turn_index: 0,
      response: {
        content: [{ type: "tool_use", id: toolUseId, name: "ask", input: {} }],
        stopReason: "tool_use",
        usage: { inputTokens: 5, outputTokens: 3 },
      },
      // Suspended turn has empty tool_results (ask slot not yet filled).
      tool_results: [],
    };
  }

  test("single ask, single reply: tool_result with inbound content", async () => {
    const inboundRow = { source_tool_use_id: ASK_TOOL_USE_ID, content: "approved" };
    const sql = makeSql(
      { rows: [sessRow()] },
      { rows: [askTurnRow(ASK_TOOL_USE_ID)] },
      { rows: [inboundRow] },
    );

    // Import ToolUseId to cast
    const { ToolUseId } = await import("../../../src/ids.ts");
    const toolUseIdResult = ToolUseId.parse(ASK_TOOL_USE_ID);
    expect(toolUseIdResult.ok).toBe(true);
    if (!toolUseIdResult.ok) return;

    const result = await loadResumeInput(sql, {
      sessionId: SESS_ID,
      tenantId: TENANT_ID,
      agentSystemPrompt: SYS_PROMPT,
      inboundContent: "approved",
      inboundMessageId: INBOUND_ID,
      sourceToolUseId: toolUseIdResult.value,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const msgs = result.value.initialMessages;
    // opening_user + assistant (ask turn) + user (tool_result for ask)
    expect(msgs).toHaveLength(3);
    expect(msgs[2]?.role).toBe("user");
    const block = msgs[2]?.content[0];
    expect(block?.type).toBe("tool_result");
    if (block?.type !== "tool_result") return;
    expect(block.content).toBe("approved");
    expect(block.toolUseId as string).toBe(ASK_TOOL_USE_ID);
    expect(result.value.startTurnIndex).toBe(1);
  });

  test("multi-ask partial reply: unanswered ask gets <no reply yet>, answered ask gets reply", async () => {
    const ASK_TOOL_USE_ID_B = "toolu_ask_01";
    const ASK_TOOL_USE_ID_C = "toolu_ask_02";

    const { ToolUseId } = await import("../../../src/ids.ts");
    const toolUseIdResultB = ToolUseId.parse(ASK_TOOL_USE_ID_B);
    expect(toolUseIdResultB.ok).toBe(true);
    if (!toolUseIdResultB.ok) return;

    // Turn has two ask tool_uses; B replied, C did not
    const twoAskTurnRow: unknown = {
      turn_index: 0,
      response: {
        content: [
          { type: "tool_use", id: ASK_TOOL_USE_ID_B, name: "ask", input: {} },
          { type: "tool_use", id: ASK_TOOL_USE_ID_C, name: "ask", input: {} },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 5, outputTokens: 3 },
      },
      tool_results: [],
    };
    // Only B's inbound row exists in DB
    const inboundRow = { source_tool_use_id: ASK_TOOL_USE_ID_B, content: "B replied" };
    const sql = makeSql({ rows: [sessRow()] }, { rows: [twoAskTurnRow] }, { rows: [inboundRow] });

    const result = await loadResumeInput(sql, {
      sessionId: SESS_ID,
      tenantId: TENANT_ID,
      agentSystemPrompt: SYS_PROMPT,
      inboundContent: "B replied",
      inboundMessageId: INBOUND_ID,
      sourceToolUseId: toolUseIdResultB.value,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const msgs = result.value.initialMessages;
    // opening_user + assistant + user(2 tool_results)
    expect(msgs).toHaveLength(3);
    const toolResultMsg = msgs[2];
    expect(toolResultMsg?.role).toBe("user");
    expect(toolResultMsg?.content).toHaveLength(2);
    const blockB = toolResultMsg?.content[0];
    const blockC = toolResultMsg?.content[1];
    expect(blockB?.type).toBe("tool_result");
    if (blockB?.type !== "tool_result") return;
    expect(blockB.content).toBe("B replied");
    expect(blockB.toolUseId as string).toBe(ASK_TOOL_USE_ID_B);
    expect(blockC?.type).toBe("tool_result");
    if (blockC?.type !== "tool_result") return;
    expect(blockC.content).toBe("<no reply yet>");
    expect(blockC.toolUseId as string).toBe(ASK_TOOL_USE_ID_C);
  });

  test("sourceToolUseId null on session with ask turn: falls back to plain-text wrapping", async () => {
    const sql = makeSql(
      { rows: [sessRow()] },
      { rows: [askTurnRow(ASK_TOOL_USE_ID)] },
      { rows: [] },
    );

    const result = await loadResumeInput(sql, {
      sessionId: SESS_ID,
      tenantId: TENANT_ID,
      agentSystemPrompt: SYS_PROMPT,
      inboundContent: "fresh message",
      inboundMessageId: INBOUND_ID,
      sourceToolUseId: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // sourceToolUseId is null → falls back to plain-text wrapping (existing behavior)
    const msgs = result.value.initialMessages;
    const last = msgs[msgs.length - 1];
    expect(last?.role).toBe("user");
    const block = last?.content[0];
    expect(block?.type).toBe("text");
    if (block?.type !== "text") return;
    expect(block.text).toBe("fresh message");
  });
});
