// Module-local hook registry. Static lifetime — populated at startup before any worker
// leases run; never mutated after warm-up except by __clearRegistryForTesting().
// CLAUDE.md §9 — static allocation at module boundaries.
//
// Registry is two-dimensional: layer → event → rules[]. Layer comes first because the
// orchestrator (runHooks) iterates layer-first; bucket lookup is O(1) per (layer, event).
// All three layer maps are pre-allocated at module init (RELAY-139 — no growing-on-demand).

import { assert } from "../core/assert.ts";
import { MAX_HOOKS_PER_EVENT } from "./limits.ts";
import type { Hook, HookEvent, HookLayer } from "./types.ts";

// SPEC-mandated evaluation order. Frozen so a careless reorder is a runtime error.
// Exported because runHooks and tests both depend on it — one source of truth.
export const LAYER_ORDER: readonly HookLayer[] = Object.freeze(["system", "organization", "agent"]);

// Bucket type stores Hook[] (Hook<HookEvent>) for heterogeneous storage across events.
// Type discipline is enforced at registerHook<E> call sites; getRulesForEvent<E> narrows on read.
// Pre-allocate all three layer maps at module init. Static allocation per CLAUDE.md §9.
const registry = new Map<HookLayer, Map<HookEvent, Hook[]>>([
  ["system", new Map<HookEvent, Hook[]>()],
  ["organization", new Map<HookEvent, Hook[]>()],
  ["agent", new Map<HookEvent, Hook[]>()],
]);

export function registerHook<E extends HookEvent>(hook: Hook<E>): void {
  assert(LAYER_ORDER.includes(hook.layer), "registerHook: unknown layer", {
    hookId: hook.id,
    layer: hook.layer,
  });

  const layerMap = registry.get(hook.layer);
  assert(layerMap !== undefined, "registerHook: layer map missing", { layer: hook.layer });

  const bucket = layerMap.get(hook.event) ?? [];

  assert(
    bucket.length < MAX_HOOKS_PER_EVENT,
    "registerHook: event bucket exceeds MAX_HOOKS_PER_EVENT",
    { layer: hook.layer, event: hook.event, max: MAX_HOOKS_PER_EVENT },
  );

  assert(
    bucket.every((h) => h.id !== hook.id),
    "registerHook: duplicate hook id in bucket",
    { hookId: hook.id, layer: hook.layer, event: hook.event },
  );

  // Cast from Hook<E> to Hook<HookEvent> for heterogeneous storage.
  // Sound by registration discipline: registerHook<E> only inserts into hook.event's bucket,
  // and the literal E is enforced at the call site, so cross-event insertion fails to compile.
  bucket.push(hook as unknown as Hook);
  layerMap.set(hook.event, bucket);
}

// Read a bucket narrowed to Hook<E>. The cast is sound by the same registration discipline:
// only registerHook<E> inserts into the E bucket, and event tag is the key.
export function getRulesForEvent<E extends HookEvent>(
  layer: HookLayer,
  event: E,
): readonly Hook<E>[] {
  return (registry.get(layer)?.get(event) ?? []) as unknown as readonly Hook<E>[];
}

// Test-only — clears all three layer maps between test cases so tests are hermetic.
// Production code must never call this; the process-global registry is sized at startup.
export function __clearRegistryForTesting(): void {
  for (const layer of LAYER_ORDER) {
    registry.get(layer)?.clear();
  }
}
