// Inbound message subsystem bounds. CLAUDE.md §5 — named caps with *why this number* comments.

// Largest content accepted on an inbound message. Producers (HTTP ingress, ask tool)
// reject larger submissions before writing the inbound_messages row; re-asserted at the
// handler boundary in case a misbehaving producer slips through.
// Matches MAX_MESSAGE_CONTENT_BYTES for symmetry with RELAY-26.
export const MAX_INBOUND_CONTENT_BYTES = 64 * 1024;

// Sender metadata caps (producer-side; re-asserted at the boundary).
export const MAX_INBOUND_SENDER_DISPLAY_NAME_LEN = 128;
export const MAX_INBOUND_SENDER_EXTERNAL_ID_LEN = 256;
