// Hook config snapshot. Taken once at turn start; insulates in-flight evaluation from
// registry mutations. RELAY-141 — SPEC §Hooks line 109: "Hook config pins at turn start."

import type { Clock } from "../core/clock.ts";
import { HookConfigSnapshotId, mintId } from "../ids.ts";
import { counter } from "../telemetry/otel.ts";
import { LAYER_ORDER, getRulesForEvent } from "./registry.ts";
import { HOOK_EVENT, type Hook, type HookEvent } from "./types.ts";

export type HookConfigSnapshot = {
  readonly id: HookConfigSnapshotId;
  readonly takenAt: Date;
  // Hook (= Hook<HookEvent>) is the widened union; callers narrow via .layer filter per LAYER_ORDER.
  readonly forEvent: (event: HookEvent) => readonly Hook[];
};

const EMPTY_BUCKET: readonly Hook[] = Object.freeze([]);
// Cached to avoid allocating a fresh array on every snapshot call.
const ALL_HOOK_EVENTS: readonly HookEvent[] = Object.freeze(Object.values(HOOK_EVENT));

export function snapshotHookConfig(clock: Clock): HookConfigSnapshot {
  // Eager copy across all layers for each event. Bounded by |HookEvent| (6) × LAYER_ORDER (3)
  // × MAX_HOOKS_PER_EVENT (64) = 1152 max Hook references. CLAUDE.md §5: bound is asserted at
  // registerHook call site in registry.ts.
  const byEvent = new Map<HookEvent, readonly Hook[]>();
  let totalRules = 0;

  for (const event of ALL_HOOK_EVENTS) {
    const allRules: Hook[] = [];
    for (const layer of LAYER_ORDER) {
      // Cast from Hook<typeof event> to Hook is sound: Hook (= Hook<HookEvent>) is the widened
      // union used for heterogeneous storage; callers filter by layer before invoking matchers.
      allRules.push(...(getRulesForEvent(layer, event) as unknown as Hook[]));
    }
    totalRules += allRules.length;
    byEvent.set(event, Object.freeze(allRules));
  }

  const id = mintId(HookConfigSnapshotId.parse, "snapshotHookConfig");
  const takenAt = new Date(clock.now());

  counter("relay.hook.snapshot_taken_total").add(1, {
    rule_count: totalRules,
    layer_count: 1, // one source (static in-tree registry) today; widens with RELAY-139
  });

  return Object.freeze({
    id,
    takenAt,
    forEvent: (event: HookEvent) => byEvent.get(event) ?? EMPTY_BUCKET,
  });
}
