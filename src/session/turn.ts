// Turn-level types: content blocks, messages, model response, and error union.
// One error union per boundary (CLAUDE.md §12). Exhaustive switch at the worker harness.

import type { TurnId } from "../ids.ts";

export type TextBlock = { readonly type: "text"; readonly text: string };
export type ToolUseBlock = {
  readonly type: "tool_use";
  readonly id: string; // not branded — reused as tool_call_id in RELAY-74
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
};
export type ToolResultBlock = {
  readonly type: "tool_result";
  readonly toolUseId: string;
  readonly content: string; // JSON-stringified output, or error text when isError
  readonly isError?: boolean;
};
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export type Message =
  | { readonly role: "user"; readonly content: readonly ContentBlock[] }
  | { readonly role: "assistant"; readonly content: readonly ContentBlock[] };

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";

export type ModelUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
};

export type ModelResponse = {
  readonly content: readonly ContentBlock[];
  readonly stopReason: StopReason;
  readonly usage: ModelUsage;
};

export type Turn = {
  readonly id: TurnId;
  readonly index: number; // 0-based within the session
  readonly startedAt: Date;
  readonly completedAt: Date;
  readonly response: ModelResponse;
  readonly toolResults: readonly ToolResultBlock[];
};

export type TurnLoopError =
  | { kind: "model_call_failed"; detail: string }
  | { kind: "tool_invocation_failed"; toolName: string; toolUseId: string; detail: string }
  | { kind: "tool_unknown"; toolName: string }
  | { kind: "turn_cap_exceeded"; max: number }
  | { kind: "timeout"; stage: "model" | "tool" }
  | { kind: "persist_turn_failed"; detail: string };
