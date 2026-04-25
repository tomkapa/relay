// Branded identifiers for every SPEC entity. Raw `string` for an ID is a review-blocking bug.
// Parsers live at the system boundary (zod → these constructors). No `as` inside the core.
// See CLAUDE.md §1 and SPEC.md §Data Model.

import { randomUUID } from "node:crypto";
import { assert } from "./core/assert.ts";
import type { Brand } from "./core/brand.ts";
import { err, ok, type Result } from "./core/result.ts";
import { MAX_RETRIEVAL, MAX_RETRIEVAL_CANDIDATES } from "./memory/limits.ts";

export type AgentId = Brand<string, "AgentId">;
export type SessionId = Brand<string, "SessionId">;
export type TurnId = Brand<string, "TurnId">;
export type ToolUseId = Brand<string, "ToolUseId">;
export type TaskId = Brand<string, "TaskId">;
export type MemoryId = Brand<string, "MemoryId">;
export type HookId = Brand<string, "HookId">;
export type HookRecordId = Brand<string, "HookRecordId">;
export type HookAuditId = Brand<string, "HookAuditId">;
export type HookConfigSnapshotId = Brand<string, "HookConfigSnapshotId">;
export type PendingSystemMessageId = Brand<string, "PendingSystemMessageId">;
export type TenantId = Brand<string, "TenantId">;
export type UserId = Brand<string, "UserId">;
export type ChainId = Brand<string, "ChainId">;
export type WorkItemId = Brand<string, "WorkItemId">;
export type EnvelopeId = Brand<string, "EnvelopeId">;
export type InboundMessageId = Brand<string, "InboundMessageId">;

export type IdParseError =
  | { kind: "empty" }
  | { kind: "too_long"; length: number; max: number }
  | { kind: "malformed"; reason: string };

// UUIDv4 or UUIDv7 shape — 8-4-4-4-12 hex, with version nibble in {4, 7}.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID_MAX_LEN = 36;
// Model-assigned tool_use ids are opaque strings ("toolu_..."), not UUIDs.
const TOOL_USE_ID_MAX_LEN = 128;

function parseUuid<B extends string>(raw: string): Result<Brand<string, B>, IdParseError> {
  if (raw.length === 0) return err({ kind: "empty" });
  if (raw.length > ID_MAX_LEN)
    return err({ kind: "too_long", length: raw.length, max: ID_MAX_LEN });
  if (!UUID_RE.test(raw)) return err({ kind: "malformed", reason: "not a v4/v7 UUID" });
  return ok(raw.toLowerCase() as Brand<string, B>);
}

export const AgentId = {
  parse: (raw: string): Result<AgentId, IdParseError> => parseUuid<"AgentId">(raw),
};
export const SessionId = {
  parse: (raw: string): Result<SessionId, IdParseError> => parseUuid<"SessionId">(raw),
};
export const TurnId = {
  parse: (raw: string): Result<TurnId, IdParseError> => parseUuid<"TurnId">(raw),
};
export const TaskId = {
  parse: (raw: string): Result<TaskId, IdParseError> => parseUuid<"TaskId">(raw),
};
export const MemoryId = {
  parse: (raw: string): Result<MemoryId, IdParseError> => parseUuid<"MemoryId">(raw),
};
export const HookId = {
  parse: (raw: string): Result<HookId, IdParseError> => parseUuid<"HookId">(raw),
};

// Accepts a UUID v4/v7 OR a stable system hook tag in the form system/<event>/<name>.
// UUID form is used for customer-authored rules (hook_rules PK, RELAY-225).
// System tag form is used for in-tree hooks registered at startup.
const SYSTEM_HOOK_ID_RE = /^system\/[a-z_]+\/[a-z0-9_-]+$/;
export const HookRecordId = {
  parse(raw: string): Result<HookRecordId, IdParseError> {
    if (raw.length === 0) return err({ kind: "empty" });
    if (raw.length > ID_MAX_LEN * 2)
      return err({ kind: "too_long", length: raw.length, max: ID_MAX_LEN * 2 });
    if (UUID_RE.test(raw)) return ok(raw.toLowerCase() as HookRecordId);
    if (SYSTEM_HOOK_ID_RE.test(raw)) return ok(raw as HookRecordId);
    return err({ kind: "malformed", reason: "must be UUID or system/<event>/<name>" });
  },
};
export const HookAuditId = {
  parse: (raw: string): Result<HookAuditId, IdParseError> => parseUuid<"HookAuditId">(raw),
};
export const HookConfigSnapshotId = {
  parse: (raw: string): Result<HookConfigSnapshotId, IdParseError> =>
    parseUuid<"HookConfigSnapshotId">(raw),
};
export const PendingSystemMessageId = {
  parse: (raw: string): Result<PendingSystemMessageId, IdParseError> =>
    parseUuid<"PendingSystemMessageId">(raw),
};
export const TenantId = {
  parse: (raw: string): Result<TenantId, IdParseError> => parseUuid<"TenantId">(raw),
};
export const UserId = {
  parse: (raw: string): Result<UserId, IdParseError> => parseUuid<"UserId">(raw),
};
export const ChainId = {
  parse: (raw: string): Result<ChainId, IdParseError> => parseUuid<"ChainId">(raw),
};
export const WorkItemId = {
  parse: (raw: string): Result<WorkItemId, IdParseError> => parseUuid<"WorkItemId">(raw),
};
export const EnvelopeId = {
  parse: (raw: string): Result<EnvelopeId, IdParseError> => parseUuid<"EnvelopeId">(raw),
};
export const InboundMessageId = {
  parse: (raw: string): Result<InboundMessageId, IdParseError> =>
    parseUuid<"InboundMessageId">(raw),
};
export const ToolUseId = {
  parse: (raw: string): Result<ToolUseId, IdParseError> => {
    if (raw.length === 0) return err({ kind: "empty" });
    if (raw.length > TOOL_USE_ID_MAX_LEN)
      return err({ kind: "too_long", length: raw.length, max: TOOL_USE_ID_MAX_LEN });
    return ok(raw as ToolUseId);
  },
};

// Mint a new UUID-based branded id. Asserts that randomUUID() produces a valid value,
// which it always does — the assert guards against theoretical platform bugs.
export function mintId<B extends string>(
  parser: (raw: string) => Result<Brand<string, B>, IdParseError>,
  context: string,
): Brand<string, B> {
  const raw = randomUUID();
  const result = parser(raw);
  assert(result.ok, `${context}: randomUUID produced invalid id`, { raw });
  return result.value;
}

// Bounded numeric brands from SPEC.
export type Depth = Brand<number, "Depth">;
export type Importance = Brand<number, "Importance">;

export type DepthError = { kind: "out_of_range"; value: number; min: 0; max: number };
export type ImportanceError = { kind: "out_of_range"; value: number; min: 0; max: 1 };

export const DEPTH_CAP = 32; // See src/hook/limits.ts for the authoritative value.
export const Depth = {
  parse: (raw: number): Result<Depth, DepthError> => {
    if (!Number.isInteger(raw) || raw < 0 || raw > DEPTH_CAP) {
      return err({ kind: "out_of_range", value: raw, min: 0, max: DEPTH_CAP });
    }
    return ok(raw as Depth);
  },
};

export const Importance = {
  parse: (raw: number): Result<Importance, ImportanceError> => {
    if (!Number.isFinite(raw) || raw < 0 || raw > 1) {
      return err({ kind: "out_of_range", value: raw, min: 0, max: 1 });
    }
    return ok(raw as Importance);
  },
};

// Branded numeric types for retrieval parameters (SPEC §Memory).
export type RetrievalK = Brand<number, "RetrievalK">; // 1 ≤ k ≤ MAX_RETRIEVAL
export type CandidatePool = Brand<number, "CandidatePool">; // k ≤ pool ≤ MAX_RETRIEVAL_CANDIDATES

export type RetrievalKError = { kind: "out_of_range"; value: number; min: 1; max: number };
export type CandidatePoolError =
  | { kind: "below_k"; pool: number; k: number }
  | { kind: "out_of_range"; value: number; min: number; max: number };

export const RetrievalK = {
  parse: (raw: number): Result<RetrievalK, RetrievalKError> => {
    if (!Number.isInteger(raw) || raw < 1 || raw > MAX_RETRIEVAL) {
      return err({ kind: "out_of_range", value: raw, min: 1, max: MAX_RETRIEVAL });
    }
    return ok(raw as RetrievalK);
  },
};

export const CandidatePool = {
  parse: (raw: number, k: RetrievalK): Result<CandidatePool, CandidatePoolError> => {
    if (!Number.isInteger(raw) || raw < 1 || raw > MAX_RETRIEVAL_CANDIDATES) {
      return err({ kind: "out_of_range", value: raw, min: 1, max: MAX_RETRIEVAL_CANDIDATES });
    }
    if (raw < k) return err({ kind: "below_k", pool: raw, k });
    return ok(raw as CandidatePool);
  },
};
