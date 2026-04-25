// Domain function for agent creation. Wraps all writes in sql.begin so the agent row,
// seed memories, and hook audit rows land atomically. A deny rolls back the entire creation.
// See SPEC §Agent creation and CLAUDE.md §3, §6, §10.

import type { Sql, TransactionSql } from "postgres";
import { assert } from "../core/assert.ts";
import type { Clock } from "../core/clock.ts";
import { idempotencyKeyForAgentSeed } from "../core/idempotency.ts";
import { err, ok, type Result } from "../core/result.ts";
import type { DbJson } from "../db/utils.ts";
import { HOOK_EVENT } from "../hook/types.ts";
import { runHooks } from "../hook/run.ts";
import { snapshotHookConfig } from "../hook/snapshot.ts";
import { AgentId, mintId, type AgentId as AgentIdBrand } from "../ids.ts";
import type { EmbedError, EmbeddingClient } from "../memory/embedding.ts";
import { insertMemory } from "../memory/insert.ts";
import { MemoryKind } from "../memory/kind.ts";
import { EMBEDDING_CALL_TIMEOUT_MS } from "../memory/limits.ts";
import { Attr, SpanName, withSpan } from "../telemetry/otel.ts";
import { MAX_SEED_MEMORIES, MAX_SYSTEM_PROMPT_LEN } from "./limits.ts";
import { type AgentParseError, type AgentCreateSpec, type SeedMemorySpec } from "./parse.ts";

// Sentinel thrown inside sql.begin to trigger rollback with a hook_denied result. Never exported.
class HookDenySentinel extends Error {
  public readonly reason: string;
  public constructor(reason: string) {
    super("hook_deny");
    this.reason = reason;
  }
}

export type AgentCreateError =
  | AgentParseError
  | { kind: "db_conflict"; detail: string }
  | { kind: "hook_denied"; reason: string }
  | { kind: "embed_transient"; message: string }
  | { kind: "embed_permanent"; message: string }
  | { kind: "embed_timeout"; elapsedMs: number };

const kindResult = MemoryKind.parse("event");
assert(kindResult.ok, "createAgent: MemoryKind.parse('event') failed at module load");
const EVENT_KIND = kindResult.value;

function mapEmbedError(e: EmbedError): AgentCreateError {
  switch (e.kind) {
    case "transient":
      return { kind: "embed_transient", message: e.message };
    case "permanent":
      return { kind: "embed_permanent", message: e.message };
    case "timeout":
      return { kind: "embed_timeout", elapsedMs: e.elapsedMs };
    case "input_too_long":
      // Pre-checked at parse boundary; arriving here means limits diverged — programmer bug.
      assert(false, "createAgent: embed input_too_long after parse check", {
        bytes: e.bytes,
        max: e.max,
      });
  }
}

// Embed each seed memory outside the transaction: embedding is a network I/O call;
// holding sql.begin open across it pins a Postgres connection for the full round-trip.
async function embedSeedMemories(
  embedder: EmbeddingClient,
  seedMemories: readonly SeedMemorySpec[],
): Promise<Result<Float32Array[], AgentCreateError>> {
  assert(
    seedMemories.length <= MAX_SEED_MEMORIES,
    "embedSeedMemories: seedMemories exceeds MAX_SEED_MEMORIES",
    { count: seedMemories.length, max: MAX_SEED_MEMORIES },
  );
  const embeddings: Float32Array[] = [];
  for (const entry of seedMemories) {
    const signal = AbortSignal.timeout(EMBEDDING_CALL_TIMEOUT_MS);
    const result = await embedder.embed(entry.text, signal);
    if (!result.ok) return err(mapEmbedError(result.error));
    embeddings.push(result.value);
  }
  return ok(embeddings);
}

async function insertAgentRow(
  tx: TransactionSql,
  id: AgentIdBrand,
  spec: AgentCreateSpec,
  createdAt: Date,
): Promise<void> {
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
}

async function insertSeedMemories(
  tx: TransactionSql,
  id: AgentIdBrand,
  spec: AgentCreateSpec,
  embeddings: Float32Array[],
): Promise<void> {
  for (let i = 0; i < spec.seedMemory.length; i++) {
    const entry = spec.seedMemory[i];
    const embedding = embeddings[i];
    assert(entry !== undefined, "insertSeedMemories: entry undefined at valid index");
    assert(embedding !== undefined, "insertSeedMemories: embedding undefined at valid index");

    const r = await insertMemory(tx, {
      agentId: id,
      tenantId: spec.tenantId,
      kind: EVENT_KIND,
      text: entry.text,
      embedding,
      importance: entry.importance,
      idempotencyKey: idempotencyKeyForAgentSeed({ agentId: id, index: i }),
    });
    // tenant_mismatch / agent_not_found are impossible — same tx, just-created agent.
    assert(r.ok, "insertSeedMemories: insertMemory failed unexpectedly");
  }
}

export async function createAgent(
  sql: Sql,
  clock: Clock,
  embedder: EmbeddingClient,
  spec: AgentCreateSpec,
): Promise<Result<{ id: AgentIdBrand; createdAt: Date }, AgentCreateError>> {
  const id = mintId(AgentId.parse, "createAgent");

  assert(spec.systemPrompt.length > 0, "createAgent: spec invariant: systemPrompt non-empty", {
    length: spec.systemPrompt.length,
  });
  assert(
    spec.systemPrompt.length <= MAX_SYSTEM_PROMPT_LEN,
    "createAgent: spec invariant: systemPrompt within MAX_SYSTEM_PROMPT_LEN",
    { length: spec.systemPrompt.length, max: MAX_SYSTEM_PROMPT_LEN },
  );

  return withSpan(
    SpanName.AgentCreate,
    { [Attr.TenantId]: spec.tenantId, [Attr.AgentId]: id },
    async () => {
      const createdAt = new Date(clock.now());
      const embeddingsResult = await embedSeedMemories(embedder, spec.seedMemory);
      if (!embeddingsResult.ok) return embeddingsResult;

      const hookConfig = snapshotHookConfig(clock);

      try {
        await sql.begin(async (tx) => {
          await insertAgentRow(tx, id, spec, createdAt);
          await insertSeedMemories(tx, id, spec, embeddingsResult.value);

          const aggregate = await runHooks(
            tx,
            clock,
            hookConfig,
            {
              tenantId: spec.tenantId,
              agentId: id,
              sessionId: null,
              turnId: null,
              toolName: null,
              event: HOOK_EVENT.AgentCreate,
            },
            {
              tenantId: spec.tenantId,
              agentId: id,
              systemPromptLen: spec.systemPrompt.length,
              toolSetSize: spec.toolSet.length,
              hookRulesSize: spec.hookRules.length,
              seedMemoryCount: spec.seedMemory.length,
            },
          );

          if (aggregate.decision === "deny") throw new HookDenySentinel(aggregate.reason);
          // modify is meaningless on agent_create (no payload to chain): accept as approve.
        });
        return ok({ id, createdAt });
      } catch (e) {
        if (e instanceof HookDenySentinel) return err({ kind: "hook_denied", reason: e.reason });
        if (isUniqueViolation(e)) return err({ kind: "db_conflict", detail: getDetail(e) });
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
