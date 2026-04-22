// TranscriptEntry — the schema for sessions.turn_transcript entries.
// RELAY-27 tightens this into a fully branded tagged union once it owns the rest of the
// transcript. For now the shape is intentionally loose: system + user entries are written
// here; assistant + tool entries are filled in by the agentic loop.

export type TranscriptEntry =
  | {
      readonly role: "system";
      readonly content: string;
    }
  | {
      readonly role: "user";
      readonly content: string;
      readonly sender?: {
        readonly type: string;
        readonly id: string;
        readonly displayName?: string;
      };
      readonly receivedAt?: string;
    }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly toolCalls?: readonly unknown[];
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly content: string;
    };
