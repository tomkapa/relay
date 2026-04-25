// runHooks orchestrator. Outer loop iterates LAYER_ORDER (system → organization → agent);
// inner loop runs each rule in the bucket via evaluateHookRecord + evaluateHook.
// Cross-layer deny short-circuits the outer loop; modify chains thread one running payload
// from the first system rule through the last agent rule. RELAY-139.

import type { Sql, TransactionSql } from "postgres";
import { assert, assertNever } from "../core/assert.ts";
import type { Clock } from "../core/clock.ts";
import type { AgentId, SessionId, TenantId, TurnId } from "../ids.ts";
import { Attr, SpanName, counter, emit, withSpan } from "../telemetry/otel.ts";
import { evaluateHook } from "./evaluate.ts";
import { MAX_HOOKS_PER_EVENT } from "./limits.ts";
import { evaluateHookRecord } from "./record.ts";
import { LAYER_ORDER, getRulesForEvent } from "./registry.ts";
import type { Hook, HookDecision, HookEvent, HookLayer } from "./types.ts";

export type AggregateDecision<P> = HookDecision<P>;

export type RunHooksContext = {
  readonly tenantId: TenantId;
  readonly agentId: AgentId;
  readonly sessionId: SessionId | null;
  readonly turnId: TurnId | null;
  readonly toolName: string | null;
  readonly event: HookEvent;
};

export async function runHooks<P>(
  tx: Sql | TransactionSql,
  clock: Clock,
  ctx: RunHooksContext,
  initialPayload: P,
): Promise<AggregateDecision<P>> {
  // Fast path: all layers empty → approve with no span, no audit rows.
  // In MVP this is the common path — org/agent are always empty and many events
  // have no system rules registered.
  if (LAYER_ORDER.every((layer) => getRulesForEvent(layer, ctx.event).length === 0)) {
    return { decision: "approve" };
  }

  return withSpan(
    SpanName.HookRun,
    {
      [Attr.HookEvent]: ctx.event,
      [Attr.SessionId]: ctx.sessionId ?? "",
      [Attr.AgentId]: ctx.agentId,
      [Attr.TenantId]: ctx.tenantId,
      ...(ctx.turnId !== null ? { [Attr.TurnId]: ctx.turnId } : {}),
      ...(ctx.toolName !== null ? { [Attr.ToolName]: ctx.toolName } : {}),
    },
    async () => {
      let runningPayload: P = initialPayload;
      let aggregate: AggregateDecision<P> = { decision: "approve" };

      // Outer loop: SPEC-mandated layer order. Deny anywhere short-circuits all remaining layers.
      // Modify threads one running payload across all layers — layer boundaries are invisible to
      // the chain. All matched rules in each layer fire unless a deny stops the bucket early.
      outer: for (const layer of LAYER_ORDER) {
        const rules = getRulesForEvent(layer, ctx.event);

        // Empty bucket — fast path; no audit, no telemetry beyond the wrapping span.
        // In MVP this is the org/agent path on every call.
        if (rules.length === 0) continue;

        assert(
          rules.length <= MAX_HOOKS_PER_EVENT,
          "runHooks: bucket exceeds MAX_HOOKS_PER_EVENT at runtime",
          { layer, event: ctx.event, count: rules.length, max: MAX_HOOKS_PER_EVENT },
        );

        const bucketDecision = await runOneLayer(tx, clock, layer, ctx, rules, runningPayload);

        switch (bucketDecision.decision) {
          case "approve":
            break;
          case "modify":
            runningPayload = bucketDecision.payload;
            aggregate = { decision: "modify", payload: runningPayload };
            break;
          case "deny":
            aggregate = { decision: "deny", reason: bucketDecision.reason };
            counter("relay.hook.cross_layer_short_circuit_total").add(1, {
              [Attr.HookLayer]: layer,
              [Attr.HookEvent]: ctx.event,
              [Attr.TenantId]: ctx.tenantId,
            });
            emit("INFO", "hook.bucket_denied", {
              [Attr.HookEvent]: ctx.event,
              [Attr.HookLayer]: layer,
              [Attr.SessionId]: ctx.sessionId ?? "",
              reason: bucketDecision.reason,
            });
            break outer; // SPEC §Composition: deny short-circuits the entire pipeline
          default:
            assertNever(bucketDecision, "runHooks: unexpected bucket decision");
        }
      }

      counter("relay.hook.run_total").add(1, {
        [Attr.HookEvent]: ctx.event,
        [Attr.HookDecision]: aggregate.decision,
        [Attr.TenantId]: ctx.tenantId,
      });

      return aggregate;
    },
  );
}

// Per-layer inner loop. Returns the bucket's aggregate decision.
// Factored from the outer loop so RELAY-141 can swap how `rules` is sourced for
// org/agent layers (pinned config snapshot) without touching composition logic.
async function runOneLayer<P>(
  tx: Sql | TransactionSql,
  clock: Clock,
  layer: HookLayer,
  ctx: RunHooksContext,
  rules: readonly Hook<unknown>[],
  initialPayload: P,
): Promise<HookDecision<P>> {
  let runningPayload: P = initialPayload;
  let modified = false;

  for (const rule of rules) {
    // Cast: registry stores Hook<unknown>; caller's P must match the event type.
    // RELAY-140 per-event-typed sub-maps will erase this cast.
    const evalResult = await evaluateHookRecord(rule as unknown as Hook<P>, runningPayload);

    if (!evalResult.matched) {
      counter("relay.hook.matcher_rejected_total").add(1, {
        [Attr.HookLayer]: layer,
        [Attr.HookEvent]: ctx.event,
        [Attr.HookId]: rule.id,
        [Attr.TenantId]: ctx.tenantId,
      });
      continue; // matcher rejected → no audit row (SPEC §Audit)
    }

    // Side-effects: audit row + optional pending system message (deny + session known).
    const decision = await evaluateHook(tx, clock, {
      hookId: rule.id,
      layer,
      event: ctx.event,
      matcherResult: true,
      tenantId: ctx.tenantId,
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      toolName: ctx.toolName,
      decide: () => Promise.resolve(evalResult.decision as HookDecision),
    });

    switch (decision.decision) {
      case "approve":
        break;
      case "deny":
        return { decision: "deny", reason: decision.reason }; // SPEC §Composition: deny short-circuits the bucket
      case "modify": {
        assert(decision.payload !== undefined, "runOneLayer: modify must carry payload", {
          hookId: rule.id,
        });
        runningPayload = (decision as HookDecision<P> & { decision: "modify" }).payload;
        modified = true;
        break;
      }
      default:
        assertNever(decision, "runOneLayer: unexpected decision variant");
    }
  }

  return modified ? { decision: "modify", payload: runningPayload } : { decision: "approve" };
}
