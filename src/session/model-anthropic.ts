// Thin boundary adapter: maps our Message / ModelResponse types to @anthropic-ai/sdk.
// Prompt caching headers are off by default (RELAY-84). No retry logic (RELAY-85).
// Only call this from production entrypoints; tests inject a fake SDK.

import Anthropic from "@anthropic-ai/sdk";
import type { Span } from "@opentelemetry/api";
import { assert } from "../core/assert.ts";
import { ToolUseId } from "../ids.ts";
import { recordGenAiOperationDuration, recordGenAiTokenUsage } from "../telemetry/genai-metrics.ts";
import { GenAiAttr, GenAiEvent, currentSpan, type Attributes } from "../telemetry/otel.ts";
import {
  MAX_GENAI_CONTENT_BYTES_PER_PART,
  MAX_GENAI_MESSAGES_PER_EVENT,
  MAX_GENAI_THINKING_BYTES_PER_BLOCK,
  MAX_GENAI_TOOL_DEFINITIONS,
  truncateUtf8,
} from "../telemetry/limits.ts";
import type { ModelClient, ToolSchema } from "./model.ts";
import type { ContentBlock, Message, ModelResponse, ModelUsage, StopReason } from "./turn.ts";

const DEFAULT_MODEL = "claude-sonnet-4-5-20251022";
const DEFAULT_MAX_TOKENS = 4096;

type AnthropicMessage = Anthropic.MessageParam;
type AnthropicContent = Anthropic.ContentBlockParam;
type AnthropicTool = Anthropic.Tool;

type ThinkingBlock = {
  readonly type: "thinking";
  readonly thinking: string;
  readonly signature?: string;
};
type RedactedThinkingBlock = { readonly type: "redacted_thinking"; readonly data?: string };
type AnyResponseBlock =
  | Anthropic.TextBlock
  | Anthropic.ToolUseBlock
  | ThinkingBlock
  | RedactedThinkingBlock;

function isThinking(b: AnyResponseBlock): b is ThinkingBlock {
  return b.type === "thinking";
}
function isRedactedThinking(b: AnyResponseBlock): b is RedactedThinkingBlock {
  return b.type === "redacted_thinking";
}

function toAnthropicContent(block: ContentBlock): AnthropicContent {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  if (block.type === "tool_use") {
    return { type: "tool_use", id: block.id, name: block.name, input: block.input };
  }
  const result: Anthropic.ToolResultBlockParam = {
    type: "tool_result",
    tool_use_id: block.toolUseId,
    content: block.content,
  };
  if (block.isError === true) {
    return { ...result, is_error: true };
  }
  return result;
}

function toAnthropicMessage(msg: Message): AnthropicMessage {
  return {
    role: msg.role,
    content: msg.content.map(toAnthropicContent),
  };
}

function toAnthropicTool(schema: ToolSchema): AnthropicTool {
  return {
    name: schema.name,
    ...(schema.description !== undefined ? { description: schema.description } : {}),
    input_schema: schema.inputSchema as Anthropic.Tool.InputSchema,
  };
}

function fromAnthropicContentBlock(
  block: Anthropic.TextBlock | Anthropic.ToolUseBlock,
): ContentBlock {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  const idResult = ToolUseId.parse(block.id);
  assert(idResult.ok, "fromAnthropicContentBlock: invalid tool_use id", { id: block.id });
  return {
    type: "tool_use",
    id: idResult.value,
    name: block.name,
    input: block.input as Readonly<Record<string, unknown>>,
  };
}

function fromAnthropicUsage(usage: Anthropic.Usage): ModelUsage {
  const base: ModelUsage = {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
  };
  const read =
    "cache_read_input_tokens" in usage && typeof usage.cache_read_input_tokens === "number"
      ? usage.cache_read_input_tokens
      : undefined;
  const created =
    "cache_creation_input_tokens" in usage && typeof usage.cache_creation_input_tokens === "number"
      ? usage.cache_creation_input_tokens
      : undefined;
  if (read !== undefined || created !== undefined) {
    return {
      ...base,
      ...(read !== undefined ? { cacheReadInputTokens: read } : {}),
      ...(created !== undefined ? { cacheCreationInputTokens: created } : {}),
    };
  }
  return base;
}

// Look for any key on `usage` matching /thinking/i and returning a numeric count. Anthropic
// has historically exposed thinking tokens under different keys across SDK versions; we
// stay tolerant and only surface the attribute when the provider gives us a number.
function pickThinkingTokens(usage: Anthropic.Usage): number | undefined {
  for (const [k, v] of Object.entries(usage)) {
    if (typeof v !== "number") continue;
    if (/thinking/i.test(k)) return v;
  }
  return undefined;
}

// Serialize a message array to a JSON-stringified payload suitable for a span-event
// attribute, truncating each text part to MAX_GENAI_CONTENT_BYTES_PER_PART. Returns
// the payload and a flag noting whether any part was cut.
function serializeMessages(messages: readonly Message[]): { payload: string; truncated: boolean } {
  let truncated = false;
  const head = messages.slice(0, MAX_GENAI_MESSAGES_PER_EVENT);
  if (head.length < messages.length) truncated = true;
  const serialized = head.map((m) => ({
    role: m.role,
    parts: m.content.map((c) => {
      if (c.type === "text") {
        const t = truncateUtf8(c.text, MAX_GENAI_CONTENT_BYTES_PER_PART);
        if (t.truncated) truncated = true;
        return { type: "text", content: t.text };
      }
      if (c.type === "tool_use") {
        const t = truncateUtf8(JSON.stringify(c.input), MAX_GENAI_CONTENT_BYTES_PER_PART);
        if (t.truncated) truncated = true;
        return { type: "tool_use", id: c.id, name: c.name, input: t.text };
      }
      const t = truncateUtf8(c.content, MAX_GENAI_CONTENT_BYTES_PER_PART);
      if (t.truncated) truncated = true;
      return {
        type: "tool_result",
        toolUseId: c.toolUseId,
        content: t.text,
        ...(c.isError === true ? { isError: true } : {}),
      };
    }),
  }));
  return { payload: JSON.stringify(serialized), truncated };
}

function serializeSystemInstructions(systemPrompt: string): {
  payload: string;
  truncated: boolean;
} {
  const t = truncateUtf8(systemPrompt, MAX_GENAI_CONTENT_BYTES_PER_PART);
  return {
    payload: JSON.stringify([{ type: "text", content: t.text }]),
    truncated: t.truncated,
  };
}

function serializeToolDefinitions(tools: readonly ToolSchema[]): string {
  const head = tools.slice(0, MAX_GENAI_TOOL_DEFINITIONS);
  return JSON.stringify(
    head.map((s) => ({
      name: s.name,
      ...(s.description !== undefined ? { description: s.description } : {}),
      input_schema: s.inputSchema,
    })),
  );
}

function serializeOutputMessage(response: { readonly content: readonly AnyResponseBlock[] }): {
  payload: string;
  truncated: boolean;
} {
  let truncated = false;
  const parts = response.content.map((b) => {
    if (b.type === "text") {
      const t = truncateUtf8(b.text, MAX_GENAI_CONTENT_BYTES_PER_PART);
      if (t.truncated) truncated = true;
      return { type: "text", content: t.text };
    }
    if (b.type === "tool_use") {
      const t = truncateUtf8(JSON.stringify(b.input), MAX_GENAI_CONTENT_BYTES_PER_PART);
      if (t.truncated) truncated = true;
      return { type: "tool_use", id: b.id, name: b.name, input: t.text };
    }
    if (isThinking(b)) {
      const t = truncateUtf8(b.thinking, MAX_GENAI_THINKING_BYTES_PER_BLOCK);
      if (t.truncated) truncated = true;
      return { type: "thinking", content: t.text };
    }
    return { type: "redacted_thinking" };
  });
  return { payload: JSON.stringify([{ role: "assistant", parts }]), truncated };
}

export class AnthropicModelClient implements ModelClient {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;

  public constructor(opts: {
    apiKey: string;
    model?: string;
    maxTokens?: number;
    sdk?: Anthropic;
  }) {
    assert(opts.apiKey.length > 0, "AnthropicModelClient: apiKey must be non-empty");
    this.client = opts.sdk ?? new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model ?? DEFAULT_MODEL;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    assert(this.maxTokens > 0, "AnthropicModelClient: maxTokens must be positive");
  }

  public async complete(params: {
    readonly systemPrompt: string;
    readonly messages: readonly Message[];
    readonly tools: readonly ToolSchema[];
    readonly signal: AbortSignal;
  }): Promise<ModelResponse> {
    const span = currentSpan();
    const metricAttrs: Attributes = {
      [GenAiAttr.OperationName]: "chat",
      [GenAiAttr.ProviderName]: "anthropic",
      [GenAiAttr.RequestModel]: this.model,
    };

    if (span !== undefined) {
      span.setAttributes(metricAttrs);
      span.setAttribute(GenAiAttr.RequestMaxTokens, this.maxTokens);
    }

    const started = performance.now();
    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: this.maxTokens,
          system: params.systemPrompt,
          messages: params.messages.map(toAnthropicMessage),
          tools: params.tools.map(toAnthropicTool),
        },
        { signal: params.signal },
      );
    } catch (e) {
      recordGenAiOperationDuration((performance.now() - started) / 1000, {
        ...metricAttrs,
        [GenAiAttr.ErrorType]: (e as Error).name,
      });
      throw e;
    }
    const elapsedSec = (performance.now() - started) / 1000;

    assert(response.stop_reason !== null, "AnthropicModelClient: stop_reason is null");
    const stopReason = response.stop_reason satisfies StopReason;
    const { content, thinkingBlocks, redactedThinking } = partitionBlocks(response.content);
    const usage = fromAnthropicUsage(response.usage);

    if (span !== undefined) {
      emitResponseOnSpan(
        span,
        params,
        response,
        stopReason,
        usage,
        thinkingBlocks,
        redactedThinking,
      );
    }

    const postAttrs: Attributes = { ...metricAttrs, [GenAiAttr.ResponseModel]: response.model };
    recordGenAiOperationDuration(elapsedSec, postAttrs);
    recordGenAiTokenUsage(usage.inputTokens, "input", postAttrs);
    recordGenAiTokenUsage(usage.outputTokens, "output", postAttrs);

    return { content, stopReason, usage };
  }
}

// Partition response blocks: text/tool_use return to the caller; thinking and
// redacted_thinking are captured for telemetry only (SPEC: session logic is unchanged
// by the presence of thinking blocks). Third-party proxies or future models may emit
// further block types — those fall through and are dropped.
function partitionBlocks(blocks: readonly unknown[]): {
  content: ContentBlock[];
  thinkingBlocks: ThinkingBlock[];
  redactedThinking: RedactedThinkingBlock[];
} {
  const known: (Anthropic.TextBlock | Anthropic.ToolUseBlock)[] = [];
  const thinkingBlocks: ThinkingBlock[] = [];
  const redactedThinking: RedactedThinkingBlock[] = [];
  for (const b of blocks as readonly AnyResponseBlock[]) {
    if (b.type === "text" || b.type === "tool_use") known.push(b);
    else if (isThinking(b)) thinkingBlocks.push(b);
    else if (isRedactedThinking(b)) redactedThinking.push(b);
  }
  return { content: known.map(fromAnthropicContentBlock), thinkingBlocks, redactedThinking };
}

function emitResponseOnSpan(
  span: Span,
  params: {
    readonly systemPrompt: string;
    readonly messages: readonly Message[];
    readonly tools: readonly ToolSchema[];
  },
  response: Anthropic.Message,
  stopReason: StopReason,
  usage: ModelUsage,
  thinkingBlocks: readonly ThinkingBlock[],
  redactedThinking: readonly RedactedThinkingBlock[],
): void {
  const sys = serializeSystemInstructions(params.systemPrompt);
  const input = serializeMessages(params.messages);
  const toolDefs = serializeToolDefinitions(params.tools);
  const output = serializeOutputMessage({
    content: response.content as readonly AnyResponseBlock[],
  });
  span.addEvent(GenAiEvent.InferenceDetails, {
    [GenAiAttr.SystemInstructions]: sys.payload,
    [GenAiAttr.InputMessages]: input.payload,
    [GenAiAttr.OutputMessages]: output.payload,
    [GenAiAttr.ToolDefinitions]: toolDefs,
  });
  if (sys.truncated || input.truncated || output.truncated) {
    span.setAttribute(GenAiAttr.ContentTruncated, true);
  }

  let totalThinkingBytes = 0;
  thinkingBlocks.forEach((t, i) => {
    const tr = truncateUtf8(t.thinking, MAX_GENAI_THINKING_BYTES_PER_BLOCK);
    totalThinkingBytes += tr.bytes;
    span.addEvent(GenAiEvent.Thinking, {
      [GenAiAttr.ThinkingIndex]: i,
      [GenAiAttr.ThinkingBlockBytes]: tr.bytes,
      [GenAiAttr.ThinkingRedacted]: false,
      [GenAiAttr.ThinkingText]: tr.text,
      ...(t.signature !== undefined ? { [GenAiAttr.ThinkingSignature]: t.signature } : {}),
      ...(tr.truncated ? { [GenAiAttr.ThinkingTruncated]: true } : {}),
    });
  });
  redactedThinking.forEach((_, i) => {
    span.addEvent(GenAiEvent.Thinking, {
      [GenAiAttr.ThinkingIndex]: thinkingBlocks.length + i,
      [GenAiAttr.ThinkingRedacted]: true,
    });
  });
  const totalThinkingBlocks = thinkingBlocks.length + redactedThinking.length;
  if (totalThinkingBlocks > 0) {
    span.setAttribute(GenAiAttr.ThinkingBlockCount, totalThinkingBlocks);
    span.setAttribute(GenAiAttr.ThinkingBytes, totalThinkingBytes);
  }

  span.setAttribute(GenAiAttr.ResponseModel, response.model);
  span.setAttribute(GenAiAttr.ResponseId, response.id);
  span.setAttribute(GenAiAttr.ResponseFinishReasons, [stopReason]);
  span.setAttribute(GenAiAttr.UsageInputTokens, usage.inputTokens);
  span.setAttribute(GenAiAttr.UsageOutputTokens, usage.outputTokens);
  if (usage.cacheReadInputTokens !== undefined) {
    span.setAttribute(GenAiAttr.UsageCacheReadInputTokens, usage.cacheReadInputTokens);
  }
  if (usage.cacheCreationInputTokens !== undefined) {
    span.setAttribute(GenAiAttr.UsageCacheCreationInputTokens, usage.cacheCreationInputTokens);
  }
  const thinkingTokens = pickThinkingTokens(response.usage);
  if (thinkingTokens !== undefined) {
    span.setAttribute(GenAiAttr.UsageThinkingTokens, thinkingTokens);
  }
}
