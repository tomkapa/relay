// Trigger subsystem bounds. CLAUDE.md §5 — named caps with *why this number* comments.

// Largest content accepted on a message envelope. Submissions larger than this fail at
// the producer boundary (HTTP ingress) before the envelope row is written.
export const MAX_MESSAGE_CONTENT_BYTES = 64 * 1024;

// Cap on the event source identifier (connector id). Low-byte, low-cardinality.
export const MAX_EVENT_SOURCE_LEN = 128;

// Max serialized JSON size of an envelope payload. Belt-and-braces: enforced at the
// producer and re-asserted at the reader in case a producer misbehaves.
export const MAX_ENVELOPE_BYTES = 128 * 1024;

// Cap on the rendered opening-context user message. Long message bodies are truncated
// with a tail marker so the first model call stays within the model's context budget.
export const MAX_OPENING_USER_CONTENT = 32_768;

// Sender metadata caps (producer-side; re-asserted at the boundary).
export const MAX_SENDER_DISPLAY_NAME_LEN = 128;
export const MAX_SENDER_EXTERNAL_ID_LEN = 256;

// Cap on the `tasks.intent` content folded into the first user message.
export const MAX_TASK_INTENT_LEN = 4_096;
