import { Hono } from "hono";
import type { Sql } from "postgres";
import { assertNever } from "../../core/assert.ts";
import type { Clock } from "../../core/clock.ts";
import type { EmbeddingClient } from "../../memory/embedding.ts";
import { createAgent, type AgentCreateError } from "../../agent/create.ts";
import { parseAgentCreate } from "../../agent/parse.ts";
import { Attr, emit } from "../../telemetry/otel.ts";

export function agentsRoute(deps: { sql: Sql; clock: Clock; embedder: EmbeddingClient }): Hono {
  const app = new Hono();

  app.post("/agents", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (e) {
      // Only catch actual JSON parse errors (SyntaxError). Any other thrown value
      // (in particular BodyLimitError from the bodyLimit middleware's stream) must
      // propagate so the middleware can override the response with 413.
      if (!(e instanceof SyntaxError)) throw e;
      return c.json(
        {
          error: {
            kind: "validation_failed",
            issues: [{ path: "", message: "invalid JSON body" }],
          },
        },
        400,
      );
    }

    const parseResult = parseAgentCreate(raw);
    if (!parseResult.ok) {
      return c.json({ error: parseResult.error }, agentCreateErrorStatus(parseResult.error));
    }

    const spec = parseResult.value;
    emit("INFO", "agent.create.requested", { [Attr.TenantId]: spec.tenantId });

    const createResult = await createAgent(deps.sql, deps.clock, deps.embedder, spec);
    if (!createResult.ok) {
      return c.json({ error: createResult.error }, agentCreateErrorStatus(createResult.error));
    }

    const { id, createdAt } = createResult.value;
    return c.json({ id, createdAt }, 201);
  });

  return app;
}

// Exported for unit-testing the mapping in isolation (test/unit/http/error-mapping.test.ts).
export function agentCreateErrorStatus(error: AgentCreateError): 400 | 403 | 409 | 422 | 503 | 504 {
  switch (error.kind) {
    case "validation_failed":
    case "system_prompt_too_long":
    case "tool_set_too_large":
    case "hook_rules_too_large":
    case "tenant_id_invalid":
    case "seed_memory_too_large":
    case "seed_memory_text_too_long":
      return 400;
    case "db_conflict":
      return 409;
    case "hook_denied":
      return 403;
    case "embed_permanent":
      return 422;
    case "embed_transient":
      return 503;
    case "embed_timeout":
      return 504;
    default:
      assertNever(error);
  }
}
