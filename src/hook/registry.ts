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

// Pre-allocate all three layer maps at module init. Static allocation per CLAUDE.md §9.
// Org and agent buckets are always empty in MVP production until RELAY-141 + RELAY-225 land.
const registry = new Map<HookLayer, Map<HookEvent, Hook<unknown>[]>>([
  ["system", new Map<HookEvent, Hook<unknown>[]>()],
  ["organization", new Map<HookEvent, Hook<unknown>[]>()],
  ["agent", new Map<HookEvent, Hook<unknown>[]>()],
]);

export function registerHook<P>(hook: Hook<P>): void {
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

  // Cast to Hook<unknown> for heterogeneous storage. Payload type discipline is enforced
  // at the call site. RELAY-140 will replace this with per-event-typed sub-maps.
  bucket.push(hook as Hook<unknown>);
  layerMap.set(hook.event, bucket);
}

export function getRulesForEvent(layer: HookLayer, event: HookEvent): readonly Hook<unknown>[] {
  return registry.get(layer)?.get(event) ?? [];
}

// Test-only — clears all three layer maps between test cases so tests are hermetic.
// Production code must never call this; the process-global registry is sized at startup.
export function __clearRegistryForTesting(): void {
  for (const layer of LAYER_ORDER) {
    registry.get(layer)?.clear();
  }
}
