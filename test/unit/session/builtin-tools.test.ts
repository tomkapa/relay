// Unit tests for builtin tool schemas and input parsers. RELAY-144.

import { describe, expect, test } from "bun:test";
import {
  parseAskInput,
  parseNotifyInput,
  askToolSchema,
  notifyToolSchema,
} from "../../../src/session/builtin-tools.ts";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("parseAskInput", () => {
  test("valid input returns parsed ask", () => {
    const r = parseAskInput({ target_agent_id: VALID_UUID, content: "Hello, can you help?" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe("ask");
    expect(r.value.targetAgentId as string).toBe(VALID_UUID);
    expect(r.value.content).toBe("Hello, can you help?");
  });

  test("missing target_agent_id returns validation_failed", () => {
    const r = parseAskInput({ content: "Hi" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("validation_failed");
  });

  test("invalid UUID for target_agent_id returns validation_failed (Zod catches it)", () => {
    const r = parseAskInput({ target_agent_id: "not-a-uuid", content: "Hi" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // z.uuid() validation fires before AgentId.parse, so the error is validation_failed.
    expect(r.error.kind).toBe("validation_failed");
  });

  test("empty content returns validation_failed", () => {
    const r = parseAskInput({ target_agent_id: VALID_UUID, content: "" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("validation_failed");
  });

  test("missing content returns validation_failed", () => {
    const r = parseAskInput({ target_agent_id: VALID_UUID });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("validation_failed");
  });
});

describe("parseNotifyInput", () => {
  test("valid input returns parsed notify", () => {
    const r = parseNotifyInput({ target_agent_id: VALID_UUID, content: "FYI: done" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe("notify");
    expect(r.value.targetAgentId as string).toBe(VALID_UUID);
    expect(r.value.content).toBe("FYI: done");
  });

  test("missing target_agent_id returns validation_failed", () => {
    const r = parseNotifyInput({ content: "Done" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("validation_failed");
  });

  test("malformed UUID for target_agent_id returns validation_failed", () => {
    const r = parseNotifyInput({ target_agent_id: "not-a-uuid", content: "hello" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("validation_failed");
  });

  test("empty content returns validation_failed", () => {
    const r = parseNotifyInput({ target_agent_id: VALID_UUID, content: "" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("validation_failed");
  });

  test("missing content returns validation_failed", () => {
    const r = parseNotifyInput({ target_agent_id: VALID_UUID });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("validation_failed");
  });
});

describe("askToolSchema", () => {
  test("name is 'ask'", () => {
    expect(askToolSchema.name).toBe("ask");
  });

  test("schema has required fields", () => {
    const { inputSchema } = askToolSchema;
    const props = inputSchema["properties"] as Record<string, unknown>;
    expect(props).toHaveProperty("target_agent_id");
    expect(props).toHaveProperty("content");
    expect(inputSchema["required"]).toContain("target_agent_id");
    expect(inputSchema["required"]).toContain("content");
  });
});

describe("notifyToolSchema", () => {
  test("name is 'notify'", () => {
    expect(notifyToolSchema.name).toBe("notify");
  });

  test("schema has required fields", () => {
    const { inputSchema } = notifyToolSchema;
    expect(inputSchema["required"]).toContain("target_agent_id");
    expect(inputSchema["required"]).toContain("content");
  });
});
