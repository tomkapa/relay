import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { AssertionError } from "../../../src/core/assert.ts";
import { idempotencyKey } from "../../../src/core/idempotency.ts";
import type { Result } from "../../../src/core/result.ts";
import { ok } from "../../../src/core/result.ts";
import {
  AgentId as AgentIdParser,
  SessionId as SessionIdParser,
  TenantId as TenantIdParser,
  ToolUseId,
  TurnId as TurnIdParser,
} from "../../../src/ids.ts";
import type { EmbedError, EmbeddingClient } from "../../../src/memory/embedding.ts";
import { WRITER as MEMORY_WRITER } from "../../../src/memory/insert.ts";
import { MAX_ENTRY_TEXT_BYTES } from "../../../src/memory/limits.ts";
import {
  REMEMBER_TOOL_NAME,
  makeRememberTool,
  parseRememberInput,
} from "../../../src/memory/remember.ts";
import type { ToolInvocationContext } from "../../../src/session/tools.ts";
import { Attr } from "../../../src/telemetry/otel.ts";
import { FakeEmbeddingClient } from "../../fakes/embedding-fake.ts";
import type { ResourceMetrics } from "@opentelemetry/sdk-metrics";
import { installMetricFixture, sumCounter, uninstallMetricFixture } from "../../helpers/metrics.ts";

// ---------------------------------------------------------------------------
// Fake SQL helpers
// ---------------------------------------------------------------------------

type TxQueryResponse = Record<string, unknown>[];

class FakeSql {
  public beginCallCount = 0;
  public capturedQueryValues: unknown[][][] = [];
  public onBeginCall: (() => void) | undefined;
  private txResponses: TxQueryResponse[][] = [];

  setResponses(txResponses: TxQueryResponse[][]): void {
    this.txResponses = txResponses;
  }

  begin<T>(fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
    this.onBeginCall?.();
    const txIdx = this.beginCallCount++;
    const queries = this.txResponses[txIdx] ?? [];
    const captured: unknown[][] = [];
    this.capturedQueryValues.push(captured);
    let qIdx = 0;

    const tx = ((_strings: TemplateStringsArray, ...values: unknown[]) => {
      captured.push(values);
      const resp = queries[qIdx++] ?? [];
      return Promise.resolve(resp);
    }) as unknown as TransactionSql;

    return fn(tx);
  }
}

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

function parseId<T>(parser: (raw: string) => Result<T, unknown>, raw: string): T {
  const r = parser(raw);
  if (!r.ok) throw new Error(`fixture: invalid id ${raw}`);
  return r.value;
}

function makeCtx(): ToolInvocationContext {
  return {
    sessionId: parseId(SessionIdParser.parse, randomUUID()),
    agentId: parseId(AgentIdParser.parse, randomUUID()),
    tenantId: parseId(TenantIdParser.parse, randomUUID()),
    turnId: parseId(TurnIdParser.parse, randomUUID()),
    toolUseId: parseId(ToolUseId.parse, `tool_use_${randomUUID()}`),
  };
}

function makeHappyPathSql(ctx: ToolInvocationContext): FakeSql {
  const fakeSql = new FakeSql();
  fakeSql.setResponses([
    [
      // SELECT tenant_id FROM agents
      [{ tenant_id: ctx.tenantId }],
      // INSERT INTO memory — return a realistic row
      [
        {
          id: randomUUID(),
          agent_id: ctx.agentId,
          tenant_id: ctx.tenantId,
          kind: "event",
          text: "placeholder",
          importance: 0.5,
          created_at: new Date(),
          last_retrieved_at: null,
          retrieval_count: 0,
        },
      ],
    ],
  ]);
  return fakeSql;
}

function asSql(fakeSql: FakeSql): Sql {
  return fakeSql as unknown as Sql;
}

// ---------------------------------------------------------------------------
// parseRememberInput
// ---------------------------------------------------------------------------

describe("parseRememberInput", () => {
  test("acceptsTextOnly_defaultsImportanceTo0.5", () => {
    const r = parseRememberInput({ text: "hello world" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.text).toBe("hello world");
    expect(r.value.importance as number).toBe(0.5);
  });

  test("acceptsExplicitImportance_inRange", () => {
    const r = parseRememberInput({ text: "hello", importance: 0.9 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.importance as number).toBeCloseTo(0.9);
  });

  test("rejectsImportanceOutOfRange_above1", () => {
    const r = parseRememberInput({ text: "hello", importance: 1.1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("input_invalid");
    if (r.error.kind !== "input_invalid") return;
    expect(r.error.field).toBe("importance");
  });

  test("rejectsImportanceOutOfRange_below0", () => {
    const r = parseRememberInput({ text: "hello", importance: -0.1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("input_invalid");
  });

  test("rejectsImportanceOutOfRange_NaN", () => {
    const r = parseRememberInput({ text: "hello", importance: Number.NaN });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("input_invalid");
  });

  test("rejectsImportanceOutOfRange_Infinity", () => {
    const r = parseRememberInput({ text: "hello", importance: Infinity });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("input_invalid");
  });

  test("rejectsImportanceNonNumber_string", () => {
    const r = parseRememberInput({ text: "hello", importance: "high" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("input_invalid");
    if (r.error.kind !== "input_invalid") return;
    expect(r.error.field).toBe("importance");
  });

  test("rejectsImportanceNonNumber_null", () => {
    const r = parseRememberInput({ text: "hello", importance: null });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("input_invalid");
    if (r.error.kind !== "input_invalid") return;
    expect(r.error.field).toBe("importance");
  });

  test("rejectsEmptyText", () => {
    const r = parseRememberInput({ text: "" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("input_invalid");
    if (r.error.kind !== "input_invalid") return;
    expect(r.error.field).toBe("text");
  });

  test("rejectsMissingText", () => {
    const r = parseRememberInput({});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("input_invalid");
    if (r.error.kind !== "input_invalid") return;
    expect(r.error.field).toBe("text");
  });

  test("rejectsNonStringText_number", () => {
    const r = parseRememberInput({ text: 42 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("input_invalid");
    if (r.error.kind !== "input_invalid") return;
    expect(r.error.field).toBe("text");
  });

  test("rejectsTextOverByteLimit", () => {
    const oversizeText = "x".repeat(MAX_ENTRY_TEXT_BYTES + 1);
    const r = parseRememberInput({ text: oversizeText });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("text_too_long");
    if (r.error.kind !== "text_too_long") return;
    expect(r.error.bytes).toBeGreaterThan(MAX_ENTRY_TEXT_BYTES);
    expect(r.error.max).toBe(MAX_ENTRY_TEXT_BYTES);
  });

  test("rejectsTextOverByteLimit_utf8MultibyteEdge", () => {
    // Each '中' is 3 UTF-8 bytes; ceil(MAX / 3) + 1 chars → just over the limit.
    const charCount = Math.ceil(MAX_ENTRY_TEXT_BYTES / 3) + 1;
    const oversizeText = "中".repeat(charCount);
    const r = parseRememberInput({ text: oversizeText });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("text_too_long");
  });
});

// ---------------------------------------------------------------------------
// runRemember (via makeRememberTool.invoke)
// ---------------------------------------------------------------------------

describe("runRemember", () => {
  test("callsEmbedThenInsert_inOrder", async () => {
    const ctx = makeCtx();
    const calls: string[] = [];

    const embedding: EmbeddingClient = {
      embed() {
        calls.push("embed");
        return Promise.resolve(ok(new Float32Array(1536)));
      },
    };

    const fakeSql = makeHappyPathSql(ctx);
    fakeSql.onBeginCall = () => calls.push("begin");

    const tool = makeRememberTool({ sql: asSql(fakeSql), embedding });
    await tool.invoke({ text: "a fact" }, ctx, AbortSignal.timeout(5000));

    expect(calls[0]).toBe("embed");
    expect(calls[1]).toBe("begin");
  });

  test("passesIdempotencyKey_derivedFromCtx", async () => {
    const ctx = makeCtx();
    const fakeSql = makeHappyPathSql(ctx);
    const tool = makeRememberTool({ sql: asSql(fakeSql), embedding: new FakeEmbeddingClient() });

    await tool.invoke({ text: "a fact" }, ctx, AbortSignal.timeout(5000));

    const expectedKey = idempotencyKey({
      writer: MEMORY_WRITER,
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      toolCallId: ctx.toolUseId,
    });

    // INSERT query (second query, index 1) receives idempotency_key as its 8th param.
    const insertValues = fakeSql.capturedQueryValues[0]?.[1];
    expect(insertValues).toBeDefined();
    expect(insertValues).toContain(expectedKey as string);
  });

  test("returnsEmbedTransient_onTransientError", async () => {
    const ctx = makeCtx();
    const fakeSql = new FakeSql();

    const tool = makeRememberTool({
      sql: asSql(fakeSql),
      embedding: new FakeEmbeddingClient({ error: { kind: "transient", message: "rate limited" } }),
    });

    const result = await tool.invoke({ text: "hello" }, ctx, AbortSignal.timeout(5000));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorMessage).toContain("temporarily unavailable");
    expect(result.errorMessage).toContain("rate limited");
  });

  test("returnsEmbedPermanent_onPermanentError", async () => {
    const ctx = makeCtx();
    const fakeSql = new FakeSql();

    const tool = makeRememberTool({
      sql: asSql(fakeSql),
      embedding: new FakeEmbeddingClient({
        error: { kind: "permanent", message: "invalid input" },
      }),
    });

    const result = await tool.invoke({ text: "hello" }, ctx, AbortSignal.timeout(5000));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorMessage).toContain("rejected input");
  });

  test("returnsEmbedTimeout_onTimeoutError", async () => {
    const ctx = makeCtx();
    const fakeSql = new FakeSql();

    const tool = makeRememberTool({
      sql: asSql(fakeSql),
      embedding: new FakeEmbeddingClient({ error: { kind: "timeout", elapsedMs: 10_000 } }),
    });

    const result = await tool.invoke({ text: "hello" }, ctx, AbortSignal.timeout(5000));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorMessage).toContain("timed out");
    expect(result.errorMessage).toContain("10000");
  });

  test("assertsOnEmbedInputTooLong", async () => {
    const ctx = makeCtx();
    const fakeSql = new FakeSql();

    const tool = makeRememberTool({
      sql: asSql(fakeSql),
      embedding: new FakeEmbeddingClient({
        error: { kind: "input_too_long", bytes: 10_000, max: 8192 },
      }),
    });

    let caught: unknown;
    try {
      await tool.invoke({ text: "short text" }, ctx, AbortSignal.timeout(5000));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AssertionError);
  });

  test("assertsOnInsertTenantMismatch", async () => {
    const ctx = makeCtx();
    const differentTenantId = randomUUID(); // guaranteed different from ctx.tenantId

    const fakeSql = new FakeSql();
    fakeSql.setResponses([[[{ tenant_id: differentTenantId }]]]);

    const tool = makeRememberTool({ sql: asSql(fakeSql), embedding: new FakeEmbeddingClient() });

    let caught: unknown;
    try {
      await tool.invoke({ text: "hello" }, ctx, AbortSignal.timeout(5000));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AssertionError);
  });

  test("assertsOnInsertAgentNotFound", async () => {
    const ctx = makeCtx();
    const fakeSql = new FakeSql();
    fakeSql.setResponses([[[]]]); // SELECT agents returns empty

    const tool = makeRememberTool({ sql: asSql(fakeSql), embedding: new FakeEmbeddingClient() });

    let caught: unknown;
    try {
      await tool.invoke({ text: "hello" }, ctx, AbortSignal.timeout(5000));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AssertionError);
  });

  test("doesNotOpenTransaction_whenEmbedFails", async () => {
    const ctx = makeCtx();
    const fakeSql = new FakeSql();

    const tool = makeRememberTool({
      sql: asSql(fakeSql),
      embedding: new FakeEmbeddingClient({ error: { kind: "transient", message: "rate limited" } }),
    });

    await tool.invoke({ text: "hello" }, ctx, AbortSignal.timeout(5000));
    expect(fakeSql.beginCallCount).toBe(0);
  });

  test("passesAbortSignal_toEmbed", async () => {
    const ctx = makeCtx();
    let capturedSignal: AbortSignal | undefined;

    const embedding: EmbeddingClient = {
      embed(text: string, signal: AbortSignal) {
        // Suppress unused-variable for text — we only care about the signal here.
        void text;
        capturedSignal = signal;
        return Promise.resolve(ok(new Float32Array(1536)));
      },
    };

    const fakeSql = makeHappyPathSql(ctx);
    const tool = makeRememberTool({ sql: asSql(fakeSql), embedding });

    const testSignal = AbortSignal.timeout(5000);
    await tool.invoke({ text: "hello" }, ctx, testSignal);
    expect(capturedSignal).toBe(testSignal);
  });
});

// ---------------------------------------------------------------------------
// toToolResult and error messages
// ---------------------------------------------------------------------------

describe("toToolResult_okShape", () => {
  test("content_isJSON_withMemoryIdAndKind", async () => {
    const ctx = makeCtx();
    const fakeSql = makeHappyPathSql(ctx);
    const tool = makeRememberTool({ sql: asSql(fakeSql), embedding: new FakeEmbeddingClient() });

    const result = await tool.invoke({ text: "hello" }, ctx, AbortSignal.timeout(5000));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = JSON.parse(result.content) as { memoryId: string; kind: string };
    expect(typeof parsed.memoryId).toBe("string");
    expect(parsed.kind).toBe("event");
  });
});

type ErrorCase = {
  label: string;
  invoke: (
    tool: ReturnType<typeof makeRememberTool>,
    ctx: ToolInvocationContext,
  ) => Promise<unknown>;
  expectedSubstring: string;
};

describe("toToolResult_errorMessages_areAgentReadable", () => {
  const cases: ErrorCase[] = [
    {
      label: "input_invalid",
      invoke: (tool, ctx) => tool.invoke({ text: "" }, ctx, AbortSignal.timeout(5000)),
      expectedSubstring: "text",
    },
    {
      label: "text_too_long",
      invoke: (tool, ctx) =>
        tool.invoke({ text: "x".repeat(MAX_ENTRY_TEXT_BYTES + 1) }, ctx, AbortSignal.timeout(5000)),
      expectedSubstring: String(MAX_ENTRY_TEXT_BYTES + 1),
    },
    {
      label: "embed_transient",
      invoke: (tool, ctx) => tool.invoke({ text: "hello" }, ctx, AbortSignal.timeout(5000)),
      expectedSubstring: "temporarily unavailable",
    },
    {
      label: "embed_permanent",
      invoke: (tool, ctx) => tool.invoke({ text: "hello" }, ctx, AbortSignal.timeout(5000)),
      expectedSubstring: "rejected",
    },
    {
      label: "embed_timeout",
      invoke: (tool, ctx) => tool.invoke({ text: "hello" }, ctx, AbortSignal.timeout(5000)),
      expectedSubstring: "10000",
    },
  ];

  const embedErrors: Record<string, EmbedError | undefined> = {
    input_invalid: undefined,
    text_too_long: undefined,
    embed_transient: { kind: "transient", message: "rate limited" },
    embed_permanent: { kind: "permanent", message: "unsupported" },
    embed_timeout: { kind: "timeout", elapsedMs: 10_000 },
  };

  for (const { label, invoke, expectedSubstring } of cases) {
    test(`errorMessage_${label}_isAgentReadable`, async () => {
      const ctx = makeCtx();
      const embedErr = embedErrors[label];
      const tool = makeRememberTool({
        sql: asSql(new FakeSql()),
        embedding: new FakeEmbeddingClient(embedErr !== undefined ? { error: embedErr } : {}),
      });

      const result = await invoke(tool, ctx);
      const toolResult = result as { ok: boolean; errorMessage?: string };
      expect(toolResult.ok).toBe(false);
      expect(toolResult.errorMessage).toContain(expectedSubstring);
    });
  }
});

// ---------------------------------------------------------------------------
// makeRememberTool schema shape
// ---------------------------------------------------------------------------

describe("makeRememberTool_schemaShape", () => {
  test("schema_name_isRemember", () => {
    const tool = makeRememberTool({
      sql: asSql(new FakeSql()),
      embedding: new FakeEmbeddingClient(),
    });
    expect(tool.schema.name).toBe(REMEMBER_TOOL_NAME);
    expect(tool.schema.name).toBe("remember");
  });

  test("schema_description_isPresent", () => {
    const tool = makeRememberTool({
      sql: asSql(new FakeSql()),
      embedding: new FakeEmbeddingClient(),
    });
    expect(typeof tool.schema.description).toBe("string");
    expect((tool.schema.description ?? "").length).toBeGreaterThan(0);
  });

  test("schema_inputSchema_hasRequiredText_andNoAdditionalProperties", () => {
    const tool = makeRememberTool({
      sql: asSql(new FakeSql()),
      embedding: new FakeEmbeddingClient(),
    });
    const schema = tool.schema.inputSchema as {
      required: string[];
      additionalProperties: boolean;
    };
    expect(schema.required).toContain("text");
    expect(schema.additionalProperties).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Outcome counter
// ---------------------------------------------------------------------------

describe("makeRememberTool_outcomeCounter", () => {
  let collect: () => Promise<ResourceMetrics>;

  beforeEach(() => {
    ({ collect } = installMetricFixture());
  });

  afterEach(async () => {
    await uninstallMetricFixture();
  });

  test("incrementsWithWritten_onSuccess", async () => {
    const ctx = makeCtx();
    const fakeSql = makeHappyPathSql(ctx);
    const tool = makeRememberTool({ sql: asSql(fakeSql), embedding: new FakeEmbeddingClient() });

    await tool.invoke({ text: "hello" }, ctx, AbortSignal.timeout(5000));

    const rm = await collect();
    const count = sumCounter(rm, "relay.tool.remember.outcome_total", {
      [Attr.Outcome]: "written",
    });
    expect(count).toBe(1);
  });

  test("incrementsWithEmbedTransient_onEmbedError", async () => {
    const ctx = makeCtx();
    const tool = makeRememberTool({
      sql: asSql(new FakeSql()),
      embedding: new FakeEmbeddingClient({ error: { kind: "transient", message: "x" } }),
    });

    await tool.invoke({ text: "hello" }, ctx, AbortSignal.timeout(5000));

    const rm = await collect();
    const count = sumCounter(rm, "relay.tool.remember.outcome_total", {
      [Attr.Outcome]: "embed_transient",
    });
    expect(count).toBe(1);
  });

  test("incrementsWithInputInvalid_onBadInput", async () => {
    const ctx = makeCtx();
    const tool = makeRememberTool({
      sql: asSql(new FakeSql()),
      embedding: new FakeEmbeddingClient(),
    });

    await tool.invoke({ text: "" }, ctx, AbortSignal.timeout(5000));

    const rm = await collect();
    const count = sumCounter(rm, "relay.tool.remember.outcome_total", {
      [Attr.Outcome]: "input_invalid",
    });
    expect(count).toBe(1);
  });
});
