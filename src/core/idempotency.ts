import { assert } from "./assert.ts";
import type { Brand } from "./brand.ts";
import { sha256Hex } from "./hash.ts";
import type { AgentId, SessionId, ToolUseId, TurnId } from "../ids.ts";

export type IdempotencyKey = Brand<string, "IdempotencyKey">;

export type IdempotencyKeyInput = {
  readonly writer: string;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly toolCallId: string;
};

const KEY_DIGEST_RE = /^[0-9a-f]{64}$/;
const MAX_TOOL_CALL_ID_LEN = 128;

export function idempotencyKey(input: IdempotencyKeyInput): IdempotencyKey {
  assert(input.writer.length > 0, "idempotency: writer empty");
  assert(!input.writer.includes("|"), "idempotency: writer contains `|`", {
    writer: input.writer,
  });
  assert(input.toolCallId.length > 0, "idempotency: toolCallId empty");
  assert(input.toolCallId.length <= MAX_TOOL_CALL_ID_LEN, "idempotency: toolCallId too long", {
    length: input.toolCallId.length,
  });
  // `|` delimiter is safe: writer has no `|` (asserted), UUIDs have no `|`, and
  // Anthropic tool-use ids are ASCII identifier characters.
  return sha256Hex(
    `${input.writer}|${input.sessionId}|${input.turnId}|${input.toolCallId}`,
  ) as IdempotencyKey;
}

export function assertValidKeyFormat(key: string): asserts key is IdempotencyKey {
  assert(KEY_DIGEST_RE.test(key), "idempotency: key not 64-hex digest", { keyLength: key.length });
}

// Deterministic idempotency key for a seed memory at agent creation. The freshly-minted
// agentId makes the digest unique per creation; index disambiguates entries within one batch.
// Reuses the same 64-hex IdempotencyKey brand — no new format.
export function idempotencyKeyForAgentSeed(input: {
  readonly agentId: AgentId;
  readonly index: number;
}): IdempotencyKey {
  assert(input.index >= 0, "idempotencyKeyForAgentSeed: index must be non-negative", {
    index: input.index,
  });
  return sha256Hex(`agent.seed_memory|${input.agentId}|${String(input.index)}`) as IdempotencyKey;
}

// Deterministic idempotency key for an ask-reply inbound. The child session id + parent tool
// use id form a globally unique pair, so no turnId is needed here (close has no turn id).
export function idempotencyKeyForAskReply(input: {
  readonly childSessionId: SessionId;
  readonly parentToolUseId: ToolUseId;
}): IdempotencyKey {
  assert(input.parentToolUseId.length > 0, "idempotencyKeyForAskReply: parentToolUseId empty");
  return sha256Hex(
    `ask_reply|${input.childSessionId}|close|${input.parentToolUseId}`,
  ) as IdempotencyKey;
}

// Convert a 64-hex IdempotencyKey to a deterministic UUID v4 string. Used to derive a
// stable row-id for `ON CONFLICT (id) DO NOTHING` insert patterns (e.g. envelope dedup).
// Bits 4-7 of group 3 are fixed to '4' (version) and bits 6-7 of group 4 are fixed to '10'
// (RFC 4122 variant), overwriting those nibbles from the hash.
export function idempotencyKeyToUuid(key: IdempotencyKey): string {
  const h = key as string; // 64 hex chars
  const p1 = h.slice(0, 8);
  const p2 = h.slice(8, 12);
  const p3 = `4${h.slice(13, 16)}`; // version nibble = 4
  const variantByte = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0");
  const p4 = `${variantByte}${h.slice(18, 20)}`;
  const p5 = h.slice(20, 32);
  return `${p1}-${p2}-${p3}-${p4}-${p5}`;
}
