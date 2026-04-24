import type { Brand } from "../core/brand.ts";
import { err, ok, type Result } from "../core/result.ts";

export type MemoryKind = Brand<string, "MemoryKind">;

export type MemoryKindError = { kind: "unknown_kind"; raw: string };

const VALID: ReadonlySet<string> = new Set(["event", "fact"]);

export const MemoryKind = {
  parse(raw: string): Result<MemoryKind, MemoryKindError> {
    if (!VALID.has(raw)) return err({ kind: "unknown_kind", raw });
    return ok(raw as MemoryKind);
  },
};
