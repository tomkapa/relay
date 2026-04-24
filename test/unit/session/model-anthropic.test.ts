// Unit tests for AnthropicModelClient.
// Anthropic is a paid external service — CLAUDE.md §3 permits mocking it via an
// injected SDK instance. Tests assert the GenAI semconv instrumentation (attrs +
// events on the active model.call span, plus duration/token histograms).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicModelClient } from "../../../src/session/model-anthropic.ts";
import { GenAiAttr, GenAiEvent, SpanName, withSpan } from "../../../src/telemetry/otel.ts";
import type { Message } from "../../../src/session/turn.ts";
import {
  installSpanFixture,
  uninstallSpanFixture,
  findEvent,
  type SpanFixture,
} from "../../helpers/spans.ts";
import {
  histogramCount,
  histogramSum,
  installMetricFixture,
  uninstallMetricFixture,
  type MetricFixture,
} from "../../helpers/metrics.ts";

type FakeSdk = { messages: { create: (req: unknown) => Promise<unknown> } };

function fakeSdk(response: unknown): Anthropic {
  const sdk: FakeSdk = { messages: { create: () => Promise.resolve(response) } };
  return sdk as unknown as Anthropic;
}

const baseRequest = {
  systemPrompt: "You are helpful.",
  messages: [
    { role: "user", content: [{ type: "text", text: "hello" }] },
  ] satisfies readonly Message[],
  tools: [
    {
      name: "echo",
      description: "Echoes text back.",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
    },
  ],
  signal: new AbortController().signal,
};

const textOnlyResponse = {
  id: "msg_01abc",
  model: "claude-sonnet-4-5-20251022",
  stop_reason: "end_turn",
  content: [{ type: "text", text: "hi" }],
  usage: { input_tokens: 10, output_tokens: 3 },
};

describe("AnthropicModelClient.complete — GenAI semconv instrumentation", () => {
  let spans: SpanFixture;
  let metrics: MetricFixture;

  beforeEach(() => {
    spans = installSpanFixture();
    metrics = installMetricFixture();
  });

  afterEach(async () => {
    await uninstallSpanFixture();
    await uninstallMetricFixture();
  });

  test("sets gen_ai.* request/response attributes on the active model.call span", async () => {
    const client = new AnthropicModelClient({
      apiKey: "test",
      sdk: fakeSdk(textOnlyResponse),
    });

    await withSpan(SpanName.ModelCall, {}, () => client.complete(baseRequest));

    const modelSpans = spans.spansByName(SpanName.ModelCall);
    expect(modelSpans).toHaveLength(1);
    const s = modelSpans[0];
    expect(s?.attributes[GenAiAttr.OperationName]).toBe("chat");
    expect(s?.attributes[GenAiAttr.ProviderName]).toBe("anthropic");
    expect(s?.attributes[GenAiAttr.RequestModel]).toBe("claude-sonnet-4-5-20251022");
    expect(s?.attributes[GenAiAttr.ResponseModel]).toBe("claude-sonnet-4-5-20251022");
    expect(s?.attributes[GenAiAttr.ResponseId]).toBe("msg_01abc");
    expect(s?.attributes[GenAiAttr.ResponseFinishReasons]).toEqual(["end_turn"]);
    expect(s?.attributes[GenAiAttr.UsageInputTokens]).toBe(10);
    expect(s?.attributes[GenAiAttr.UsageOutputTokens]).toBe(3);
    expect(s?.attributes[GenAiAttr.RequestMaxTokens]).toBeGreaterThan(0);
  });

  test("emits gen_ai.client.inference.operation.details event with messages + tools", async () => {
    const client = new AnthropicModelClient({
      apiKey: "test",
      sdk: fakeSdk(textOnlyResponse),
    });

    await withSpan(SpanName.ModelCall, {}, () => client.complete(baseRequest));

    const s = spans.spansByName(SpanName.ModelCall)[0];
    expect(s).toBeDefined();
    const ev = findEvent(s!, GenAiEvent.InferenceDetails);
    expect(ev).toBeDefined();
    const attrs = ev?.attributes ?? {};
    // Payloads are JSON-stringified so OTLP can carry them on a flat attribute bag.
    expect(typeof attrs["gen_ai.system_instructions"]).toBe("string");
    expect(typeof attrs["gen_ai.input.messages"]).toBe("string");
    expect(typeof attrs["gen_ai.output.messages"]).toBe("string");
    expect(typeof attrs["gen_ai.tool.definitions"]).toBe("string");
    const inputMsgs = JSON.parse(attrs["gen_ai.input.messages"] as string) as unknown[];
    expect(inputMsgs).toHaveLength(1);
    const defs = JSON.parse(attrs["gen_ai.tool.definitions"] as string) as unknown[];
    expect(defs).toHaveLength(1);
  });

  test("records duration histogram and input+output token histograms", async () => {
    const client = new AnthropicModelClient({
      apiKey: "test",
      sdk: fakeSdk(textOnlyResponse),
    });

    await withSpan(SpanName.ModelCall, {}, () => client.complete(baseRequest));

    const rm = await metrics.collect();
    expect(
      histogramCount(rm, "gen_ai.client.operation.duration", {
        [GenAiAttr.OperationName]: "chat",
        [GenAiAttr.ProviderName]: "anthropic",
      }),
    ).toBe(1);
    expect(histogramSum(rm, "gen_ai.client.token.usage", { [GenAiAttr.TokenType]: "input" })).toBe(
      10,
    );
    expect(histogramSum(rm, "gen_ai.client.token.usage", { [GenAiAttr.TokenType]: "output" })).toBe(
      3,
    );
  });

  test("cache token usage surfaced when Anthropic returns cache_* fields", async () => {
    const cacheResponse = {
      ...textOnlyResponse,
      usage: {
        input_tokens: 20,
        output_tokens: 5,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 50,
      },
    };
    const client = new AnthropicModelClient({ apiKey: "test", sdk: fakeSdk(cacheResponse) });

    await withSpan(SpanName.ModelCall, {}, () => client.complete(baseRequest));

    const s = spans.spansByName(SpanName.ModelCall)[0];
    expect(s?.attributes[GenAiAttr.UsageCacheReadInputTokens]).toBe(100);
    expect(s?.attributes[GenAiAttr.UsageCacheCreationInputTokens]).toBe(50);
  });

  test("thinking blocks emit gen_ai.thinking events and are NOT returned to the loop", async () => {
    const thinkingResponse = {
      id: "msg_02def",
      model: "claude-sonnet-4-5-20251022",
      stop_reason: "end_turn",
      content: [
        { type: "thinking", thinking: "Let me reason about this step by step.", signature: "sig1" },
        { type: "text", text: "Final answer" },
      ],
      usage: { input_tokens: 10, output_tokens: 8 },
    };
    const client = new AnthropicModelClient({ apiKey: "test", sdk: fakeSdk(thinkingResponse) });

    const result = await withSpan(SpanName.ModelCall, {}, () => client.complete(baseRequest));
    // Session logic still sees only text + tool_use blocks.
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe("text");

    const s = spans.spansByName(SpanName.ModelCall)[0];
    expect(s?.attributes[GenAiAttr.ThinkingBlockCount]).toBe(1);
    expect(s?.attributes[GenAiAttr.ThinkingBytes]).toBeGreaterThan(0);
    const thinkingEvents = s?.events.filter((e) => e.name === GenAiEvent.Thinking) ?? [];
    expect(thinkingEvents).toHaveLength(1);
    expect(thinkingEvents[0]?.attributes?.["gen_ai.thinking.text"]).toBe(
      "Let me reason about this step by step.",
    );
    expect(thinkingEvents[0]?.attributes?.["gen_ai.thinking.signature"]).toBe("sig1");
    expect(thinkingEvents[0]?.attributes?.["gen_ai.thinking.redacted"]).toBe(false);
  });

  test("redacted_thinking block is recorded without text", async () => {
    const redactedResponse = {
      id: "msg_03",
      model: "claude-sonnet-4-5-20251022",
      stop_reason: "end_turn",
      content: [
        { type: "redacted_thinking", data: "opaque-blob" },
        { type: "text", text: "done" },
      ],
      usage: { input_tokens: 5, output_tokens: 2 },
    };
    const client = new AnthropicModelClient({ apiKey: "test", sdk: fakeSdk(redactedResponse) });

    await withSpan(SpanName.ModelCall, {}, () => client.complete(baseRequest));

    const s = spans.spansByName(SpanName.ModelCall)[0];
    const ev = s?.events.find((e) => e.name === GenAiEvent.Thinking);
    expect(ev).toBeDefined();
    expect(ev?.attributes?.["gen_ai.thinking.redacted"]).toBe(true);
    expect(ev?.attributes?.["gen_ai.thinking.text"]).toBeUndefined();
  });

  test("long content parts are truncated and marked relay.genai.content.truncated", async () => {
    const huge = "x".repeat(50 * 1024); // 50 KiB — well over the 16 KiB cap
    const client = new AnthropicModelClient({ apiKey: "test", sdk: fakeSdk(textOnlyResponse) });

    await withSpan(SpanName.ModelCall, {}, () =>
      client.complete({
        ...baseRequest,
        messages: [{ role: "user", content: [{ type: "text", text: huge }] }],
      }),
    );

    const s = spans.spansByName(SpanName.ModelCall)[0];
    expect(s?.attributes[GenAiAttr.ContentTruncated]).toBe(true);
  });
});
