import { describe, expect, test } from "bun:test";
import type { Sql } from "postgres";
import { realClock } from "../../../src/core/clock.ts";
import type { Result } from "../../../src/core/result.ts";
import type { AgentId, TaskId, TenantId } from "../../../src/ids.ts";
import type { EmbedError } from "../../../src/memory/embedding.ts";
import { MAX_OPENING_USER_CONTENT } from "../../../src/trigger/limits.ts";
import type { TriggerPayload } from "../../../src/trigger/payload.ts";
import { synthesizeOpeningContext } from "../../../src/trigger/synthesize.ts";
import type { SynthesizeDeps } from "../../../src/trigger/synthesize.ts";
import { FakeEmbeddingClient } from "../../fakes/embedding-fake.ts";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const AGENT_ID = VALID_UUID as AgentId;
const TENANT_ID = VALID_UUID as TenantId;
const TASK_ID = VALID_UUID as TaskId;

function defaultDeps(): SynthesizeDeps {
  return {
    sql: null as unknown as Sql,
    clock: realClock,
    embedder: new FakeEmbeddingClient({ error: { kind: "transient", message: "test" } }),
  };
}

type Captured = { text: string | undefined; signal: AbortSignal | undefined };

function makeCaptureDeps(): { deps: SynthesizeDeps; captured: Captured } {
  const captured: Captured = { text: undefined, signal: undefined };
  return {
    deps: {
      sql: null as unknown as Sql,
      clock: realClock,
      embedder: {
        embed(text: string, signal: AbortSignal): Promise<Result<Float32Array, EmbedError>> {
          captured.text = text;
          captured.signal = signal;
          return Promise.resolve({
            ok: false,
            error: { kind: "transient" as const, message: "capture" },
          });
        },
      },
    },
    captured,
  };
}

const defaultSignal = AbortSignal.timeout(5_000);

const agent = {
  id: AGENT_ID,
  tenantId: TENANT_ID,
  systemPrompt: "You are a helpful assistant.",
};

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
  test("entry[0] is always the system prompt for message kind", async () => {
    const ctx = await synthesizeOpeningContext(defaultDeps(), messagePayload, agent, defaultSignal);
    expect(ctx[0]).toEqual({ role: "system", content: agent.systemPrompt });
  });

  test("entry[0] is always the system prompt for event kind", async () => {
    const ctx = await synthesizeOpeningContext(defaultDeps(), eventPayload, agent, defaultSignal);
    expect(ctx[0]).toEqual({ role: "system", content: agent.systemPrompt });
  });

  test("entry[0] is always the system prompt for task_fire kind", async () => {
    const ctx = await synthesizeOpeningContext(defaultDeps(), taskPayload, agent, defaultSignal);
    expect(ctx[0]).toEqual({ role: "system", content: agent.systemPrompt });
  });
});

describe("synthesizeOpeningContext — message payload", () => {
  test("entry[1] has role user with sender metadata", async () => {
    const ctx = await synthesizeOpeningContext(defaultDeps(), messagePayload, agent, defaultSignal);
    const user = ctx[1];
    expect(user?.role).toBe("user");
    if (user?.role !== "user") return;
    expect(user.sender).toEqual({ type: "human", id: "user-1", displayName: "Alice" });
  });

  test("entry[1] has receivedAt as ISO string", async () => {
    const ctx = await synthesizeOpeningContext(defaultDeps(), messagePayload, agent, defaultSignal);
    const user = ctx[1];
    if (user?.role !== "user") return;
    expect(user.receivedAt).toBe("2026-04-22T00:00:00.000Z");
  });

  test("truncates content past MAX_OPENING_USER_CONTENT with tail marker", async () => {
    const longContent = "x".repeat(MAX_OPENING_USER_CONTENT + 100);
    const payload: TriggerPayload = { ...messagePayload, content: longContent };
    const ctx = await synthesizeOpeningContext(defaultDeps(), payload, agent, defaultSignal);
    const user = ctx[1];
    if (user?.role !== "user") return;
    expect(user.content.length).toBeLessThanOrEqual(MAX_OPENING_USER_CONTENT);
    expect(user.content).toContain("[…truncated]");
  });

  test("does not truncate content at exactly MAX_OPENING_USER_CONTENT", async () => {
    const exactContent = "x".repeat(MAX_OPENING_USER_CONTENT);
    const payload: TriggerPayload = { ...messagePayload, content: exactContent };
    const ctx = await synthesizeOpeningContext(defaultDeps(), payload, agent, defaultSignal);
    const user = ctx[1];
    if (user?.role !== "user") return;
    expect(user.content).toBe(exactContent);
  });
});

describe("synthesizeOpeningContext — event payload", () => {
  test("entry[1] content contains event source string", async () => {
    const ctx = await synthesizeOpeningContext(defaultDeps(), eventPayload, agent, defaultSignal);
    const user = ctx[1];
    if (user?.role !== "user") return;
    expect(user.content).toContain("github");
  });

  test("renderEvent output is deterministic for fixed payload", async () => {
    const ctx1 = await synthesizeOpeningContext(defaultDeps(), eventPayload, agent, defaultSignal);
    const ctx2 = await synthesizeOpeningContext(defaultDeps(), eventPayload, agent, defaultSignal);
    expect(ctx1[1]).toEqual(ctx2[1]);
  });
});

describe("synthesizeOpeningContext — task_fire payload", () => {
  test("entry[1] content contains firedAt ISO and intent", async () => {
    const ctx = await synthesizeOpeningContext(defaultDeps(), taskPayload, agent, defaultSignal);
    const user = ctx[1];
    if (user?.role !== "user") return;
    expect(user.content).toContain("2026-04-22T10:00:00.000Z");
    expect(user.content).toContain("Run weekly digest");
  });

  test("renderTaskIntent surfaces firedAt ISO and intent text exactly once", async () => {
    const ctx = await synthesizeOpeningContext(defaultDeps(), taskPayload, agent, defaultSignal);
    const user = ctx[1];
    if (user?.role !== "user") return;
    const isoCount = (user.content.match(/2026-04-22T10:00:00\.000Z/g) ?? []).length;
    const intentCount = (user.content.match(/Run weekly digest/g) ?? []).length;
    expect(isoCount).toBe(1);
    expect(intentCount).toBe(1);
  });
});

describe("synthesizeOpeningContext — always 2 entries", () => {
  test("returns exactly 2 entries for message", async () => {
    expect(
      await synthesizeOpeningContext(defaultDeps(), messagePayload, agent, defaultSignal),
    ).toHaveLength(2);
  });

  test("returns exactly 2 entries for event", async () => {
    expect(
      await synthesizeOpeningContext(defaultDeps(), eventPayload, agent, defaultSignal),
    ).toHaveLength(2);
  });

  test("returns exactly 2 entries for task_fire", async () => {
    expect(
      await synthesizeOpeningContext(defaultDeps(), taskPayload, agent, defaultSignal),
    ).toHaveLength(2);
  });
});

describe("synthesizeOpeningContext — embed soft-fail paths", () => {
  test("synthesize_returnsBaseTuple_whenEmbedFails_transient", async () => {
    const deps = defaultDeps(); // transient error
    const ctx = await synthesizeOpeningContext(deps, messagePayload, agent, defaultSignal);
    expect(ctx).toHaveLength(2);
    expect(ctx[0]).toEqual({ role: "system", content: agent.systemPrompt });
  });

  test("synthesize_returnsBaseTuple_whenEmbedFails_permanent", async () => {
    const deps: SynthesizeDeps = {
      sql: null as unknown as Sql,
      clock: realClock,
      embedder: new FakeEmbeddingClient({ error: { kind: "permanent", message: "banned" } }),
    };
    const ctx = await synthesizeOpeningContext(deps, messagePayload, agent, defaultSignal);
    expect(ctx).toHaveLength(2);
    expect(ctx[0]).toEqual({ role: "system", content: agent.systemPrompt });
  });

  test("synthesize_returnsBaseTuple_whenEmbedFails_timeout", async () => {
    const deps: SynthesizeDeps = {
      sql: null as unknown as Sql,
      clock: realClock,
      embedder: new FakeEmbeddingClient({ error: { kind: "timeout", elapsedMs: 100 } }),
    };
    const ctx = await synthesizeOpeningContext(deps, messagePayload, agent, defaultSignal);
    expect(ctx).toHaveLength(2);
    expect(ctx[0]).toEqual({ role: "system", content: agent.systemPrompt });
  });

  test("synthesize_returnsBaseTuple_whenEmbedFails_inputTooLong", async () => {
    const deps: SynthesizeDeps = {
      sql: null as unknown as Sql,
      clock: realClock,
      embedder: new FakeEmbeddingClient({
        error: { kind: "input_too_long", bytes: 9000, max: 8192 },
      }),
    };
    const ctx = await synthesizeOpeningContext(deps, messagePayload, agent, defaultSignal);
    expect(ctx).toHaveLength(2);
    expect(ctx[0]).toEqual({ role: "system", content: agent.systemPrompt });
  });
});

describe("synthesizeOpeningContext — embedsExactUserMessageContent", () => {
  test("synthesize_embedsExactUserMessageContent_message", async () => {
    const { deps, captured } = makeCaptureDeps();
    const ctx = await synthesizeOpeningContext(deps, messagePayload, agent, defaultSignal);
    const user = ctx[1];
    if (user?.role !== "user") return;
    expect(captured.text).toBe(user.content);
  });

  test("synthesize_embedsExactUserMessageContent_event", async () => {
    const { deps, captured } = makeCaptureDeps();
    const ctx = await synthesizeOpeningContext(deps, eventPayload, agent, defaultSignal);
    const user = ctx[1];
    if (user?.role !== "user") return;
    expect(captured.text).toBe(user.content);
  });

  test("synthesize_embedsExactUserMessageContent_taskFire", async () => {
    const { deps, captured } = makeCaptureDeps();
    const ctx = await synthesizeOpeningContext(deps, taskPayload, agent, defaultSignal);
    const user = ctx[1];
    if (user?.role !== "user") return;
    expect(captured.text).toBe(user.content);
  });

  test("synthesize_passesAbortSignal", async () => {
    const { deps, captured } = makeCaptureDeps();
    const signal = AbortSignal.timeout(9_999);
    await synthesizeOpeningContext(deps, messagePayload, agent, signal);
    expect(captured.signal).toBe(signal);
  });
});
