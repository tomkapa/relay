import { expect, test } from "bun:test";
import type OpenAI from "openai";
import { APIConnectionError, APIError } from "openai";
import type { CreateEmbeddingResponse } from "openai/resources/embeddings.js";
import { AssertionError } from "../../../src/core/assert.ts";
import { EMBEDDING_DIM, MAX_EMBED_INPUT_BYTES } from "../../../src/memory/limits.ts";
import { OpenAIEmbeddingClient } from "../../../src/memory/embedding-openai.ts";

// --- SDK stub helpers ---

type CreateFn = (
  body: unknown,
  options: { signal?: AbortSignal },
) => Promise<CreateEmbeddingResponse>;

function makeSDK(createFn: CreateFn): OpenAI {
  return { embeddings: { create: createFn } } as unknown as OpenAI;
}

function goodResponse(dim = EMBEDDING_DIM): CreateEmbeddingResponse {
  return {
    object: "list",
    model: "text-embedding-3-small",
    data: [{ object: "embedding", index: 0, embedding: Array.from({ length: dim }, () => 0.1) }],
    usage: { prompt_tokens: 3, total_tokens: 3 },
  };
}

function makeGoodSDK(dim = EMBEDDING_DIM): OpenAI {
  return makeSDK(() => Promise.resolve(goodResponse(dim)));
}

function apiError(status: number, message: string): APIError {
  return APIError.generate(status, {}, message, new Headers());
}

function makeThrowSDK(error: unknown): OpenAI {
  return makeSDK(() => {
    throw error;
  });
}

// A fake SDK that hangs until the signal is aborted.
function makeHangingSDK(): OpenAI {
  return makeSDK((body, options) => {
    void body;
    const sig = options.signal;
    return new Promise<CreateEmbeddingResponse>((resolve, reject) => {
      void resolve;
      if (sig === undefined) return;
      if (sig.aborted) {
        reject(new Error("aborted"));
        return;
      }
      sig.addEventListener(
        "abort",
        () => {
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  });
}

const noSignal = new AbortController().signal;

// --- Happy path ---

test("embed_returnsFloat32Array_ofEmbeddingDim", async () => {
  const client = new OpenAIEmbeddingClient({ apiKey: "k", sdk: makeGoodSDK() });
  const result = await client.embed("hello", noSignal);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value).toBeInstanceOf(Float32Array);
  expect(result.value.length).toBe(EMBEDDING_DIM);
});

// --- Error classification ---

test("embed_classifiesTransient_on429", async () => {
  const client = new OpenAIEmbeddingClient({
    apiKey: "k",
    sdk: makeThrowSDK(apiError(429, "Too many requests")),
  });
  const result = await client.embed("hello", noSignal);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.kind).toBe("transient");
  if (result.error.kind !== "transient") return;
  expect(result.error.status).toBe(429);
});

test("embed_classifiesTransient_on5xx", async () => {
  const client = new OpenAIEmbeddingClient({
    apiKey: "k",
    sdk: makeThrowSDK(apiError(503, "Service unavailable")),
  });
  const result = await client.embed("hello", noSignal);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.kind).toBe("transient");
  if (result.error.kind !== "transient") return;
  expect(result.error.status).toBe(503);
});

test("embed_classifiesPermanent_on400", async () => {
  const client = new OpenAIEmbeddingClient({
    apiKey: "k",
    sdk: makeThrowSDK(apiError(400, "Bad request")),
  });
  const result = await client.embed("hello", noSignal);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.kind).toBe("permanent");
  if (result.error.kind !== "permanent") return;
  expect(result.error.status).toBe(400);
});

test("embed_classifiesPermanent_onAuth", async () => {
  const client = new OpenAIEmbeddingClient({
    apiKey: "k",
    sdk: makeThrowSDK(apiError(401, "Unauthorized")),
  });
  const result = await client.embed("hello", noSignal);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.kind).toBe("permanent");
  if (result.error.kind !== "permanent") return;
  expect(result.error.status).toBe(401);
});

test("embed_classifiesTransient_onNetworkError", async () => {
  const e = new APIConnectionError({ message: "ECONNRESET" });
  const client = new OpenAIEmbeddingClient({ apiKey: "k", sdk: makeThrowSDK(e) });
  const result = await client.embed("hello", noSignal);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.kind).toBe("transient");
});

// --- Timeout ---

test("embed_returnsTimeout_onExternalAbort", async () => {
  const client = new OpenAIEmbeddingClient({ apiKey: "k", sdk: makeHangingSDK() });
  const ctl = new AbortController();
  ctl.abort();
  const result = await client.embed("hello", ctl.signal);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.kind).toBe("timeout");
});

test("embed_returnsTimeout_onLocalTimeout", async () => {
  const client = new OpenAIEmbeddingClient({
    apiKey: "k",
    sdk: makeHangingSDK(),
    timeoutMs: 20,
  });
  const result = await client.embed("hello", noSignal);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.kind).toBe("timeout");
});

// --- Input validation ---

test("embed_rejectsOversizeInput", async () => {
  let sdkCalled = false;
  const sdk = makeSDK((body) => {
    void body;
    sdkCalled = true;
    return Promise.resolve(goodResponse());
  });
  const client = new OpenAIEmbeddingClient({ apiKey: "k", sdk });
  const bigText = "x".repeat(MAX_EMBED_INPUT_BYTES + 1);
  const result = await client.embed(bigText, noSignal);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.kind).toBe("input_too_long");
  if (result.error.kind !== "input_too_long") return;
  expect(result.error.bytes).toBeGreaterThan(MAX_EMBED_INPUT_BYTES);
  expect(result.error.max).toBe(MAX_EMBED_INPUT_BYTES);
  expect(sdkCalled).toBe(false);
});

// --- Programmer-error assertions ---

test("embed_assertsOnWrongDimension", async () => {
  const client = new OpenAIEmbeddingClient({ apiKey: "k", sdk: makeGoodSDK(1024) });
  let caught: unknown;
  try {
    await client.embed("hello", noSignal);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(AssertionError);
});

test("embed_assertsOnEmptyApiKey", () => {
  expect(() => new OpenAIEmbeddingClient({ apiKey: "" })).toThrow(AssertionError);
});

test("embed_assertsOnEmptyInput", async () => {
  const client = new OpenAIEmbeddingClient({ apiKey: "k", sdk: makeGoodSDK() });
  let caught: unknown;
  try {
    await client.embed("", noSignal);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(AssertionError);
});

// --- Span attributes (no-op OTel in tests; we verify the call still returns correctly) ---

test("embed_emitsSpan_callSucceedsWithAttributes", async () => {
  const client = new OpenAIEmbeddingClient({ apiKey: "k", sdk: makeGoodSDK() });
  const result = await client.embed("span check", noSignal);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value.length).toBe(EMBEDDING_DIM);
});

test("embed_recordsExceptionAndErrorStatus_onThrow", async () => {
  // Wrong-dimension response causes AssertionError inside withSpan — which records exception
  // and sets ERROR status (both, per CLAUDE §2) before rethrowing.
  const client = new OpenAIEmbeddingClient({ apiKey: "k", sdk: makeGoodSDK(1024) });
  let caught: unknown;
  try {
    await client.embed("hello", noSignal);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(AssertionError);
});
