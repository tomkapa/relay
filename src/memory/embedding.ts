// EmbeddingClient interface and EmbedError tagged union.
// Core and downstream tasks import only this seam — never the concrete adapter.

import type { Result } from "../core/result.ts";

export type EmbedError =
  | { readonly kind: "transient"; readonly status?: number; readonly message: string }
  | { readonly kind: "permanent"; readonly status?: number; readonly message: string }
  | { readonly kind: "input_too_long"; readonly bytes: number; readonly max: number }
  | { readonly kind: "timeout"; readonly elapsedMs: number };

export interface EmbeddingClient {
  embed(text: string, signal: AbortSignal): Promise<Result<Float32Array, EmbedError>>;
}
