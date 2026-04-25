// Unit tests for HookConfigSnapshot and snapshotHookConfig.
// No Postgres needed — the snapshot reads the in-process registry.

import { afterEach, describe, expect, test } from "bun:test";
import { FakeClock } from "../../../src/core/clock.ts";
import { assert } from "../../../src/core/assert.ts";
import { HookConfigSnapshotId, HookRecordId } from "../../../src/ids.ts";
import { __clearRegistryForTesting, registerHook } from "../../../src/hook/registry.ts";
import { snapshotHookConfig } from "../../../src/hook/snapshot.ts";
import { HOOK_EVENT } from "../../../src/hook/types.ts";

function hookId(tag: string) {
  const r = HookRecordId.parse(tag);
  assert(r.ok, `fixture: invalid HookRecordId: ${tag}`);
  return r.value;
}

afterEach(() => {
  __clearRegistryForTesting();
});

describe("snapshotHookConfig", () => {
  test("fresh id per call: two snapshots have distinct ids", () => {
    const clock = new FakeClock(1_000_000);
    const s1 = snapshotHookConfig(clock);
    const s2 = snapshotHookConfig(clock);
    expect(s1.id as string).not.toBe(s2.id as string);
  });

  test("id is a valid HookConfigSnapshotId (UUID)", () => {
    const clock = new FakeClock(1_000_000);
    const snap = snapshotHookConfig(clock);
    // mintId produces a UUID; round-tripping through parse confirms UUID shape.
    const r = HookConfigSnapshotId.parse(snap.id);
    expect(r.ok).toBe(true);
  });

  test("takenAt matches clock.now() at snapshot time", () => {
    const clock = new FakeClock(5_000_000);
    const snap = snapshotHookConfig(clock);
    expect(snap.takenAt.getTime()).toBe(5_000_000);
  });

  test("takenAt reflects the clock value at call time (not later)", () => {
    const clock = new FakeClock(1_000_000);
    const snap = snapshotHookConfig(clock);
    clock.advance(9_000_000);
    // snapshot was taken at 1_000_000, not after advancing
    expect(snap.takenAt.getTime()).toBe(1_000_000);
  });

  test("forEvent returns empty frozen array when no hooks registered", () => {
    const clock = new FakeClock(0);
    const snap = snapshotHookConfig(clock);
    const rules = snap.forEvent(HOOK_EVENT.PreToolUse);
    expect(rules.length).toBe(0);
    expect(Object.isFrozen(rules)).toBe(true);
    // Same reference returned each call — EMPTY_BUCKET reuse
    expect(snap.forEvent(HOOK_EVENT.PreToolUse)).toBe(snap.forEvent(HOOK_EVENT.PreToolUse));
  });

  test("forEvent returns hooks in registration order for populated events", () => {
    const clock = new FakeClock(0);

    registerHook({
      id: hookId("system/pre_tool_use/first"),
      layer: "system",
      event: HOOK_EVENT.PreToolUse,
      matcher: () => true,
      decision: () => Promise.resolve({ decision: "approve" }),
    });
    registerHook({
      id: hookId("system/pre_tool_use/second"),
      layer: "system",
      event: HOOK_EVENT.PreToolUse,
      matcher: () => true,
      decision: () => Promise.resolve({ decision: "approve" }),
    });

    const snap = snapshotHookConfig(clock);
    const rules = snap.forEvent(HOOK_EVENT.PreToolUse);
    expect(rules.length).toBe(2);
    expect(rules[0]?.id as string).toBe("system/pre_tool_use/first");
    expect(rules[1]?.id as string).toBe("system/pre_tool_use/second");
  });

  test("forEvent for a different event is not affected by hooks registered for another event", () => {
    const clock = new FakeClock(0);

    registerHook({
      id: hookId("system/session_start/only-session"),
      layer: "system",
      event: HOOK_EVENT.SessionStart,
      matcher: () => true,
      decision: () => Promise.resolve({ decision: "approve" }),
    });

    const snap = snapshotHookConfig(clock);
    expect(snap.forEvent(HOOK_EVENT.PreToolUse).length).toBe(0);
    expect(snap.forEvent(HOOK_EVENT.SessionStart).length).toBe(1);
  });

  test("THE DECISIVE TEST: snapshot is immutable after registry mutation", () => {
    const clock = new FakeClock(0);

    registerHook({
      id: hookId("system/pre_tool_use/hook-a"),
      layer: "system",
      event: HOOK_EVENT.PreToolUse,
      matcher: () => true,
      decision: () => Promise.resolve({ decision: "approve" }),
    });

    const snap = snapshotHookConfig(clock);

    // Mutate the registry: clear and register a different hook
    __clearRegistryForTesting();
    registerHook({
      id: hookId("system/pre_tool_use/hook-b"),
      layer: "system",
      event: HOOK_EVENT.PreToolUse,
      matcher: () => true,
      decision: () => Promise.resolve({ decision: "deny", reason: "replaced" }),
    });

    // Snapshot must still see only hook-a, not hook-b
    const rules = snap.forEvent(HOOK_EVENT.PreToolUse);
    expect(rules.length).toBe(1);
    expect(rules[0]?.id as string).toBe("system/pre_tool_use/hook-a");
  });

  test("snapshot is shallowly frozen", () => {
    const clock = new FakeClock(0);
    const snap = snapshotHookConfig(clock);
    expect(Object.isFrozen(snap)).toBe(true);
  });

  test("returned rule arrays are frozen (copy-on-snapshot)", () => {
    const clock = new FakeClock(0);

    registerHook({
      id: hookId("system/session_start/one"),
      layer: "system",
      event: HOOK_EVENT.SessionStart,
      matcher: () => true,
      decision: () => Promise.resolve({ decision: "approve" }),
    });

    const snap = snapshotHookConfig(clock);
    const rules = snap.forEvent(HOOK_EVENT.SessionStart);
    expect(Object.isFrozen(rules)).toBe(true);
  });

  test("multi-layer hooks: forEvent returns rules from all layers in LAYER_ORDER", () => {
    const clock = new FakeClock(0);

    registerHook({
      id: hookId("system/session_start/sys"),
      layer: "system",
      event: HOOK_EVENT.SessionStart,
      matcher: () => true,
      decision: () => Promise.resolve({ decision: "approve" }),
    });
    registerHook({
      id: hookId("system/session_start/org"),
      layer: "organization",
      event: HOOK_EVENT.SessionStart,
      matcher: () => true,
      decision: () => Promise.resolve({ decision: "approve" }),
    });
    registerHook({
      id: hookId("system/session_start/agt"),
      layer: "agent",
      event: HOOK_EVENT.SessionStart,
      matcher: () => true,
      decision: () => Promise.resolve({ decision: "approve" }),
    });

    const snap = snapshotHookConfig(clock);
    const rules = snap.forEvent(HOOK_EVENT.SessionStart);
    expect(rules.length).toBe(3);
    // LAYER_ORDER: system → organization → agent
    expect(rules[0]?.layer).toBe("system");
    expect(rules[1]?.layer).toBe("organization");
    expect(rules[2]?.layer).toBe("agent");
  });
});
