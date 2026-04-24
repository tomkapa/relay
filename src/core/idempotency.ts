import { assert } from "./assert.ts";
import type { Brand } from "./brand.ts";
import { sha256Hex } from "./hash.ts";
import type { SessionId, TurnId } from "../ids.ts";

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
