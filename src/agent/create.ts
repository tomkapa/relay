// Domain function for agent creation. Wraps the INSERT in sql.begin so future
// multi-statement inserts (seed memory, initial tasks) land atomically.
// See SPEC §Agent creation and CLAUDE.md §3, §6, §10.

import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { assert } from "../core/assert.ts";
import type { Clock } from "../core/clock.ts";
import { err, ok, type Result } from "../core/result.ts";
import { AgentId, type AgentId as AgentIdBrand } from "../ids.ts";
import { Attr, SpanName, withSpan } from "../telemetry/otel.ts";
import { MAX_SYSTEM_PROMPT_LEN } from "./limits.ts";
import { type AgentParseError, type AgentCreateSpec } from "./parse.ts";

export type AgentCreateError = AgentParseError | { kind: "db_conflict"; detail: string };

// Minimal JSON-safe type accepted by postgres.js sql.json(). ToolDescriptor uses an
// `unknown` index signature that TypeScript cannot prove is JSON-safe, so we go
// through `unknown` once per call site to make the cross-type cast explicit.
type DbJson =
  | null
  | string
  | number
  | boolean
  | readonly DbJson[]
  | { readonly [k: string]: DbJson };

export async function createAgent(
  sql: Sql,
  clock: Clock,
  spec: AgentCreateSpec,
): Promise<Result<{ id: AgentIdBrand; createdAt: Date }, AgentCreateError>> {
  // Mint the ID before the span so the span attribute can include it immediately.
  const idRaw = randomUUID();
  const parsedId = AgentId.parse(idRaw);
  assert(parsedId.ok, "createAgent: randomUUID produced invalid id", { raw: idRaw });
  const id = parsedId.value;

  assert(spec.systemPrompt.length > 0, "createAgent: spec invariant: systemPrompt non-empty", {
    length: spec.systemPrompt.length,
  });
  assert(
    spec.systemPrompt.length <= MAX_SYSTEM_PROMPT_LEN,
    "createAgent: spec invariant: systemPrompt within MAX_SYSTEM_PROMPT_LEN",
    { length: spec.systemPrompt.length, max: MAX_SYSTEM_PROMPT_LEN },
  );

  const createdAt = new Date(clock.now());

  return withSpan(
    SpanName.AgentCreate,
    { [Attr.TenantId]: spec.tenantId, [Attr.AgentId]: id },
    async () => {
      try {
        await sql.begin(async (tx) => {
          await tx`
            INSERT INTO agents (id, tenant_id, system_prompt, tool_set, hook_rules, created_at, updated_at)
            VALUES (
              ${id},
              ${spec.tenantId},
              ${spec.systemPrompt},
              ${tx.json(spec.toolSet as unknown as DbJson)},
              ${tx.json(spec.hookRules as unknown as DbJson)},
              ${createdAt},
              ${createdAt}
            )
          `;
          // Extension point: seed_memory and initial_scheduled_tasks inserts land HERE
          // when their insertion paths exist. Do not pull tx out of this function.
        });
        return ok({ id, createdAt });
      } catch (e) {
        if (isUniqueViolation(e)) {
          return err({ kind: "db_conflict", detail: getDetail(e) });
        }
        throw e;
      }
    },
  );
}

function isUniqueViolation(e: unknown): boolean {
  if (typeof e !== "object" || e === null || !("code" in e)) return false;
  const pg = e as Record<string, unknown>;
  return pg["code"] === "23505";
}

function getDetail(e: unknown): string {
  if (typeof e === "object" && e !== null) {
    const pg = e as { detail?: string; message?: string };
    return pg.detail ?? pg.message ?? "unique constraint violation";
  }
  return "unique constraint violation";
}
