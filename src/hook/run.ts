// runHooks orchestrator. Iterates the system-layer bucket for one event, runs each
// rule through evaluateHookRecord, writes the audit row via evaluateHook for matched
// rules, and composes within-bucket decisions (deny short-circuits; modify chains
// payload). RELAY-139 adds cross-layer (system → org → agent) outer loop.

import type { Sql, TransactionSql } from "postgres";
import { assert, assertNever } from "../core/assert.ts";
import type { Clock } from "../core/clock.ts";
import type { AgentId, SessionId, TenantId, TurnId } from "../ids.ts";
import { Attr, SpanName, counter, emit, withSpan } from "../telemetry/otel.ts";
import { evaluateHook } from "./evaluate.ts";
import { MAX_HOOKS_PER_EVENT } from "./limits.ts";
import { evaluateHookRecord } from "./record.ts";
import { getRulesForEvent } from "./registry.ts";
import type { Hook, HookDecision, HookEvent } from "./types.ts";

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
  const rules = getRulesForEvent(ctx.event);

  // Fast path: empty bucket → approve with no audit rows or telemetry.
  // SPEC §Audit: "every matched evaluation writes a row" — zero rules means zero matches.
  if (rules.length === 0) {
    return { decision: "approve" };
  }

  assert(
    rules.length <= MAX_HOOKS_PER_EVENT,
    "runHooks: bucket exceeds MAX_HOOKS_PER_EVENT at runtime",
    { event: ctx.event, count: rules.length, max: MAX_HOOKS_PER_EVENT },
  );

  return withSpan(
    SpanName.HookRun,
    {
      [Attr.HookEvent]: ctx.event,
      [Attr.HookLayer]: "system",
      [Attr.SessionId]: ctx.sessionId ?? "",
      [Attr.AgentId]: ctx.agentId,
      [Attr.TenantId]: ctx.tenantId,
    },
    async () => {
      let runningPayload: P = initialPayload;
      let aggregate: AggregateDecision<P> = { decision: "approve" };

      outerLoop: for (const rule of rules) {
        // Cast: registry stores Hook<unknown>; caller's P must match the event type.
        // RELAY-140 per-event-typed sub-maps will erase this cast.
        const evalResult = await evaluateHookRecord(rule as unknown as Hook<P>, runningPayload);

        if (!evalResult.matched) {
          counter("relay.hook.matcher_rejected_total").add(1, {
            [Attr.HookEvent]: ctx.event,
            [Attr.HookLayer]: rule.layer,
            [Attr.HookId]: rule.id,
            [Attr.TenantId]: ctx.tenantId,
          });
          continue;
        }

        // Side-effects: audit row + optional pending system message (deny + session).
        // decide() returns what evaluateHookRecord already computed — the call is purely
        // for the write path in evaluateHook.
        await evaluateHook(tx, clock, {
          hookId: rule.id,
          layer: rule.layer,
          event: ctx.event,
          matcherResult: true,
          tenantId: ctx.tenantId,
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          turnId: ctx.turnId,
          toolName: ctx.toolName,
          decide: () => Promise.resolve(evalResult.decision as HookDecision),
        });

        const d = evalResult.decision;
        switch (d.decision) {
          case "approve":
            break;
          case "deny":
            aggregate = { decision: "deny", reason: d.reason };
            emit("INFO", "hook.bucket_denied", {
              [Attr.SessionId]: ctx.sessionId ?? "",
              [Attr.HookEvent]: ctx.event,
              [Attr.HookId]: rule.id,
              [Attr.HookReason]: d.reason,
            });
            break outerLoop; // SPEC §Composition: deny short-circuits the bucket
          case "modify":
            assert(d.payload !== undefined, "runHooks: modify must carry a payload", {
              hookId: rule.id,
            });
            runningPayload = d.payload;
            aggregate = { decision: "modify", payload: runningPayload };
            break;
          default:
            assertNever(d, "runHooks: unexpected decision variant");
        }
      }

      counter("relay.hook.bucket_evaluation_total").add(1, {
        [Attr.HookEvent]: ctx.event,
        [Attr.HookLayer]: "system",
        [Attr.HookDecision]: aggregate.decision,
        [Attr.TenantId]: ctx.tenantId,
      });

      return aggregate;
    },
  );
}
