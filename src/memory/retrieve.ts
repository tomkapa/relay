// Two-stage memory retrieval: ANN candidate fetch (SQL, HNSW-served) → app-side re-rank.
// See RELAY-131 and SPEC §Memory for the scoring formula and tunable design.

import type { Sql } from "postgres";
import { assert } from "../core/assert.ts";
import type { Clock } from "../core/clock.ts";
import { err, ok, type Result } from "../core/result.ts";
import { firstRow } from "../db/utils.ts";
import {
  MemoryId as MemoryIdParser,
  type AgentId,
  type CandidatePool,
  type MemoryId,
  type RetrievalK,
  type TenantId,
} from "../ids.ts";
import { Attr, SpanName, counter, withSpan } from "../telemetry/otel.ts";
import { MemoryKind as MemoryKindParser, type MemoryKind } from "./kind.ts";
import { DEFAULT_RETRIEVAL_CANDIDATES, EMBEDDING_DIM, HNSW_EF_SEARCH_FLOOR } from "./limits.ts";

export type RetrieveMemoryInput = {
  readonly agentId: AgentId;
  readonly tenantId: TenantId;
  readonly queryEmbed: Float32Array; // .length === EMBEDDING_DIM (asserted)
  readonly k: RetrievalK;
  readonly candidatePool?: CandidatePool; // defaults to DEFAULT_RETRIEVAL_CANDIDATES
};

export type RankedMemory = {
  readonly id: MemoryId;
  readonly text: string;
  readonly kind: MemoryKind;
  readonly importance: number;
  readonly createdAt: Date;
  readonly similarity: number; // [0, 1] — cosine
  readonly recencyFactor: number; // exp(-age_days / half_life_days)
  readonly scaledImportance: number; // importance ^ alpha
  readonly score: number; // similarity * scaledImportance * recencyFactor
};

export type RetrieveMemoryError = { kind: "agent_not_found"; agentId: AgentId };

type AgentDbRow = {
  readonly memory_alpha: number;
  readonly memory_half_life_days: number;
};

type CandidateDbRow = {
  readonly id: string;
  readonly text: string;
  readonly kind: string;
  readonly importance: number;
  readonly created_at: Date;
  readonly similarity: number;
};

type CandidateRow = {
  readonly id: MemoryId;
  readonly text: string;
  readonly kind: MemoryKind;
  readonly importance: number;
  readonly createdAt: Date;
  readonly similarity: number;
};

function mapCandidateRow(r: CandidateDbRow): CandidateRow {
  const idResult = MemoryIdParser.parse(r.id);
  assert(idResult.ok, "retrieveMemory: invalid memory id from DB", { id: r.id });
  const kindResult = MemoryKindParser.parse(r.kind);
  assert(kindResult.ok, "retrieveMemory: invalid memory kind from DB", { kind: r.kind });
  return {
    id: idResult.value,
    text: r.text,
    kind: kindResult.value,
    importance: r.importance,
    createdAt: r.created_at,
    similarity: r.similarity,
  };
}

export function scoreCandidates(
  candidates: readonly CandidateRow[],
  alpha: number,
  halfLifeDays: number,
  now: Date,
): RankedMemory[] {
  assert(alpha >= 0, "scoreCandidates: alpha must be non-negative", { alpha });
  assert(halfLifeDays > 0, "scoreCandidates: halfLifeDays must be positive", { halfLifeDays });
  const MS_PER_DAY = 86_400_000;
  return candidates
    .map((c) => {
      const ageDays = Math.max(0, (now.getTime() - c.createdAt.getTime()) / MS_PER_DAY);
      const recencyFactor = Math.exp(-ageDays / halfLifeDays);
      const scaledImportance = Math.pow(c.importance, alpha);
      const score = c.similarity * scaledImportance * recencyFactor;
      return { ...c, recencyFactor, scaledImportance, score };
    })
    .sort((a, b) => b.score - a.score);
}

export async function retrieveMemory(
  sql: Sql,
  clock: Clock,
  input: RetrieveMemoryInput,
): Promise<Result<readonly RankedMemory[], RetrieveMemoryError>> {
  const pool =
    (input.candidatePool as unknown as number | undefined) ?? DEFAULT_RETRIEVAL_CANDIDATES;
  const k = input.k as unknown as number;
  const efSearch = Math.max(pool, HNSW_EF_SEARCH_FLOOR);

  return withSpan(
    SpanName.MemoryRetrieve,
    {
      [Attr.AgentId]: input.agentId,
      [Attr.TenantId]: input.tenantId,
      [Attr.MemoryK]: k,
      [Attr.MemoryCandidatePool]: pool,
      [Attr.MemoryEfSearch]: efSearch,
    },
    async (span) => {
      assert(
        input.queryEmbed.length === EMBEDDING_DIM,
        "retrieveMemory: embedding dimension mismatch",
        { got: input.queryEmbed.length, expected: EMBEDDING_DIM },
      );
      assert(input.queryEmbed.every(Number.isFinite), "retrieveMemory: non-finite embedding value");

      const vecLit = `[${input.queryEmbed.join(",")}]`;

      return sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL hnsw.ef_search = ${efSearch.toString()}`);

        const agentRows = await tx<AgentDbRow[]>`
          SELECT memory_alpha, memory_half_life_days
            FROM agents
           WHERE id = ${input.agentId} AND tenant_id = ${input.tenantId}
        `;
        assert(agentRows.length <= 1, "retrieveMemory: multiple agents for id/tenant", {
          agentId: input.agentId,
        });
        if (agentRows.length === 0) {
          return err({ kind: "agent_not_found", agentId: input.agentId });
        }
        const agentRow = firstRow(agentRows, "retrieveMemory.agent");
        const alpha: number = agentRow.memory_alpha;
        const halfLifeDays: number = agentRow.memory_half_life_days;
        span.setAttributes({ [Attr.MemoryAlpha]: alpha, [Attr.MemoryHalfLifeDays]: halfLifeDays });

        const candidateRows = await tx<CandidateDbRow[]>`
          SELECT id, text, kind, importance, created_at,
                 1 - (embedding <=> ${vecLit}::vector) AS similarity
            FROM memory
           WHERE agent_id = ${input.agentId} AND tenant_id = ${input.tenantId}
           ORDER BY embedding <=> ${vecLit}::vector
           LIMIT ${pool}
        `;
        if (candidateRows.length === pool) {
          counter(
            "relay.memory.retrieve.candidate_pool_saturated",
            "Times the candidate pool returned exactly its requested size — re-rank may have starved.",
          ).add(1);
        }

        const candidates = candidateRows.map(mapCandidateRow);
        const now = new Date(clock.now());
        const ranked = scoreCandidates(candidates, alpha, halfLifeDays, now);
        const top = ranked.slice(0, k);

        span.setAttributes({ [Attr.MemoryReturnedCount]: top.length });

        if (top.length === 0) {
          return ok([]);
        }

        const ids = top.map((r) => r.id);
        await tx`
          UPDATE memory
             SET last_retrieved_at = ${now},
                 retrieval_count   = retrieval_count + 1
           WHERE id = ANY(${ids})
        `;

        return ok(top);
      });
    },
  );
}
