// InMemoryToolRegistry: a Map-backed registry built from {schema, invoke} pairs.
// Ships with an `echo` built-in for integration tests. Real MCP connectors plug in here (RELAY-11).

import { assert } from "../core/assert.ts";
import type { ToolSchema } from "./model.ts";
import type { ToolInvocationContext, ToolRegistry, ToolResult } from "./tools.ts";
import { notifyToolSchema } from "./builtin-tools.ts";

export type ToolDefinition = {
  readonly schema: ToolSchema;
  readonly invoke: (
    input: Readonly<Record<string, unknown>>,
    ctx: ToolInvocationContext,
    signal: AbortSignal,
  ) => Promise<ToolResult>;
};

export class InMemoryToolRegistry implements ToolRegistry {
  private readonly defs: Map<string, ToolDefinition>;

  public constructor(tools: readonly ToolDefinition[]) {
    this.defs = new Map(tools.map((t) => [t.schema.name, t]));
    assert(this.defs.size === tools.length, "InMemoryToolRegistry: duplicate tool names", {
      count: tools.length,
      unique: this.defs.size,
    });
  }

  public list(): readonly ToolSchema[] {
    return [...this.defs.values()].map((t) => t.schema);
  }

  public async invoke(params: {
    readonly name: string;
    readonly input: Readonly<Record<string, unknown>>;
    readonly ctx: ToolInvocationContext;
    readonly signal: AbortSignal;
  }): Promise<ToolResult> {
    const def = this.defs.get(params.name);
    assert(def !== undefined, "InMemoryToolRegistry.invoke: unknown tool name", {
      name: params.name,
    });
    return def.invoke(params.input, params.ctx, params.signal);
  }
}

// notify is special-cased in dispatchTurn before tools.invoke is ever reached.
// This registration surfaces the schema to tools.list() and acts as a programmer-error
// trap: if invoke is ever reached, dispatchTurn failed to intercept the block.
export const notifyTool: ToolDefinition = {
  schema: notifyToolSchema,
  invoke: () => {
    assert(
      false,
      "notifyTool.invoke: must not be reached — dispatchTurn special-cases notify before invoke",
    );
  },
};

// Built-in echo tool for tests and local development.
export const echoTool: ToolDefinition = {
  schema: {
    name: "echo",
    description: "Returns the input text unchanged",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  invoke: (input) => {
    const text = typeof input["text"] === "string" ? input["text"] : JSON.stringify(input);
    return Promise.resolve({ ok: true as const, content: text });
  },
};
