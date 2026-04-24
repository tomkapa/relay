// Production embedding adapter: OpenAI text-embedding-3-small → Float32Array(1536).
// Entrypoints construct one instance per process and hand it to the core (CLAUDE §9).
// Tests inject a fake EmbeddingClient; never instantiate this directly in tests.

import OpenAI, { APIError, APIUserAbortError } from "openai";
import type { CreateEmbeddingResponse } from "openai/resources/embeddings.js";
import { AssertionError, assert } from "../core/assert.ts";
import { err, ok } from "../core/result.ts";
import type { Result } from "../core/result.ts";
import { recordGenAiOperationDuration, recordGenAiTokenUsage } from "../telemetry/genai-metrics.ts";
import {
  Attr,
  GenAiAttr,
  GenAiEvent,
  SpanName,
  withSpan,
  type Attributes,
} from "../telemetry/otel.ts";
import { MAX_GENAI_CONTENT_BYTES_PER_PART, truncateUtf8 } from "../telemetry/limits.ts";
import { EMBEDDING_CALL_TIMEOUT_MS, EMBEDDING_DIM, MAX_EMBED_INPUT_BYTES } from "./limits.ts";
import type { EmbedError, EmbeddingClient } from "./embedding.ts";

const DEFAULT_MODEL = "text-embedding-3-small";

export class OpenAIEmbeddingClient implements EmbeddingClient {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly timeoutMs: number;

  public constructor(opts: { apiKey: string; model?: string; sdk?: OpenAI; timeoutMs?: number }) {
    assert(opts.apiKey.length > 0, "OpenAIEmbeddingClient: apiKey must be non-empty");
    this.client = opts.sdk ?? new OpenAI({ apiKey: opts.apiKey });
    this.model = opts.model ?? DEFAULT_MODEL;
    this.timeoutMs = opts.timeoutMs ?? EMBEDDING_CALL_TIMEOUT_MS;
  }

  public async embed(text: string, signal: AbortSignal): Promise<Result<Float32Array, EmbedError>> {
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_EMBED_INPUT_BYTES) {
      return err({ kind: "input_too_long", bytes, max: MAX_EMBED_INPUT_BYTES });
    }
    assert(bytes > 0, "OpenAIEmbeddingClient.embed: input text is empty");

    const metricAttrs: Attributes = {
      [GenAiAttr.OperationName]: "embeddings",
      [GenAiAttr.ProviderName]: "openai",
      [GenAiAttr.RequestModel]: this.model,
    };

    return withSpan(
      SpanName.EmbeddingCall,
      {
        [Attr.EmbeddingModel]: this.model,
        [Attr.EmbeddingDim]: EMBEDDING_DIM,
        [Attr.EmbeddingInputBytes]: bytes,
        ...metricAttrs,
        [GenAiAttr.EmbeddingsDimensionCount]: EMBEDDING_DIM,
      },
      async (span) => {
        const localCtl = new AbortController();
        const timer = setTimeout(() => {
          localCtl.abort();
        }, this.timeoutMs);
        const composite = composeSignals(signal, localCtl.signal);
        const started = performance.now();
        let rawResp: CreateEmbeddingResponse;
        try {
          rawResp = await this.client.embeddings.create(
            { model: this.model, input: text },
            { signal: composite },
          );
        } catch (e: unknown) {
          clearTimeout(timer);
          const elapsedMs = Math.round(performance.now() - started);
          recordGenAiOperationDuration(elapsedMs / 1000, {
            ...metricAttrs,
            [GenAiAttr.ErrorType]: e instanceof Error ? e.name : "unknown",
          });
          if (composite.aborted) return err({ kind: "timeout", elapsedMs });
          if (e instanceof AssertionError) throw e;
          return err(classify(e, elapsedMs));
        }
        clearTimeout(timer);
        const elapsedMs = Math.round(performance.now() - started);
        assert(rawResp.data.length === 1, "OpenAIEmbeddingClient: expected exactly 1 embedding");
        const item = rawResp.data[0];
        assert(item !== undefined, "OpenAIEmbeddingClient: embedding item is undefined");
        assert(
          item.embedding.length === EMBEDDING_DIM,
          "OpenAIEmbeddingClient: provider returned wrong dimension",
          { got: item.embedding.length, expected: EMBEDDING_DIM },
        );
        const inputTokens = rawResp.usage.prompt_tokens;
        span.setAttribute(GenAiAttr.UsageInputTokens, inputTokens);
        const t = truncateUtf8(text, MAX_GENAI_CONTENT_BYTES_PER_PART);
        span.addEvent(GenAiEvent.InferenceDetails, {
          [GenAiAttr.InputMessages]: JSON.stringify([
            { role: "user", parts: [{ type: "text", content: t.text }] },
          ]),
        });
        if (t.truncated) span.setAttribute(GenAiAttr.ContentTruncated, true);
        recordGenAiOperationDuration(elapsedMs / 1000, metricAttrs);
        recordGenAiTokenUsage(inputTokens, "input", metricAttrs);
        return ok(new Float32Array(item.embedding));
      },
    );
  }
}

function classify(e: unknown, elapsedMs: number): EmbedError {
  if (e instanceof APIUserAbortError) return { kind: "timeout", elapsedMs };
  if (e instanceof APIError) {
    // instanceof narrows to APIError<any,any,any>; extract status via Record to avoid
    // no-unsafe-member-access and no-unsafe-argument on the any-typed generic fields.
    const eRec = e as unknown as Record<string, unknown>;
    const status = typeof eRec["status"] === "number" ? eRec["status"] : undefined;
    const message = e.message;
    if (status !== undefined) {
      const transient = status === 429 || status >= 500;
      return { kind: transient ? "transient" : "permanent", status, message };
    }
    return { kind: "transient", message };
  }
  return { kind: "transient", message: e instanceof Error ? e.message : String(e) };
}

function composeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const ctl = new AbortController();
  const onAbort = (): void => {
    ctl.abort();
  };
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  // Clean up listeners on both sources when composite fires (prevents accumulation on
  // long-lived caller signals if the local timeout fires before the caller aborts).
  ctl.signal.addEventListener(
    "abort",
    () => {
      a.removeEventListener("abort", onAbort);
      b.removeEventListener("abort", onAbort);
    },
    { once: true },
  );
  return ctl.signal;
}
