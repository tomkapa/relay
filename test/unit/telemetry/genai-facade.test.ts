// Smoke tests for the new GenAiAttr/GenAiEvent constants + the test-tracer facade.
// These verify that withSpan() routes through _setTracerForTest, which subsequent
// model-anthropic and embedding-openai tests rely on.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SpanStatusCode } from "@opentelemetry/api";
import { GenAiAttr, GenAiEvent, SpanName, withSpan } from "../../../src/telemetry/otel.ts";
import { installSpanFixture, uninstallSpanFixture, type SpanFixture } from "../../helpers/spans.ts";

describe("GenAiAttr constants", () => {
  test("spec-defined attribute names are stable", () => {
    expect(GenAiAttr.OperationName).toBe("gen_ai.operation.name");
    expect(GenAiAttr.ProviderName).toBe("gen_ai.provider.name");
    expect(GenAiAttr.RequestModel).toBe("gen_ai.request.model");
    expect(GenAiAttr.ResponseFinishReasons).toBe("gen_ai.response.finish_reasons");
    expect(GenAiAttr.UsageInputTokens).toBe("gen_ai.usage.input_tokens");
    expect(GenAiAttr.UsageOutputTokens).toBe("gen_ai.usage.output_tokens");
    expect(GenAiAttr.ConversationId).toBe("gen_ai.conversation.id");
    expect(GenAiAttr.TokenType).toBe("gen_ai.token.type");
  });

  test("relay-local thinking keys are under relay.genai.*", () => {
    expect(GenAiAttr.ThinkingBlockCount).toBe("relay.genai.thinking.block_count");
    expect(GenAiAttr.ThinkingBytes).toBe("relay.genai.thinking.bytes");
    expect(GenAiAttr.ContentTruncated).toBe("relay.genai.content.truncated");
  });
});

describe("GenAiEvent constants", () => {
  test("event names are stable", () => {
    expect(GenAiEvent.InferenceDetails).toBe("gen_ai.client.inference.operation.details");
    expect(GenAiEvent.Thinking).toBe("gen_ai.thinking");
    expect(GenAiEvent.ToolCallArguments).toBe("gen_ai.tool.call.arguments");
    expect(GenAiEvent.ToolCallResult).toBe("gen_ai.tool.call.result");
  });
});

describe("_setTracerForTest + withSpan", () => {
  let fixture: SpanFixture;

  beforeEach(() => {
    fixture = installSpanFixture();
  });

  afterEach(async () => {
    await uninstallSpanFixture();
  });

  test("withSpan records spans to the installed test tracer", async () => {
    await withSpan(SpanName.ModelCall, { foo: "bar" }, (span) => {
      span.setAttribute(GenAiAttr.OperationName, "chat");
      span.addEvent(GenAiEvent.Thinking, { "relay.genai.thinking.bytes": 42 });
      return Promise.resolve();
    });

    const recorded = fixture.spansByName(SpanName.ModelCall);
    expect(recorded).toHaveLength(1);
    const s = recorded[0];
    expect(s?.attributes["foo"]).toBe("bar");
    expect(s?.attributes[GenAiAttr.OperationName]).toBe("chat");
    expect(s?.events.some((e) => e.name === GenAiEvent.Thinking)).toBe(true);
    expect(s?.status.code).toBe(SpanStatusCode.UNSET);
  });

  test("withSpan records exception + ERROR status on throw (CLAUDE.md §6)", async () => {
    let caught: unknown;
    try {
      await withSpan(SpanName.ModelCall, {}, () => Promise.reject(new Error("boom")));
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toBe("boom");

    const recorded = fixture.spansByName(SpanName.ModelCall);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.status.code).toBe(SpanStatusCode.ERROR);
    expect(recorded[0]?.events.some((e) => e.name === "exception")).toBe(true);
  });
});
