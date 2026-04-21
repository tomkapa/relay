// Unit tests for loadMigrations — exercises file-reading, checksum calc, ordering, and
// error paths without a database. Uses a tmp dir populated by each test so failures stay
// isolated (CLAUDE.md §3 — one behavior per test).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadMigrations } from "../../../src/db/migrate.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "relay-migrate-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(filename: string, body: string): Promise<void> {
  await writeFile(path.join(dir, filename), body, "utf8");
}

describe("loadMigrations", () => {
  test("returns empty list for empty directory", async () => {
    const r = await loadMigrations(dir);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });

  test("loads files in numeric order and computes distinct checksums", async () => {
    await write("0002_second.sql", "SELECT 2;");
    await write("0001_first.sql", "SELECT 1;");
    await write("0010_tenth.sql", "SELECT 10;");
    const r = await loadMigrations(dir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((m) => m.version)).toEqual([1, 2, 10]);
    expect(r.value.map((m) => m.name)).toEqual(["first", "second", "tenth"]);
    const checksums = new Set(r.value.map((m) => m.checksum));
    expect(checksums.size).toBe(3);
  });

  test("checksum is stable across reads", async () => {
    await write("0001_stable.sql", "SELECT 1;");
    const r1 = await loadMigrations(dir);
    const r2 = await loadMigrations(dir);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.value[0]?.checksum).toBe(r2.value[0]?.checksum ?? "");
  });

  test("ignores non-.sql files", async () => {
    await write("0001_init.sql", "SELECT 1;");
    await write("README.md", "notes");
    await write("notes.txt", "misc");
    const r = await loadMigrations(dir);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toHaveLength(1);
  });

  test("rejects invalid filename", async () => {
    await write("init.sql", "SELECT 1;");
    const r = await loadMigrations(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("invalid_filename");
  });

  test("rejects unreadable directory", async () => {
    const missing = path.join(dir, "does-not-exist");
    const r = await loadMigrations(missing);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("read_failed");
  });

  test("loads the shipped production migration", async () => {
    const prodDir = path.resolve(import.meta.dir, "../../../src/db/migrations");
    const r = await loadMigrations(prodDir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.length).toBeGreaterThanOrEqual(1);
    const first = r.value[0];
    expect(first?.version).toBe(1);
    expect(first?.name).toBe("init");
    expect(first?.sql.toLowerCase()).toContain("create extension");
    expect(first?.sql.toLowerCase()).toContain("vector");
    expect(first?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("loadMigrations — duplicate version detection", () => {
  test("two files with the same version prefix → duplicate_version error", async () => {
    await write("0001_alpha.sql", "SELECT 'a';");
    await write("0001_beta.sql", "SELECT 'b';");
    const r = await loadMigrations(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("duplicate_version");
  });
});
