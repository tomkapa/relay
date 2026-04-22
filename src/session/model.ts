// ModelClient seam: the turn loop depends on this interface, not on @anthropic-ai/sdk directly.
// AnthropicModelClient is the production implementation (model-anthropic.ts); tests use fakes.

import type { Message, ModelResponse } from "./turn.ts";

export type ToolSchema = {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>; // JSON Schema object
};

export interface ModelClient {
  complete(params: {
    readonly systemPrompt: string;
    readonly messages: readonly Message[];
    readonly tools: readonly ToolSchema[];
    readonly signal: AbortSignal;
  }): Promise<ModelResponse>;
}
