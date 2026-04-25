// Type-level and construction tests for src/hook/payloads.ts.
// No runtime hook evaluation — these tests prove the type contract at compile time
// and verify that payload objects can be constructed with the correct shapes.

import { describe, expect, test } from "bun:test";
import { assert } from "../../../src/core/assert.ts";
import type {
  HookSender,
  PayloadFor,
  PostToolUsePayload,
  PreMessageReceivePayload,
  PreMessageSendPayload,
  PreToolUsePayload,
  SessionEndPayload,
  SessionStartPayload,
} from "../../../src/hook/payloads.ts";
import type { HookEvent, HOOK_EVENT } from "../../../src/hook/types.ts";
import type {
  AgentId as AgentIdType,
  SessionId as SessionIdType,
  TenantId as TenantIdType,
} from "../../../src/ids.ts";
import {
  AgentId,
  ChainId,
  Depth,
  InboundMessageId,
  SessionId,
  TenantId,
  ToolUseId,
  TurnId,
  mintId,
} from "../../../src/ids.ts";

// ---- Type-level equality helper -----------------------------------------------
// T extends U && U extends T → true, else false. Used as a compile-time assertion.
type Eq<T, U> = [T] extends [U] ? ([U] extends [T] ? true : false) : false;

// ---- Parse helpers (test fixtures) -------------------------------------------

function parseTenant(): TenantIdType {
  const r = TenantId.parse("00000000-0000-4000-8000-000000000001");
  assert(r.ok, "test: invalid TenantId");
  return r.value;
}

function parseAgent(): AgentIdType {
  const r = AgentId.parse("00000000-0000-4000-8000-000000000002");
  assert(r.ok, "test: invalid AgentId");
  return r.value;
}

function parseSession(): SessionIdType {
  const r = SessionId.parse("00000000-0000-4000-8000-000000000003");
  assert(r.ok, "test: invalid SessionId");
  return r.value;
}

const tenantId = parseTenant();
const agentId = parseAgent();
const sessionId = parseSession();
const chainId = mintId(ChainId.parse, "test");
const depthResult = Depth.parse(0);
assert(depthResult.ok, "test: depth out of range");
const depth = depthResult.value;
const turnId = mintId(TurnId.parse, "test");
const toolUseIdResult = ToolUseId.parse("test-tool-use");
assert(toolUseIdResult.ok, "test: invalid ToolUseId");
const toolUseId = toolUseIdResult.value;
const inboundIdResult = InboundMessageId.parse("00000000-0000-4000-8000-000000000004");
assert(inboundIdResult.ok, "test: invalid InboundMessageId");
const inboundMessageId = inboundIdResult.value;

// ---- Compile-time type assertions -------------------------------------------

describe("PayloadFor type-level lookup", () => {
  test("PayloadFor<session_start> equals SessionStartPayload", () => {
    // If this assignment compiles, the type equality holds.
    const _check: Eq<PayloadFor<"session_start">, SessionStartPayload> = true;
    expect(_check).toBe(true);
  });

  test("PayloadFor<session_end> equals SessionEndPayload", () => {
    const _check: Eq<PayloadFor<"session_end">, SessionEndPayload> = true;
    expect(_check).toBe(true);
  });

  test("PayloadFor<pre_tool_use> equals PreToolUsePayload", () => {
    const _check: Eq<PayloadFor<"pre_tool_use">, PreToolUsePayload> = true;
    expect(_check).toBe(true);
  });

  test("PayloadFor<post_tool_use> equals PostToolUsePayload", () => {
    const _check: Eq<PayloadFor<"post_tool_use">, PostToolUsePayload> = true;
    expect(_check).toBe(true);
  });

  test("PayloadFor<pre_message_receive> equals PreMessageReceivePayload", () => {
    const _check: Eq<PayloadFor<"pre_message_receive">, PreMessageReceivePayload> = true;
    expect(_check).toBe(true);
  });

  test("PayloadFor<pre_message_send> equals PreMessageSendPayload", () => {
    const _check: Eq<PayloadFor<"pre_message_send">, PreMessageSendPayload> = true;
    expect(_check).toBe(true);
  });

  test("HOOK_EVENT constants resolve to the literal types PayloadFor expects", () => {
    // Compile-time proof that HOOK_EVENT.SessionStart produces "session_start" (literal).
    const _start: Eq<typeof HOOK_EVENT.SessionStart, "session_start"> = true;
    const _end: Eq<typeof HOOK_EVENT.SessionEnd, "session_end"> = true;
    const _pre: Eq<typeof HOOK_EVENT.PreToolUse, "pre_tool_use"> = true;
    const _post: Eq<typeof HOOK_EVENT.PostToolUse, "post_tool_use"> = true;
    const _recv: Eq<typeof HOOK_EVENT.PreMessageReceive, "pre_message_receive"> = true;
    const _send: Eq<typeof HOOK_EVENT.PreMessageSend, "pre_message_send"> = true;
    expect(_start).toBe(true);
    expect(_end).toBe(true);
    expect(_pre).toBe(true);
    expect(_post).toBe(true);
    expect(_recv).toBe(true);
    expect(_send).toBe(true);
  });
});

// ---- Construction round-trip tests -------------------------------------------
// Each test verifies that a complete payload instance compiles with the right shape.

describe("SessionStartPayload construction", () => {
  test("all required fields compile", () => {
    const p: SessionStartPayload = {
      tenantId,
      agentId,
      sessionId,
      chainId,
      depth,
      parentSessionId: null,
      triggerKind: "session_start",
    };
    expect(p.triggerKind).toBe("session_start");
    expect(p.parentSessionId).toBeNull();
  });

  test("triggerKind accepts all three origins", () => {
    const kinds: SessionStartPayload["triggerKind"][] = [
      "session_start",
      "task_fire",
      "inbound_message",
    ];
    expect(kinds.length).toBe(3);
  });
});

describe("SessionEndPayload construction", () => {
  test("all required fields compile", () => {
    const now = new Date(2_000_000);
    const createdAt = new Date(1_000_000);
    const p: SessionEndPayload = {
      tenantId,
      agentId,
      sessionId,
      reason: { kind: "end_turn" },
      closedAt: now,
      createdAt,
      durationMs: now.getTime() - createdAt.getTime(),
    };
    expect(p.durationMs).toBe(1_000_000);
  });
});

describe("PreToolUsePayload construction", () => {
  test("all required fields compile", () => {
    const p: PreToolUsePayload = {
      tenantId,
      agentId,
      sessionId,
      turnId,
      toolUseId,
      toolName: "bash",
      toolInput: { command: "ls" },
    };
    expect(p.toolName).toBe("bash");
  });
});

describe("PostToolUsePayload construction", () => {
  test("ok outcome compiles", () => {
    const p: PostToolUsePayload = {
      tenantId,
      agentId,
      sessionId,
      turnId,
      toolUseId,
      toolName: "bash",
      outcome: "invoked",
      toolResult: { kind: "ok", content: "output" },
    };
    expect(p.outcome).toBe("invoked");
    expect(p.toolResult.kind).toBe("ok");
  });

  test("error outcome compiles", () => {
    const p: PostToolUsePayload = {
      tenantId,
      agentId,
      sessionId,
      turnId,
      toolUseId,
      toolName: "bash",
      outcome: "tool_error",
      toolResult: { kind: "error", errorMessage: "failed" },
    };
    expect(p.outcome).toBe("tool_error");
    expect(p.toolResult.kind).toBe("error");
  });
});

describe("PreMessageReceivePayload construction", () => {
  test("human sender compiles", () => {
    const p: PreMessageReceivePayload = {
      tenantId,
      targetAgentId: agentId,
      targetSessionId: sessionId,
      inboundMessageId,
      sender: { type: "human", id: "user-123" },
      content: "hello",
      receivedAt: new Date(),
    };
    expect(p.sender.type).toBe("human");
  });

  test("agent sender with displayName compiles", () => {
    const p: PreMessageReceivePayload = {
      tenantId,
      targetAgentId: agentId,
      targetSessionId: sessionId,
      inboundMessageId,
      sender: { type: "agent", id: "agent-456", displayName: "My Agent" },
      content: "hello",
      receivedAt: new Date(),
    };
    expect(p.sender.displayName).toBe("My Agent");
  });
});

describe("PreMessageSendPayload construction", () => {
  test("agent target compiles", () => {
    const p: PreMessageSendPayload = {
      tenantId,
      senderAgentId: agentId,
      senderSessionId: sessionId,
      turnId,
      target: { type: "agent", agentId },
      kind: "ask",
      content: "can you help?",
      idempotencyKey: "key-abc",
    };
    expect(p.kind).toBe("ask");
  });

  test("human target compiles", () => {
    const p: PreMessageSendPayload = {
      tenantId,
      senderAgentId: agentId,
      senderSessionId: sessionId,
      turnId,
      target: { type: "human", externalId: "user-789" },
      kind: "notify",
      content: "done",
      idempotencyKey: "key-def",
    };
    expect(p.target.type).toBe("human");
  });
});

describe("HookSender construction", () => {
  test("all three sender types compile", () => {
    const senders: HookSender[] = [
      { type: "human", id: "h1" },
      { type: "agent", id: "a1", displayName: "Agent" },
      { type: "system", id: "s1" },
    ];
    expect(senders.length).toBe(3);
  });
});

// Compile-time proof: PayloadFor<HookEvent> is the union of all payload types.
// We don't run this as a test — the fact that it compiles is the assertion.
type _AllPayloads = PayloadFor<HookEvent>;
// Should be assignable from any individual payload:
const _check1: _AllPayloads = {
  tenantId,
  agentId,
  sessionId,
  chainId,
  depth,
  parentSessionId: null,
  triggerKind: "session_start",
} satisfies SessionStartPayload;
void _check1; // suppress unused warning
