// Unit tests for loadResumeInput. Pure-function tests using a hand-rolled fake Sql.
// Integration-level correctness (real DB, real turns from runTurnLoop) is in
// test/integration/trigger/handlers.test.ts under "inbound_message — resume turn loop wiring".
// Multi-cycle integration tests are in test/integration/session/load-resume.multi-cycle.test.ts.

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { InboundMessageId, SessionId, TenantId } from "../../../src/ids.ts";
import { AssertionError } from "../../../src/core/assert.ts";
import { loadResumeInput } from "../../../src/session/load-resume.ts";
import { MAX_INBOUNDS_REPLAYED_PER_RESUME } from "../../../src/session/limits.ts";

const SESS_ID = "11111111-1111-4111-a111-111111111111" as SessionId;
const TENANT_ID = "22222222-2222-4222-a222-222222222222" as TenantId;
const OTHER_TENANT = "33333333-3333-4333-a333-333333333333" as TenantId;
const INBOUND_ID = "44444444-4444-4444-a444-444444444444" as InboundMessageId;
const SYS_PROMPT = "You are a helpful assistant.";

// Stable epoch timestamps used across fixtures — ms values encode the intent clearly.
const T0 = new Date(0); // session.created_at
const T1 = new Date(1_000); // turn[0].started_at
const T2 = new Date(2_000); // turn[0].completed_at
const T3 = new Date(3_000); // turn[1].started_at
const T4 = new Date(4_000); // turn[1].completed_at
const T7 = new Date(7_000); // inbound after last turn

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
  return { tenant_id: tenantId, opening_user_content: openingContent, created_at: T0 };
}

// Turn row with timestamps. Default timestamps assume a single-turn session.
function turnRow(
  turnIndex: number,
  responseText: string,
  toolResults: unknown[] = [],
  startedAt: Date = T1,
  completedAt: Date = T2,
): unknown {
  return {
    turn_index: turnIndex,
    started_at: startedAt,
    completed_at: completedAt,
    response: {
      content: [{ type: "text", text: responseText }],
      stopReason: "end_turn",
      usage: { inputTokens: 5, outputTokens: 3 },
    },
    tool_results: toolResults,
  };
}

// Turn row ending with one tool_use block and its result already stored (regular tool, resolved inline).
function resolvedToolTurnRow(toolUseId: string, toolResultContent: string): unknown {
  return {
    turn_index: 0,
    started_at: T1,
    completed_at: T2,
    response: {
      content: [{ type: "tool_use", id: toolUseId, name: "echo", input: {} }],
      stopReason: "tool_use",
      usage: { inputTokens: 5, outputTokens: 3 },
    },
    tool_results: [{ type: "tool_result", toolUseId, content: toolResultContent }],
  };
}

// Turn row ending with an ask tool_use (unanswered — suspended).
function askTurnRow(toolUseId: string, turnIndex = 0, startedAt = T1, completedAt = T2): unknown {
  return {
    turn_index: turnIndex,
    started_at: startedAt,
    completed_at: completedAt,
    response: {
      content: [{ type: "tool_use", id: toolUseId, name: "ask", input: {} }],
      stopReason: "tool_use",
      usage: { inputTokens: 5, outputTokens: 3 },
    },
    tool_results: [],
  };
}

function inboundRow(
  content: string,
  receivedAt: Date = T7,
  sourceToolUseId: string | null = null,
): unknown {
  return {
    id: randomUUID(),
    received_at: receivedAt,
    content,
    source_tool_use_id: sourceToolUseId,
  };
}

describe("loadResumeInput — no prior turns", () => {
  test("session with no turns: 2 messages — opening user + inbound", async () => {
    const sql = makeSql({ rows: [sessRow()] }, { rows: [] }, { rows: [inboundRow("Reply")] });
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
    const sql = makeSql({ rows: [sessRow()] }, { rows: [] }, { rows: [inboundRow("Hi")] });
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
    const sql = makeSql(
      { rows: [sessRow()] },
      { rows: [turnRow(0, "First reply")] },
      { rows: [inboundRow("Follow-up")] },
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
      { rows: [turnRow(0, "Reply 0"), turnRow(1, "Reply 1", [], T3, T4)] },
      { rows: [inboundRow("Follow-up")] },
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
  test("turn with resolved tool_result: 4 messages — opening, assistant, user(tool_results), inbound", async () => {
    const sql = makeSql(
      { rows: [sessRow()] },
      { rows: [resolvedToolTurnRow("toolu_01", "42")] },
      { rows: [inboundRow("Next question")] },
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
    if (toolBlock?.type === "tool_result") expect(toolBlock.content).toBe("42");
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
    const sql = makeSql(
      { rows: [sessRow()] },
      { rows: [turnRow(1, "Wrong index")] },
      { rows: [inboundRow("Hi")] },
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

  test("malformed response JSON: throws AssertionError", () => {
    const sql = makeSql(
      { rows: [sessRow()] },
      {
        rows: [
          {
            turn_index: 0,
            started_at: T1,
            completed_at: T2,
            response: { invalid: "shape" },
            tool_results: [],
          },
        ],
      },
      { rows: [inboundRow("Hi")] },
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

describe("loadResumeInput — ask-resume path (single-cycle, RELAY-144 compat)", () => {
  const ASK_TOOL_USE_ID = "toolu_ask_01";

  test("single ask, single reply: tool_result with inbound content", async () => {
    const sql = makeSql(
      { rows: [sessRow()] },
      { rows: [askTurnRow(ASK_TOOL_USE_ID)] },
      { rows: [inboundRow("approved", T7, ASK_TOOL_USE_ID)] },
    );

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
    const ASK_B = "toolu_ask_01";
    const ASK_C = "toolu_ask_02";

    const { ToolUseId } = await import("../../../src/ids.ts");
    const toolUseIdResultB = ToolUseId.parse(ASK_B);
    expect(toolUseIdResultB.ok).toBe(true);
    if (!toolUseIdResultB.ok) return;

    const twoAskTurnRow: unknown = {
      turn_index: 0,
      started_at: T1,
      completed_at: T2,
      response: {
        content: [
          { type: "tool_use", id: ASK_B, name: "ask", input: {} },
          { type: "tool_use", id: ASK_C, name: "ask", input: {} },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 5, outputTokens: 3 },
      },
      tool_results: [],
    };
    const sql = makeSql(
      { rows: [sessRow()] },
      { rows: [twoAskTurnRow] },
      { rows: [inboundRow("B replied", T7, ASK_B)] },
    );

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
    expect(blockB.toolUseId as string).toBe(ASK_B);
    expect(blockC?.type).toBe("tool_result");
    if (blockC?.type !== "tool_result") return;
    expect(blockC.content).toBe("<no reply yet>");
    expect(blockC.toolUseId as string).toBe(ASK_C);
  });

  test("mixed regular tool + ask: stored tool_result used for regular, inbound used for ask", async () => {
    const REGULAR_ID = "toolu_regular_01";
    const ASK_ID = "toolu_ask_01";
    const { ToolUseId } = await import("../../../src/ids.ts");
    const askIdResult = ToolUseId.parse(ASK_ID);
    expect(askIdResult.ok).toBe(true);
    if (!askIdResult.ok) return;

    const mixedTurnRow: unknown = {
      turn_index: 0,
      started_at: T1,
      completed_at: T2,
      response: {
        content: [
          { type: "tool_use", id: REGULAR_ID, name: "echo", input: {} },
          { type: "tool_use", id: ASK_ID, name: "ask", input: {} },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 5, outputTokens: 3 },
      },
      tool_results: [{ type: "tool_result", toolUseId: REGULAR_ID, content: "echo result" }],
    };
    const sql = makeSql(
      { rows: [sessRow()] },
      { rows: [mixedTurnRow] },
      { rows: [inboundRow("ask reply", T7, ASK_ID)] },
    );

    const result = await loadResumeInput(sql, {
      sessionId: SESS_ID,
      tenantId: TENANT_ID,
      agentSystemPrompt: SYS_PROMPT,
      inboundContent: "ask reply",
      inboundMessageId: INBOUND_ID,
      sourceToolUseId: askIdResult.value,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const msgs = result.value.initialMessages;
    // opening_user + assistant + user(2 tool_results)
    expect(msgs).toHaveLength(3);
    const toolResultMsg = msgs[2];
    expect(toolResultMsg?.content).toHaveLength(2);
    const blockR = toolResultMsg?.content[0];
    const blockA = toolResultMsg?.content[1];
    expect(blockR?.type).toBe("tool_result");
    if (blockR?.type === "tool_result") expect(blockR.content).toBe("echo result");
    expect(blockA?.type).toBe("tool_result");
    if (blockA?.type === "tool_result") expect(blockA.content).toBe("ask reply");
  });

  test("fresh inbound on ask-suspended session: ask gets <no reply yet>, fresh appended as plain text", async () => {
    // Inbound with no source_tool_use_id (not a reply), session has an unanswered ask.
    const sql = makeSql(
      { rows: [sessRow()] },
      { rows: [askTurnRow(ASK_TOOL_USE_ID)] },
      { rows: [inboundRow("fresh nudge", T7, null)] },
    );

    const result = await loadResumeInput(sql, {
      sessionId: SESS_ID,
      tenantId: TENANT_ID,
      agentSystemPrompt: SYS_PROMPT,
      inboundContent: "fresh nudge",
      inboundMessageId: INBOUND_ID,
      sourceToolUseId: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const msgs = result.value.initialMessages;
    // opening_user + assistant(ask) + user(ask "<no reply yet>") + user(plain fresh nudge)
    expect(msgs).toHaveLength(4);
    const toolResultMsg = msgs[2];
    const block = toolResultMsg?.content[0];
    if (block?.type === "tool_result") expect(block.content).toBe("<no reply yet>");
    const plainMsg = msgs[3];
    expect(plainMsg?.role).toBe("user");
    const plainBlock = plainMsg?.content[0];
    if (plainBlock?.type === "text") expect(plainBlock.text).toBe("fresh nudge");
  });
});

describe("loadResumeInput — multi-cycle (RELAY-232)", () => {
  test("3-turn session: paired asks in turns 0, 1, 2 produce correct transcript", async () => {
    const U1 = "toolu_ask_u1";
    const U2 = "toolu_notify_u2";
    const U3 = "toolu_ask_u3";

    // Turn 0: ask(u1), suspended
    // Turn 1: notify(u2), tool_result stored inline
    // Turn 2: ask(u3), suspended — this is the one being resumed now

    const turn0: unknown = {
      turn_index: 0,
      started_at: new Date(10_000),
      completed_at: new Date(11_000),
      response: {
        content: [{ type: "tool_use", id: U1, name: "ask", input: {} }],
        stopReason: "tool_use",
        usage: { inputTokens: 5, outputTokens: 3 },
      },
      tool_results: [],
    };
    const turn1: unknown = {
      turn_index: 1,
      started_at: new Date(20_000),
      completed_at: new Date(21_000),
      response: {
        content: [{ type: "tool_use", id: U2, name: "notify", input: {} }],
        stopReason: "tool_use",
        usage: { inputTokens: 5, outputTokens: 3 },
      },
      // notify tool_result stored inline during turn execution
      tool_results: [{ type: "tool_result", toolUseId: U2, content: "<dispatched>" }],
    };
    const turn2: unknown = {
      turn_index: 2,
      started_at: new Date(25_000),
      completed_at: new Date(26_000),
      response: {
        content: [{ type: "tool_use", id: U3, name: "ask", input: {} }],
        stopReason: "tool_use",
        usage: { inputTokens: 5, outputTokens: 3 },
      },
      tool_results: [],
    };

    const inboundR1 = inboundRow("reply to u1", new Date(15_000), U1); // after turn 0
    const inboundR2 = inboundRow("reply to u3", new Date(30_000), U3); // after turn 2

    const sql = makeSql(
      { rows: [sessRow()] },
      { rows: [turn0, turn1, turn2] },
      { rows: [inboundR1, inboundR2] },
    );

    const { ToolUseId } = await import("../../../src/ids.ts");
    const u3Result = ToolUseId.parse(U3);
    expect(u3Result.ok).toBe(true);
    if (!u3Result.ok) return;

    const result = await loadResumeInput(sql, {
      sessionId: SESS_ID,
      tenantId: TENANT_ID,
      agentSystemPrompt: SYS_PROMPT,
      inboundContent: "reply to u3",
      inboundMessageId: INBOUND_ID,
      sourceToolUseId: u3Result.value,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const msgs = result.value.initialMessages;
    // Expected order:
    // [0] user: opening "Hello"
    // [1] assistant: turn 0 (ask u1)
    // [2] user: tool_result(u1, "reply to u1")
    // [3] assistant: turn 1 (notify u2)
    // [4] user: tool_result(u2, "<dispatched>")
    // [5] assistant: turn 2 (ask u3)
    // [6] user: tool_result(u3, "reply to u3")
    expect(msgs).toHaveLength(7);

    expect(msgs[0]?.role).toBe("user");
    const openingBlock = msgs[0]?.content[0];
    expect(openingBlock?.type === "text" && openingBlock.text).toBe("Hello");

    expect(msgs[1]?.role).toBe("assistant");
    expect(msgs[2]?.role).toBe("user");
    const turn0Result = msgs[2]?.content[0];
    expect(turn0Result?.type).toBe("tool_result");
    if (turn0Result?.type === "tool_result") {
      expect(turn0Result.toolUseId as string).toBe(U1);
      expect(turn0Result.content).toBe("reply to u1");
    }

    expect(msgs[3]?.role).toBe("assistant");
    expect(msgs[4]?.role).toBe("user");
    const turn1Result = msgs[4]?.content[0];
    expect(turn1Result?.type).toBe("tool_result");
    if (turn1Result?.type === "tool_result") {
      expect(turn1Result.toolUseId as string).toBe(U2);
      expect(turn1Result.content).toBe("<dispatched>");
    }

    expect(msgs[5]?.role).toBe("assistant");
    expect(msgs[6]?.role).toBe("user");
    const turn2Result = msgs[6]?.content[0];
    expect(turn2Result?.type).toBe("tool_result");
    if (turn2Result?.type === "tool_result") {
      expect(turn2Result.toolUseId as string).toBe(U3);
      expect(turn2Result.content).toBe("reply to u3");
    }

    expect(result.value.startTurnIndex).toBe(3);
  });

  test("fresh inbound between turns: appears as plain text in correct position", async () => {
    const U1 = "toolu_ask_u1";

    const turn0: unknown = {
      turn_index: 0,
      started_at: new Date(10_000),
      completed_at: new Date(11_000),
      response: {
        content: [{ type: "tool_use", id: U1, name: "ask", input: {} }],
        stopReason: "tool_use",
        usage: { inputTokens: 5, outputTokens: 3 },
      },
      tool_results: [],
    };
    // Turn 1: a text turn (no asks), completed normally.
    const turn1: unknown = {
      turn_index: 1,
      started_at: new Date(18_000),
      completed_at: new Date(19_000),
      response: {
        content: [{ type: "text", text: "OK noted" }],
        stopReason: "end_turn",
        usage: { inputTokens: 5, outputTokens: 3 },
      },
      tool_results: [],
    };

    // R1 pairs with turn 0's ask (u1)
    const inboundR1 = inboundRow("reply to u1", new Date(15_000), U1);
    // R2 is a fresh nudge that arrived between turn 0 and turn 1 (no source_tool_use_id)
    const inboundR2 = inboundRow("fresh nudge", new Date(16_000), null);
    // The current inbound (triggers this resume) arrived after turn 1
    const inboundCurrent = inboundRow("trigger me", new Date(22_000), null);

    const sql = makeSql(
      { rows: [sessRow()] },
      { rows: [turn0, turn1] },
      { rows: [inboundR1, inboundR2, inboundCurrent] },
    );

    const result = await loadResumeInput(sql, {
      sessionId: SESS_ID,
      tenantId: TENANT_ID,
      agentSystemPrompt: SYS_PROMPT,
      inboundContent: "trigger me",
      inboundMessageId: INBOUND_ID,
      sourceToolUseId: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const msgs = result.value.initialMessages;
    // [0] user: opening "Hello"
    // [1] assistant: turn 0 (ask u1)
    // [2] user: tool_result(u1, "reply to u1")
    // [3] user: plain "fresh nudge" (unpaired, between turn 0 and turn 1)
    // [4] assistant: turn 1 ("OK noted")
    // [5] user: plain "trigger me" (current inbound, after turn 1)
    expect(msgs).toHaveLength(6);

    expect(msgs[0]?.role).toBe("user");
    expect(msgs[1]?.role).toBe("assistant");

    const tr = msgs[2]?.content[0];
    expect(tr?.type).toBe("tool_result");
    if (tr?.type === "tool_result") expect(tr.content).toBe("reply to u1");

    const nudge = msgs[3]?.content[0];
    expect(nudge?.type === "text" && nudge.text).toBe("fresh nudge");

    expect(msgs[4]?.role).toBe("assistant");

    const trigger = msgs[5]?.content[0];
    expect(trigger?.type === "text" && trigger.text).toBe("trigger me");
  });
});

describe("loadResumeInput — RELAY-232 guard assertions", () => {
  test("inbound count exceeds cap: throws AssertionError", () => {
    const lastIndex = MAX_INBOUNDS_REPLAYED_PER_RESUME;
    const overCap = Array.from({ length: lastIndex + 1 }, (_, i) =>
      inboundRow(`msg${String(i)}`, new Date(i * 1_000), null),
    );
    // Use the last inbound's content as the current one so the sanity check passes.
    // (In practice the cap assertion fires before we reach that check.)
    const sql = makeSql({ rows: [sessRow()] }, { rows: [] }, { rows: overCap });
    expect(
      loadResumeInput(sql, {
        sessionId: SESS_ID,
        tenantId: TENANT_ID,
        agentSystemPrompt: SYS_PROMPT,
        inboundContent: `msg${String(lastIndex)}`,
        inboundMessageId: INBOUND_ID,
        sourceToolUseId: null,
      }),
    ).rejects.toThrow(AssertionError);
  });

  test("clock skew — turn started_at < previous completed_at: throws AssertionError", () => {
    const skewedTurn1: unknown = {
      turn_index: 1,
      started_at: new Date(1_500), // < turn 0 completed_at (T2 = 2000)
      completed_at: new Date(3_000),
      response: {
        content: [{ type: "text", text: "skewed" }],
        stopReason: "end_turn",
        usage: { inputTokens: 5, outputTokens: 3 },
      },
      tool_results: [],
    };
    const sql = makeSql(
      { rows: [sessRow()] },
      { rows: [turnRow(0, "t0"), skewedTurn1] },
      { rows: [inboundRow("Hi")] },
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

  test("current inbound content mismatch: throws AssertionError", () => {
    // The inbound row stored in DB has different content than params.inboundContent.
    const sql = makeSql(
      { rows: [sessRow()] },
      { rows: [] },
      { rows: [inboundRow("actual DB content")] },
    );
    expect(
      loadResumeInput(sql, {
        sessionId: SESS_ID,
        tenantId: TENANT_ID,
        agentSystemPrompt: SYS_PROMPT,
        inboundContent: "caller claims this content",
        inboundMessageId: INBOUND_ID,
        sourceToolUseId: null,
      }),
    ).rejects.toThrow(AssertionError);
  });
});
