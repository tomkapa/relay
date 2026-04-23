// Unit tests for handleSessionStart helpers. Pure function tests that do not require
// a real database. Handler control-flow tests (loop invocation, close-on-end-turn, etc.)
// live in test/integration/trigger/handlers.test.ts per CLAUDE.md §3.

import { describe, expect, test } from "bun:test";
import { AssertionError } from "../../../src/core/assert.ts";
import { openingContextToLoopInput } from "../../../src/trigger/handlers.ts";
import type { TranscriptEntry } from "../../../src/session/transcript.ts";

function systemEntry(content: string): TranscriptEntry {
  return { role: "system", content };
}

function userEntry(content: string): TranscriptEntry {
  return { role: "user", content };
}

describe("openingContextToLoopInput", () => {
  test("message context: extracts single user message with correct text", () => {
    const context: readonly TranscriptEntry[] = [
      systemEntry("You are helpful."),
      userEntry("Hello from the user"),
    ];
    const result = openingContextToLoopInput(context, "You are helpful.");
    expect(result.systemPrompt).toBe("You are helpful.");
    expect(result.initialMessages).toHaveLength(1);
    const msg = result.initialMessages[0];
    expect(msg?.role).toBe("user");
    expect(msg?.content).toHaveLength(1);
    const block = msg?.content[0];
    expect(block?.type).toBe("text");
    if (block?.type === "text") expect(block.text).toBe("Hello from the user");
  });

  test("event context: extracts user message with rendered event text", () => {
    const rendered = 'Event from github: {"action":"push"}';
    const context: readonly TranscriptEntry[] = [systemEntry("Agent prompt."), userEntry(rendered)];
    const result = openingContextToLoopInput(context, "Agent prompt.");
    expect(result.initialMessages).toHaveLength(1);
    const block = result.initialMessages[0]?.content[0];
    if (block?.type === "text") expect(block.text).toBe(rendered);
  });

  test("task_fire context: extracts user message with rendered task intent", () => {
    const rendered = "Scheduled task fired at 2025-01-01T00:00:00.000Z: Run weekly digest";
    const context: readonly TranscriptEntry[] = [systemEntry("Agent prompt."), userEntry(rendered)];
    const result = openingContextToLoopInput(context, "Agent prompt.");
    const block = result.initialMessages[0]?.content[0];
    if (block?.type === "text") expect(block.text).toBe(rendered);
  });

  test("systemPrompt in result comes from parameter, not context entry", () => {
    const context: readonly TranscriptEntry[] = [
      systemEntry("Context system prompt"),
      userEntry("User says hi"),
    ];
    const result = openingContextToLoopInput(context, "Override system prompt");
    expect(result.systemPrompt).toBe("Override system prompt");
  });

  test("assertion fires on empty context", () => {
    expect(() => openingContextToLoopInput([], "sys")).toThrow(AssertionError);
  });

  test("assertion fires on context with only system entry (no user entry)", () => {
    const context: readonly TranscriptEntry[] = [systemEntry("sys")];
    expect(() => openingContextToLoopInput(context, "sys")).toThrow(AssertionError);
  });

  test("assertion fires when first entry is not system role", () => {
    const context: readonly TranscriptEntry[] = [userEntry("wrong first"), userEntry("second")];
    expect(() => openingContextToLoopInput(context, "sys")).toThrow(AssertionError);
  });

  test("assertion fires when a non-first entry has non-user role", () => {
    const assistant: TranscriptEntry = { role: "assistant", content: "I replied" };
    const context: readonly TranscriptEntry[] = [systemEntry("sys"), assistant];
    expect(() => openingContextToLoopInput(context, "sys")).toThrow(AssertionError);
  });
});
