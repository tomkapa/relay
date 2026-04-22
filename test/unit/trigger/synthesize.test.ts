import { describe, expect, test } from "bun:test";
import type { AgentId, TaskId } from "../../../src/ids.ts";
import { MAX_OPENING_USER_CONTENT } from "../../../src/trigger/limits.ts";
import type { TriggerPayload } from "../../../src/trigger/payload.ts";
import { synthesizeOpeningContext } from "../../../src/trigger/synthesize.ts";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const AGENT_ID = VALID_UUID as AgentId;
const TASK_ID = VALID_UUID as TaskId;

const agent = { systemPrompt: "You are a helpful assistant." };

const messagePayload: TriggerPayload = {
  kind: "message",
  sender: { type: "human", id: "user-1", displayName: "Alice" },
  targetAgentId: AGENT_ID,
  content: "Hello there",
  receivedAt: new Date("2026-04-22T00:00:00.000Z"),
};

const eventPayload: TriggerPayload = {
  kind: "event",
  source: "github",
  targetAgentId: AGENT_ID,
  data: { action: "push" },
  receivedAt: new Date("2026-04-22T00:00:00.000Z"),
};

const taskPayload: TriggerPayload = {
  kind: "task_fire",
  taskId: TASK_ID,
  agentId: AGENT_ID,
  intent: "Run weekly digest",
  firedAt: new Date("2026-04-22T10:00:00.000Z"),
};

describe("synthesizeOpeningContext — system entry", () => {
  test("entry[0] is always the system prompt for message kind", () => {
    const ctx = synthesizeOpeningContext(messagePayload, agent);
    expect(ctx[0]).toEqual({ role: "system", content: agent.systemPrompt });
  });

  test("entry[0] is always the system prompt for event kind", () => {
    const ctx = synthesizeOpeningContext(eventPayload, agent);
    expect(ctx[0]).toEqual({ role: "system", content: agent.systemPrompt });
  });

  test("entry[0] is always the system prompt for task_fire kind", () => {
    const ctx = synthesizeOpeningContext(taskPayload, agent);
    expect(ctx[0]).toEqual({ role: "system", content: agent.systemPrompt });
  });
});

describe("synthesizeOpeningContext — message payload", () => {
  test("entry[1] has role user with sender metadata", () => {
    const ctx = synthesizeOpeningContext(messagePayload, agent);
    const user = ctx[1];
    expect(user?.role).toBe("user");
    if (user?.role !== "user") return;
    expect(user.sender).toEqual({ type: "human", id: "user-1", displayName: "Alice" });
  });

  test("entry[1] has receivedAt as ISO string", () => {
    const ctx = synthesizeOpeningContext(messagePayload, agent);
    const user = ctx[1];
    if (user?.role !== "user") return;
    expect(user.receivedAt).toBe("2026-04-22T00:00:00.000Z");
  });

  test("truncates content past MAX_OPENING_USER_CONTENT with tail marker", () => {
    const longContent = "x".repeat(MAX_OPENING_USER_CONTENT + 100);
    const payload: TriggerPayload = { ...messagePayload, content: longContent };
    const ctx = synthesizeOpeningContext(payload, agent);
    const user = ctx[1];
    if (user?.role !== "user") return;
    expect(user.content.length).toBeLessThanOrEqual(MAX_OPENING_USER_CONTENT);
    expect(user.content).toContain("[…truncated]");
  });

  test("does not truncate content at exactly MAX_OPENING_USER_CONTENT", () => {
    const exactContent = "x".repeat(MAX_OPENING_USER_CONTENT);
    const payload: TriggerPayload = { ...messagePayload, content: exactContent };
    const ctx = synthesizeOpeningContext(payload, agent);
    const user = ctx[1];
    if (user?.role !== "user") return;
    expect(user.content).toBe(exactContent);
  });
});

describe("synthesizeOpeningContext — event payload", () => {
  test("entry[1] content contains event source string", () => {
    const ctx = synthesizeOpeningContext(eventPayload, agent);
    const user = ctx[1];
    if (user?.role !== "user") return;
    expect(user.content).toContain("github");
  });

  test("renderEvent output is deterministic for fixed payload", () => {
    const ctx1 = synthesizeOpeningContext(eventPayload, agent);
    const ctx2 = synthesizeOpeningContext(eventPayload, agent);
    expect(ctx1[1]).toEqual(ctx2[1]);
  });
});

describe("synthesizeOpeningContext — task_fire payload", () => {
  test("entry[1] content contains firedAt ISO and intent", () => {
    const ctx = synthesizeOpeningContext(taskPayload, agent);
    const user = ctx[1];
    if (user?.role !== "user") return;
    expect(user.content).toContain("2026-04-22T10:00:00.000Z");
    expect(user.content).toContain("Run weekly digest");
  });

  test("renderTaskIntent surfaces firedAt ISO and intent text exactly once", () => {
    const ctx = synthesizeOpeningContext(taskPayload, agent);
    const user = ctx[1];
    if (user?.role !== "user") return;
    const isoCount = (user.content.match(/2026-04-22T10:00:00\.000Z/g) ?? []).length;
    const intentCount = (user.content.match(/Run weekly digest/g) ?? []).length;
    expect(isoCount).toBe(1);
    expect(intentCount).toBe(1);
  });
});

describe("synthesizeOpeningContext — always 2 entries", () => {
  test("returns exactly 2 entries for message", () => {
    expect(synthesizeOpeningContext(messagePayload, agent)).toHaveLength(2);
  });

  test("returns exactly 2 entries for event", () => {
    expect(synthesizeOpeningContext(eventPayload, agent)).toHaveLength(2);
  });

  test("returns exactly 2 entries for task_fire", () => {
    expect(synthesizeOpeningContext(taskPayload, agent)).toHaveLength(2);
  });
});
