// Single choke point for hook evaluation. Writes an audit row on every call;
// enqueues a synthetic system message when the decision is deny + session is known.
// RELAY-139 (composition) and RELAY-141 (config pinning) extend this file, not call sites.

import type { Sql, TransactionSql } from "postgres";
import { assert } from "../core/assert.ts";
import type { Clock } from "../core/clock.ts";
import type { AgentId, SessionId, TenantId, TurnId } from "../ids.ts";
import { Attr, SpanName, counter, emit, withSpan } from "../telemetry/otel.ts";
import { insertHookAudit } from "./audit.ts";
import { MAX_DENY_REASON_CHARS } from "./limits.ts";
import { enqueuePendingSystemMessage } from "./pending.ts";
import type { HookDecision, HookEvent, HookLayer } from "./types.ts";

export type EvaluateHookInput = {
  // hook_id is TEXT (stub names like "system/session-start/stub") until hook_rules ships.
  readonly hookId: string;
  readonly layer: HookLayer;
  readonly event: HookEvent;
  readonly matcherResult: boolean;
  readonly tenantId: TenantId;
  readonly agentId: AgentId;
  readonly sessionId: SessionId | null;
  readonly turnId: TurnId | null;
  readonly toolName: string | null;
  readonly decide: () => Promise<HookDecision>;
};

export async function evaluateHook(
  tx: Sql | TransactionSql,
  clock: Clock,
  input: EvaluateHookInput,
): Promise<HookDecision> {
  assert(input.matcherResult, "evaluateHook: matcher must pass before decide is called");

  return withSpan(
    SpanName.HookEvaluate,
    {
      [Attr.HookId]: input.hookId,
      [Attr.HookLayer]: input.layer,
      [Attr.HookEvent]: input.event,
      [Attr.SessionId]: input.sessionId ?? "",
      [Attr.AgentId]: input.agentId,
      [Attr.TenantId]: input.tenantId,
      ...(input.turnId !== null ? { [Attr.TurnId]: input.turnId } : {}),
      ...(input.toolName !== null ? { [Attr.ToolName]: input.toolName } : {}),
    },
    async () => {
      const start = clock.monotonic();
      const decision = await input.decide();
      const latencyMs = Math.max(0, Math.round(clock.monotonic() - start));

      if (decision.decision === "deny") {
        assert(decision.reason.length > 0, "evaluateHook: deny must carry a non-empty reason");
        assert(
          decision.reason.length <= MAX_DENY_REASON_CHARS,
          "evaluateHook: deny reason exceeds cap",
          { len: decision.reason.length, max: MAX_DENY_REASON_CHARS },
        );
      }

      const auditResult = await insertHookAudit(tx, {
        hookId: input.hookId,
        layer: input.layer,
        event: input.event,
        matcherResult: input.matcherResult,
        decision: decision.decision,
        reason: decision.decision === "deny" ? decision.reason : null,
        latencyMs,
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        agentId: input.agentId,
        turnId: input.turnId,
        toolName: input.toolName,
      });
      assert(auditResult.ok, "evaluateHook: audit write failed");

      // session_end fires after the session is already closed — no next turn will drain
      // a pending message, so skip the enqueue for this observational event.
      if (decision.decision === "deny" && input.sessionId !== null && input.event !== "session_end") {
        const enqueueResult = await enqueuePendingSystemMessage(tx, {
          tenantId: input.tenantId,
          targetSessionId: input.sessionId,
          kind: "hook_deny",
          hookAuditId: auditResult.value.id,
          content: buildDenyContent(input.event, decision.reason, input.toolName),
        });
        assert(enqueueResult.ok, "evaluateHook: pending-message enqueue failed");

        counter("relay.hook.pending_message_enqueued_total").add(1, {
          [Attr.HookEvent]: input.event,
          [Attr.HookLayer]: input.layer,
          [Attr.TenantId]: input.tenantId,
        });
        emit("DEBUG", "hook.pending_enqueued", {
          [Attr.SessionId]: input.sessionId,
          [Attr.HookEvent]: input.event,
        });
      }

      counter("relay.hook.evaluation_total").add(1, {
        [Attr.HookLayer]: input.layer,
        [Attr.HookEvent]: input.event,
        [Attr.HookDecision]: decision.decision,
        [Attr.TenantId]: input.tenantId,
        ...(input.toolName !== null ? { [Attr.ToolName]: input.toolName } : {}),
      });

      return decision;
    },
  );
}

function buildDenyContent(event: HookEvent, reason: string, toolName: string | null): string {
  // Stable prefix so agents trained on this platform learn to recognize hook denies.
  // Tool-use events include the tool name for cross-reference with the inline tool_result.
  const target = toolName !== null ? `${event}[${toolName}]` : event;
  return `[relay:hook_deny ${target}] ${reason}`;
}
