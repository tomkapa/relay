import { describe, expect, test } from "bun:test";
import { parseMigrationFilename } from "../../../src/db/migrate.ts";

describe("parseMigrationFilename", () => {
  test("accepts a well-formed filename", () => {
    const r = parseMigrationFilename("0001_init.sql");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.version).toBe(1);
      expect(r.value.name).toBe("init");
    }
  });

  test("accepts multi-word names with underscores", () => {
    const r = parseMigrationFilename("0042_add_tenant_scope.sql");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.version).toBe(42);
      expect(r.value.name).toBe("add_tenant_scope");
    }
  });

  test("rejects missing .sql extension", () => {
    const r = parseMigrationFilename("0001_init.txt");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("invalid_filename");
  });

  test("rejects missing version prefix", () => {
    const r = parseMigrationFilename("init.sql");
    expect(r.ok).toBe(false);
  });

  test("rejects 3-digit version", () => {
    const r = parseMigrationFilename("001_init.sql");
    expect(r.ok).toBe(false);
  });

  test("rejects uppercase in name", () => {
    const r = parseMigrationFilename("0001_Init.sql");
    expect(r.ok).toBe(false);
  });

  test("rejects empty name", () => {
    const r = parseMigrationFilename("0001_.sql");
    expect(r.ok).toBe(false);
  });
});
