// FakeEmbeddingClient — deterministic, in-memory stand-in for tests.
// Returns a hash-seeded vector so the same text always produces the same output.
// Downstream tests (RELAY-131, RELAY-134, RELAY-142) import this instead of hitting the network.

import { err, ok } from "../../src/core/result.ts";
import type { Result } from "../../src/core/result.ts";
import { EMBEDDING_DIM } from "../../src/memory/limits.ts";
import type { EmbedError, EmbeddingClient } from "../../src/memory/embedding.ts";

export class FakeEmbeddingClient implements EmbeddingClient {
  private readonly forcedError: EmbedError | undefined;

  public constructor(opts: { error?: EmbedError } = {}) {
    this.forcedError = opts.error;
  }

  // Intentionally omits the `signal` parameter — fakes don't need cancellation.
  // TypeScript allows fewer parameters than the interface declares.
  public embed(text: string): Promise<Result<Float32Array, EmbedError>> {
    if (this.forcedError !== undefined) return Promise.resolve(err(this.forcedError));
    return Promise.resolve(ok(deterministicVector(text)));
  }
}

function deterministicVector(text: string): Float32Array {
  const vec = new Float32Array(EMBEDDING_DIM);
  let seed = 0;
  for (let i = 0; i < text.length; i++) {
    seed = (seed * 31 + text.charCodeAt(i)) & 0xffffffff;
  }
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    vec[i] = (seed / 0x100000000) * 2 - 1;
  }
  return vec;
}
