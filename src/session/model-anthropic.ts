// Thin boundary adapter: maps our Message / ModelResponse types to @anthropic-ai/sdk.
// Prompt caching headers are off by default (RELAY-84). No retry logic (RELAY-85).
// Only call this from production entrypoints; tests use fake ModelClient implementations.

import Anthropic from "@anthropic-ai/sdk";
import { assert } from "../core/assert.ts";
import type { ModelClient, ToolSchema } from "./model.ts";
import type {
  ContentBlock,
  Message,
  ModelResponse,
  ModelUsage,
  StopReason,
  TextBlock,
  ToolUseBlock,
} from "./turn.ts";

const DEFAULT_MODEL = "claude-sonnet-4-5-20251022";
const DEFAULT_MAX_TOKENS = 4096;

type AnthropicMessage = Anthropic.MessageParam;
type AnthropicContent = Anthropic.ContentBlockParam;
type AnthropicTool = Anthropic.Tool;

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

function fromAnthropicContentBlock(block: Anthropic.ContentBlock): ContentBlock {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  if (block.type === "tool_use") {
    return {
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: block.input as Readonly<Record<string, unknown>>,
    };
  }
  assert(false, "fromAnthropicContentBlock: unexpected block type", { type: block.type });
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

export class AnthropicModelClient implements ModelClient {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;

  public constructor(opts: { apiKey: string; model?: string; maxTokens?: number }) {
    assert(opts.apiKey.length > 0, "AnthropicModelClient: apiKey must be non-empty");
    this.client = new Anthropic({ apiKey: opts.apiKey });
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
    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: this.maxTokens,
        system: params.systemPrompt,
        messages: params.messages.map(toAnthropicMessage),
        tools: params.tools.map(toAnthropicTool),
      },
      { signal: params.signal },
    );

    assert(response.stop_reason !== null, "AnthropicModelClient: stop_reason is null");
    const stopReason = response.stop_reason satisfies StopReason;

    // Anthropic never returns tool_result blocks in assistant content, but filter defensively.
    const content = response.content
      .map(fromAnthropicContentBlock)
      .filter((b): b is TextBlock | ToolUseBlock => b.type === "text" || b.type === "tool_use");

    return { content, stopReason, usage: fromAnthropicUsage(response.usage) };
  }
}
