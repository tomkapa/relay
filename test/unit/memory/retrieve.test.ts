// Unit tests for scoreCandidates — the pure re-ranking function. No DB required.

import { describe, expect, test } from "bun:test";
import { AssertionError } from "../../../src/core/assert.ts";
import type { MemoryId } from "../../../src/ids.ts";
import { scoreCandidates } from "../../../src/memory/retrieve.ts";
import type { MemoryKind } from "../../../src/memory/kind.ts";

const EVENT = "event" as unknown as MemoryKind;
const FACT = "fact" as unknown as MemoryKind;

function makeId(n: number): MemoryId {
  return `00000000-0000-4000-a000-${String(n).padStart(12, "0")}` as unknown as MemoryId;
}

function makeCandidate(
  n: number,
  similarity: number,
  importance: number,
  createdAt: Date,
): {
  id: MemoryId;
  text: string;
  kind: MemoryKind;
  importance: number;
  createdAt: Date;
  similarity: number;
} {
  return {
    id: makeId(n),
    text: `memory ${String(n)}`,
    kind: EVENT,
    importance,
    createdAt,
    similarity,
  };
}

const NOW = new Date(1_000_000_000_000);
const ONE_DAY_AGO = new Date(NOW.getTime() - 86_400_000);
const THIRTY_DAYS_AGO = new Date(NOW.getTime() - 30 * 86_400_000);

describe("scoreCandidates", () => {
  test("scoreCandidates_emptyInputReturnsEmpty", () => {
    const result = scoreCandidates([], 1.0, 90, NOW);
    expect(result).toEqual([]);
  });

  test("scoreCandidates_higherSimilarityWinsAtEqualImportanceAndAge", () => {
    const a = makeCandidate(1, 0.9, 0.5, NOW);
    const b = makeCandidate(2, 0.3, 0.5, NOW);
    const result = scoreCandidates([b, a], 1.0, 90, NOW);
    expect(result[0]?.id).toBe(makeId(1));
    expect(result[1]?.id).toBe(makeId(2));
  });

  test("scoreCandidates_higherImportanceWinsAtEqualSimilarityAndAge_alpha1", () => {
    const a = makeCandidate(1, 0.7, 0.9, NOW);
    const b = makeCandidate(2, 0.7, 0.2, NOW);
    const result = scoreCandidates([b, a], 1.0, 90, NOW);
    expect(result[0]?.id).toBe(makeId(1));
    expect(result[1]?.id).toBe(makeId(2));
  });

  test("scoreCandidates_alphaZero_importanceIgnored", () => {
    // With alpha=0, importance^0 = 1 for any positive importance, so ordering is by similarity × recency.
    const a = makeCandidate(1, 0.5, 0.1, NOW); // low importance but equal after alpha=0
    const b = makeCandidate(2, 0.9, 0.9, NOW); // high similarity wins
    const result = scoreCandidates([a, b], 0.0, 90, NOW);
    expect(result[0]?.id).toBe(makeId(2)); // higher similarity wins
    expect(result[1]?.id).toBe(makeId(1));
  });

  test("scoreCandidates_recencyDecaysWithAge", () => {
    const fresh = makeCandidate(1, 0.8, 0.5, NOW);
    const old = makeCandidate(2, 0.8, 0.5, THIRTY_DAYS_AGO);
    const result = scoreCandidates([old, fresh], 1.0, 90, NOW);
    expect(result[0]?.id).toBe(makeId(1)); // newer ranks first
    // older's recency factor is exp(-30/90) ≈ 0.716; ratio of scores should match
    const freshScore = result[0]?.score ?? 0;
    const oldScore = result[1]?.score ?? 0;
    const expectedRatio = Math.exp(-30 / 90);
    expect(Math.abs(oldScore / freshScore - expectedRatio)).toBeLessThan(1e-9);
  });

  test("scoreCandidates_assertsAlphaNegative", () => {
    const c = makeCandidate(1, 0.5, 0.5, NOW);
    expect(() => scoreCandidates([c], -1, 90, NOW)).toThrow(AssertionError);
  });

  test("scoreCandidates_assertsHalfLifeNonPositive", () => {
    const c = makeCandidate(1, 0.5, 0.5, NOW);
    expect(() => scoreCandidates([c], 1.0, 0, NOW)).toThrow(AssertionError);
  });

  test("scoreCandidates_returnsAllScoreComponents", () => {
    const c = makeCandidate(1, 0.8, 0.6, ONE_DAY_AGO);
    const result = scoreCandidates([c], 1.5, 90, NOW);
    expect(result.length).toBe(1);
    const r = result[0];
    if (!r) return;
    const expectedRecency = Math.exp(-1 / 90);
    const expectedScaled = Math.pow(0.6, 1.5);
    const expectedScore = 0.8 * expectedScaled * expectedRecency;
    expect(Math.abs(r.recencyFactor - expectedRecency)).toBeLessThan(1e-9);
    expect(Math.abs(r.scaledImportance - expectedScaled)).toBeLessThan(1e-9);
    expect(Math.abs(r.score - expectedScore)).toBeLessThan(1e-9);
    // Consistency: score === similarity * scaledImportance * recencyFactor
    expect(Math.abs(r.score - r.similarity * r.scaledImportance * r.recencyFactor)).toBeLessThan(
      1e-9,
    );
  });

  test("scoreCandidates_singleCandidate_ageZero_recencyIsOne", () => {
    const c = makeCandidate(1, 0.7, 0.5, NOW);
    const result = scoreCandidates([c], 1.0, 90, NOW);
    expect(result[0]?.recencyFactor).toBeCloseTo(1.0);
  });

  test("scoreCandidates_futureCreatedAt_clampedToZeroAge", () => {
    // Memories with created_at in the future get ageDays = 0 (Math.max guard).
    const future = new Date(NOW.getTime() + 86_400_000);
    const c = makeCandidate(1, 0.7, 0.5, future);
    const result = scoreCandidates([c], 1.0, 90, NOW);
    expect(result[0]?.recencyFactor).toBeCloseTo(1.0);
  });

  test("scoreCandidates_blendsDifferentKinds", () => {
    const event = {
      id: makeId(1),
      text: "e",
      kind: EVENT,
      importance: 0.5,
      createdAt: NOW,
      similarity: 0.9,
    };
    const fact = {
      id: makeId(2),
      text: "f",
      kind: FACT,
      importance: 0.5,
      createdAt: NOW,
      similarity: 0.7,
    };
    const result = scoreCandidates([fact, event], 1.0, 90, NOW);
    expect(result[0]?.id).toBe(makeId(1)); // event wins by higher similarity
    expect(result[1]?.id).toBe(makeId(2));
  });
});
