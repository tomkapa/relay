// GenAI histogram recorders. Spec: OpenTelemetry GenAI metrics
// (https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-metrics/).
// Units and names are spec-defined so Honeycomb's GenAI visualizations can consume them.

import { GenAiAttr, histogram, type Attributes } from "./otel.ts";

// Histogram handles are cached by name in the otel facade; re-calling histogram() here
// returns the same instrument so the recorders stay cheap on a hot path.
function durationHistogram(): ReturnType<typeof histogram> {
  return histogram(
    "gen_ai.client.operation.duration",
    "Duration of a GenAI client operation (chat/embeddings/…). Spec metric.",
    "s",
  );
}

function tokenUsageHistogram(): ReturnType<typeof histogram> {
  return histogram(
    "gen_ai.client.token.usage",
    "Token usage for a GenAI client call, split by gen_ai.token.type. Spec metric.",
    "{token}",
  );
}

// Record one duration observation in seconds. Caller passes the spec attribute bag —
// gen_ai.operation.name, gen_ai.provider.name, gen_ai.request.model, and error.type
// on failure. Attribute keys live in GenAiAttr; the caller assembles the bag once per
// call-site for clarity.
export function recordGenAiOperationDuration(seconds: number, attrs: Attributes): void {
  durationHistogram().record(seconds, attrs);
}

// Record one token-usage observation. Adds gen_ai.token.type=input|output to `attrs`;
// callers should not include that key themselves. Two records per chat call (input +
// output); one record per embeddings call (input only).
export function recordGenAiTokenUsage(
  tokens: number,
  type: "input" | "output",
  attrs: Attributes,
): void {
  tokenUsageHistogram().record(tokens, { ...attrs, [GenAiAttr.TokenType]: type });
}
