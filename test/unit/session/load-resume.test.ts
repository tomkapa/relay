// Unit tests for loadResumeInput. Pure-function tests using a hand-rolled fake Sql.
// Integration-level correctness (real DB, real turns from runTurnLoop) is in
// test/integration/trigger/handlers.test.ts under "inbound_message — resume turn loop wiring".

import { describe, expect, test } from "bun:test";
import type { Sql } from "postgres";
import type { SessionId, TenantId } from "../../../src/ids.ts";
import { AssertionError } from "../../../src/core/assert.ts";
import { loadResumeInput } from "../../../src/session/load-resume.ts";

const SESS_ID = "11111111-1111-4111-a111-111111111111" as SessionId;
const TENANT_ID = "22222222-2222-4222-a222-222222222222" as TenantId;
const OTHER_TENANT = "33333333-3333-4333-a333-333333333333" as TenantId;
const SYS_PROMPT = "You are a helpful assistant.";

type SqlCallSpec = {
  rows: unknown[];
};

function makeSql(sessionRows: SqlCallSpec, turnRows: SqlCallSpec): Sql {
  const fake = (strings: TemplateStringsArray): Promise<unknown[]> => {
    const chunk = strings[0] ?? "";
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
      }),
    ).rejects.toThrow(AssertionError);
  });
});
