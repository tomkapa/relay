// Unit tests for the pure migration planner. Exercises the decision matrix
// (apply / skip / checksum_mismatch) without touching Postgres.

import { describe, expect, test } from "bun:test";
import {
  planMigrations,
  sha256Hex,
  type AppliedRow,
  type Migration,
} from "../../../src/db/migrate.ts";

function mig(version: number, sql: string): Migration {
  return {
    version,
    name: `m${version.toString()}`,
    filename: `${version.toString().padStart(4, "0")}_m${version.toString()}.sql`,
    sql,
    checksum: sha256Hex(sql),
  };
}

function appliedFrom(ms: readonly Migration[]): Map<number, AppliedRow> {
  const m = new Map<number, AppliedRow>();
  for (const x of ms) {
    m.set(x.version, { version: x.version, filename: x.filename, checksum: x.checksum });
  }
  return m;
}

describe("planMigrations", () => {
  test("all apply when applied map is empty", () => {
    const ms = [mig(1, "SELECT 1"), mig(2, "SELECT 2")];
    const r = planMigrations(ms, new Map());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(2);
    expect(r.value.map((o) => o.kind)).toEqual(["apply", "apply"]);
  });

  test("all skip when every migration is already applied with matching checksum", () => {
    const ms = [mig(1, "SELECT 1"), mig(2, "SELECT 2")];
    const r = planMigrations(ms, appliedFrom(ms));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((o) => o.kind)).toEqual(["skip", "skip"]);
  });

  test("mixes apply and skip when only a prefix is applied", () => {
    const ms = [mig(1, "SELECT 1"), mig(2, "SELECT 2"), mig(3, "SELECT 3")];
    const partial = appliedFrom([ms[0]!, ms[1]!]);
    const r = planMigrations(ms, partial);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((o) => o.kind)).toEqual(["skip", "skip", "apply"]);
    const apply = r.value[2];
    expect(apply?.kind).toBe("apply");
    if (apply?.kind === "apply") expect(apply.migration.version).toBe(3);
  });

  test("returns checksum_mismatch when applied entry has a different checksum", () => {
    const ms = [mig(1, "SELECT 1")];
    const tampered = new Map<number, AppliedRow>([
      [1, { version: 1, filename: ms[0]?.filename ?? "", checksum: "tampered" }],
    ]);
    const r = planMigrations(ms, tampered);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("checksum_mismatch");
    if (r.error.kind === "checksum_mismatch") {
      expect(r.error.version).toBe(1);
      expect(r.error.actual).toBe(ms[0]?.checksum ?? "");
      expect(r.error.expected).toBe("tampered");
    }
  });

  test("stops at the first mismatch; later versions are not reported", () => {
    const ms = [mig(1, "SELECT 1"), mig(2, "SELECT 2")];
    const tampered = new Map<number, AppliedRow>([
      [1, { version: 1, filename: ms[0]?.filename ?? "", checksum: "bad" }],
      [2, { version: 2, filename: ms[1]?.filename ?? "", checksum: "also bad" }],
    ]);
    const r = planMigrations(ms, tampered);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    if (r.error.kind === "checksum_mismatch") expect(r.error.version).toBe(1);
  });

  test("empty migrations list returns empty plan", () => {
    const r = planMigrations([], new Map());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });
});

describe("sha256Hex", () => {
  test("produces a stable 64-hex digest", () => {
    const h = sha256Hex("hello");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex("hello")).toBe(h);
  });

  test("differs for different inputs", () => {
    expect(sha256Hex("a")).not.toBe(sha256Hex("b"));
  });
});
