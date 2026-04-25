// Module-local hook registry. Static lifetime — populated at startup before any worker
// leases run; never mutated after warm-up except by __clearRegistryForTesting().
// CLAUDE.md §9 — static allocation at module boundaries.

import { assert } from "../core/assert.ts";
import { MAX_HOOKS_PER_EVENT } from "./limits.ts";
import type { Hook, HookEvent } from "./types.ts";

const registry = new Map<HookEvent, Hook<unknown>[]>();

export function registerHook<P>(hook: Hook<P>): void {
  assert(hook.layer === "system", "registerHook: only system layer supported in RELAY-138", {
    hookId: hook.id,
    layer: hook.layer,
  });

  const bucket = registry.get(hook.event) ?? [];

  assert(
    bucket.length < MAX_HOOKS_PER_EVENT,
    "registerHook: event bucket exceeds MAX_HOOKS_PER_EVENT",
    { event: hook.event, max: MAX_HOOKS_PER_EVENT },
  );

  assert(
    bucket.every((h) => h.id !== hook.id),
    "registerHook: duplicate hook id in event bucket",
    { hookId: hook.id, event: hook.event },
  );

  // Cast to Hook<unknown> for heterogeneous storage. Payload type discipline is enforced
  // at the call site: the caller must use the event's correct payload type. RELAY-140
  // will replace this with per-event-typed sub-maps that erase this cast.
  bucket.push(hook as Hook<unknown>);
  registry.set(hook.event, bucket);
}

export function getRulesForEvent(event: HookEvent): readonly Hook<unknown>[] {
  return registry.get(event) ?? [];
}

// Test-only — empties all buckets between test cases so tests are hermetic.
// Production code must never call this; the process-global registry is sized at startup.
export function __clearRegistryForTesting(): void {
  registry.clear();
}
