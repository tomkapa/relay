# Relay

*Platform for running agents that act on behalf of people, teams, or any group of interests.*

## Purpose

Relay runs agents. Each agent has an identity, a set of tools, a memory store, and rules about what it is allowed to do. The platform provides the runtime, persistence, and integration plumbing. Anything specific to an agent — what it knows, what it can call, who it can talk to — is configuration.

The goal is to keep the platform small and let new behavior land as configuration rather than as new subsystems.

## Data Model

Five entities. Most behavior is derived from how they connect.

**Agent** — system prompt, tool set, memory store, hook rules.

**Session** — a resumable conversational context with an agent, made up of turns (one model call per turn). Persisted with its originating trigger, parent session (if spawned by another session), `chain_id` and `depth` (for loop safety, see Hooks), turn transcript, and a `closed_at` timestamp (null while open, set when the session has fulfilled its purpose). "Active" is derived from holding the per-agent execution lease; "suspended" is the absence of a lease on an open session — neither is stored. Follow-up messages resume the same session rather than creating a new one.

**Task** — a deferred session. Has a trigger condition (cron schedule or event filter) and an intent string. When the condition matches, a session is created.

**Memory** — what an agent knows. Two layers in one store: raw events from the agent's history, and distilled facts. A periodic consolidation pass converts events into facts. Retrieval uses embedding similarity over both.

**Hook** — a rule that fires at a lifecycle point in the pipeline. Can approve, deny, or modify the action it intercepts.

**Agent creation.** An agent is created via a single API call carrying its full spec — system prompt, tool set, hook rules, seed memory, and initial scheduled tasks. All pieces are written in one transaction; every piece flows through its normal insertion path (hook rules, memory entries, and tasks are inserted the same way as any runtime addition, and hooks fire on creation regardless of source). Seed memory goes into the memory store as regular entries, subject to normal consolidation and retrieval. For MVP, only humans (admins) create agents; agent-creating-agent is post-MVP.

## Pipeline

A session is created from a trigger, executed by a worker, and persisted. The shape:

1. Trigger arrives (message, event, or task firing).
2. Prompt is synthesized from the trigger payload and the agent's context.
3. Agentic loop executes — turns alternate between model calls and tool calls. Sessions may yield during synchronous tool waits or suspend at turn boundary on async sends; see Execution Model.
4. Hooks fire at lifecycle points (see Hooks).
5. Session completes, results are written back, response is returned to the trigger source if applicable.

Prompt synthesis depends on trigger kind. The rest of the pipeline does not.

## Execution Model

Sessions run under two constraints: per-agent serialization and coroutine-style yielding.

**Per-agent serialization.** An agent executes one turn at a time. Multiple sessions can exist for the same agent simultaneously — they just take turns. One agent, many ongoing conversations, one active thought at a moment. Serialization is enforced by a per-agent execution lease held for the duration of an active turn; the lease renews during long model calls and expires on worker crash so another worker can resume from the last persisted yield point.

**Yield points.** A session releases its execution slot at defined boundaries so other sessions for the same agent can run. Two yield shapes:

- *Synchronous tool calls* (web_fetch, db_query, MCP calls): bounded wait. The session yields the slot while awaiting the tool result, then resumes the same turn when the result arrives. Fast in-process tools below a threshold run inline without yielding.
- *Async sends* — two tools, distinguished by intent:
  - `ask(target, content)` — terminating. The agent expects a reply and cannot proceed without it. After the turn's emitted actions execute, the session suspends and resumption happens when any inbound message arrives.
  - `notify(target, content)` — fire-and-forget. Dispatches at the turn boundary; the turn does not block on it. If the recipient does later reply, the reply arrives as an inbound message and resumes the session in a future turn just like any other inbound.

  A turn may mix `ask` and `notify` freely. If the turn issued one or more `ask`s, the session suspends after the boundary. If it issued only `notify`s (or no sends), the session continues to the next turn immediately when there is pending state to react to, or suspends if there is nothing left to process.

  Multiple `ask`s in one turn dispatch together; the platform does not wait for all replies. Any inbound resumes the session, and the agent's next turn sees what has arrived so far. Waiting-for-all is the *Batched reply waits* open question.

**Example.** A release-coordinator agent's turn emits, in order:

- `notify(docs_agent, "publish release notes for v2.1")` — fire-and-forget
- `db_query("SELECT count FROM users")` — synchronous tool, result returns inline
- `ask(security_reviewer, "approve deploy v2.1 to production?")` — terminating

At the boundary: `notify` and `ask` both dispatch, the `db_query` result is in context, and the session suspends. When the reviewer replies "approved", the session resumes for a new turn that can act on the reply (e.g. emit `deploy_app("approved")`). If `docs_agent` later acks the notify, that reply also arrives as an inbound and resumes the session — the agent's prompt decides what, if anything, to do with it.

Yield points must be serializable — session state is persisted so any worker can pick up the suspended session. Workers hold no per-session state between yields.

**Reentrancy and cycles.** Because suspended sessions wait for "any inbound message" rather than blocking on a specific reply, cycles cannot deadlock. If A messages B which messages C which messages back to A, A's session is suspended and the inbound from C resumes it for a new turn. Causal chain IDs propagate across messages for loop detection and budgeting, not for correctness.

**Timeouts.** Every `ask` carries a timeout, configurable per call with a sane default. On expiry, a synthetic inbound message is injected into the waiting session — structured as `{type: "timeout", original_send_id, target, elapsed}` — and the agent's system prompt decides how to react (follow up, escalate, give up). `notify` has no timeout — it is fire-and-forget by definition. Timeouts prevent unbounded waits from accumulating invisibly.

**Compaction.** Long-lived sessions compact their transcript when it crosses a size threshold: older turns are summarized, recent turns preserved verbatim, tool calls and results collapsed into structured summaries. Raw turns remain in the append-only event store for audit; compaction only rewrites the working context. Compaction takes the per-agent slot like any other turn.

## Triggers

Three kinds today:

- **Message** — from a human, an agent, or an external system.
- **Event** — from a watched source (webhook push, scheduled poll).
- **Scheduled task firing** — a task whose condition just matched.

Tasks can be created by any path with appropriate permission: an agent calling a `schedule_task` tool, a connector reacting to an event, an admin via the UI, a migration script. Hooks gate creation regardless of the source.

## Hooks

Hooks are pure functions from event payload to decision. They fire at concrete lifecycle points in the pipeline, have bounded runtime, hold no state, and return `approve`, `deny`, or `modify`. There is no "escalate" outcome — escalation is a denied action followed by the agent calling `ask` to an approver, flowing through the same pipeline as any other message.

**Lifecycle events.**

- `SessionStart` / `SessionEnd`
- `PreToolUse` / `PostToolUse`
- `PreMessageReceive` — incoming message.
- `PreMessageSend` — outgoing message.

**Three layers.** Hooks compose in three scopes, evaluated in order:

- **System** — platform-owned, not configurable. Built-ins: authorization (can this sender talk to this agent), tenant isolation (can this agent touch this resource), loop safety, rate limits, audit enforcement. Implemented in platform code but run through the same evaluator as custom hooks so the audit trail is uniform.
- **Organization** — tenant-scoped policies.
- **Agent** — scoped to one agent.

**Composition.** All matching hooks in all layers run. Any `deny` short-circuits the pipeline. `modify` outputs compose in order — the next hook sees the modified payload. Short-circuit-on-first-match is deliberately not used; it creates a "I thought my deny rule ran" class of bug.

**Hook shape.** Each hook is `{event, matcher, decision}`. The matcher is a predicate over the event payload; the decision runs only if the matcher passes. Separating them keeps matchers fast (evaluated on every event) while allowing decisions to be slower when needed.

**Decision mechanisms.**

- *Declarative predicates* — primary path. A sandboxed expression language (CEL-style) over the event payload. Safe, fast, covers the majority of real hook needs: auth checks, arg filtering, target allowlists, threshold checks.
- *LLM-as-judge* — post-MVP. An opt-in escape hatch for hooks whose decision can't be expressed in CEL. Deferred because LLM calls inside hooks compound per-agent serialization latency and need a separate execution lane to be safe.
- No arbitrary code, no shell commands, no customer webhooks in MVP.

**Versioning.** Hook config pins at turn start. Mid-turn config changes do not affect the in-flight turn.

**Audit.** Every hook evaluation is logged — `{hook_id, layer, event, matcher_result, decision, reason, latency_ms}`. Mandatory for system hooks. When a hook denies, the `reason` string is surfaced to the model as a synthetic system message in the next turn so the agent can reason about the denial rather than see an opaque failure.

**Loop safety.** Every session carries a `chain_id` and `depth`. Fresh triggers (user messages, cron firings, untraceable webhooks) mint a new chain_id at depth 0. Any session spawned by another — via message, task, or event produced by it — inherits the chain_id and increments depth by 1. Two system hooks run at `SessionStart`:

- *Depth cap* — denies when the chain's depth exceeds a threshold. Catches traceable loops like agent-to-agent ping-pong.
- *Per-agent rate cap* — denies when an agent's session count exceeds a threshold within a rolling window. Catches loops that pass through external systems and lose chain_id along the way.

Both checks fire through the standard hook evaluator, so denies are logged and reasoned about like any other deny. Tagging outbound writes so returning webhooks inherit the chain, correlation windows for untagged sources, per-agent budget tuning, and chain total-session caps for fan-out are post-MVP enhancements.

## Communication

Agent-to-agent, user-to-agent, and system-to-agent messages all use the same shape: a message with a sender and a target. The sender's `PreMessageSend` hook fires; if it passes, the target's `PreMessageReceive` hook fires; if it passes, the target's session processes the message. Sender type (human, agent, system) is metadata on the message.

Messaging is asynchronous. Agents send messages through two tools — `ask` (terminating, expects a reply) and `notify` (fire-and-forget) — described in Execution Model — Yield points. Replies, when they arrive, resume the session one turn at a time, and the agent's system prompt is responsible for reasoning about partial state (e.g. holding action until all expected replies arrive).

**Session linking.** When an agent calls `ask` or `notify` to another agent, a session is created on the target side with `parent_session_id` set to the sender's session. The linkage is directional and supports upstream traversal ("what user request originated this chain?") by walking the parent chain. While the sender's session remains open (`closed_at IS NULL`), subsequent messages to the same counterpart resume the existing child session rather than creating a new one — context carries forward. Once the sender's session is closed, a later call to the same counterpart starts a fresh child session.

## Memory

Events are append-only. Facts are rewritten by the consolidation pass. Seed memory can be loaded from agent configuration when an agent is created.

**Entry shape.** Each memory entry stores `text`, `embedding`, `importance ∈ [0,1]`, `created_at`, `last_retrieved_at`, `retrieval_count`.

**Importance — set at write time.** Three sources, in priority order:

- *Explicit, from the agent.* Memory writes go through a `remember(text, importance?)` tool. If the agent passes a value, that wins. Default if omitted: `0.5`.
- *Distilled, from the consolidator.* When the consolidation pass converts events into facts, it scores each fact's importance as one field in the same structured model output that produces the fact — near-zero marginal cost.
- *Usage-adjusted.* A periodic job nudges importance based on access: `importance = clamp(importance + 0.05 * log(1 + retrievals_last_30d) - 0.02 * months_since_last_retrieval, 0, 1)`. Frequently-used entries stay important; unused entries fade. Tunable constants; embeddings are not recomputed.

**Recency.** Computed at retrieval time, not stored: `recency_factor = exp(-age_days / half_life_days)`. Half-life configurable per agent (default 90 days).

**Retrieval score.** `score = similarity * (importance ^ alpha) * recency_factor`. `alpha` (default `1.0`) balances importance vs. similarity. Three tunables (default importance, half-life, alpha) cover the parameter space; a learned scorer can replace the formula later without schema change.

Keeping retrieval fast as history grows is a known concern, not yet designed. Likely involves partitioning, importance-based pruning, or both.

## Architecture

**Storage.** Postgres with pgvector for structured state — agents, sessions, tasks, memory, hook rules, audit trail. Object storage (S3 or MinIO) for blobs. Redis (or equivalent) for ephemeral runtime state such as leases, locks, and rate counters — never the source of truth.

**Runtime.** Stateless worker pool consumes a Postgres-backed work queue. A worker picks up a unit of work, loads the agent, drives the agentic loop, and writes results back. Workers hold no per-agent state.

**Integration.** An owned connector layer normalizes external systems into platform events. Three connector shapes:

- Webhook receivers (push) — normalize and enqueue a session.
- Pollers (pull) — same, on a schedule.
- MCP tools (agent-initiated calls during a session) — these do not enqueue sessions; they return data to the live session.

**Connector state.** Most connectors are stateless; only pollers require persistent runtime state. Each poller stores a cursor on its connector row; cursor updates and session enqueues happen in a single Postgres transaction so records are neither lost nor duplicated. Webhook receivers are stateless per-request beyond their configured secret used for signature verification. MCP tools hold no state. Connector config (including secrets) is tenant-scoped Postgres rows, with secrets encrypted at rest.

Third-party workflow engines are not used; their plumbing overlaps with the platform's and their configuration model splits responsibility in awkward ways.

**Retry and idempotency.** A turn is assigned `turn_id` and persisted before any model call; the model call's full output (including `tool_call_id`s) is persisted before any tool executes. Retries replay from the persisted output, so `tool_call_id`s are stable across retries. Every platform-internal side effect (`schedule_task`, `ask`, `notify`, memory writes, audit entries) carries a deterministic idempotency key derived from `hash(session_id, turn_id, tool_call_id)` and dedups by this key, giving exactly-once semantics for anything under the platform's control. Workers retry on crash (via lease expiration) and transient infra errors; business-logic errors are surfaced to the agent as the turn's result rather than retried. External tool calls (via MCP or connectors) may duplicate on worker retry — this is a known MVP limitation. Passing idempotency keys through to external services, trigger-level deduplication, sagas, and dead-letter queues are post-MVP.

**Tenancy.** One tenant = one organization. All entities (agents, sessions, tasks, memory, connectors, hook rules, users) carry `tenant_id`; every query is scoped by it. Agents can only message agents in the same tenant; a system hook at `PreMessageSend` enforces this. MVP uses a shared schema with application-layer scoping plus Postgres Row-Level Security as defense-in-depth — RLS policies on every tenant-scoped table reject queries lacking the session-set `tenant_id` GUC, so a missing `WHERE tenant_id = ?` in application code fails closed instead of leaking. Connectors are tenant-scoped, memory is tenant-scoped by construction (via its owning agent), and the work queue is shared across tenants. Per-tenant queue fairness, quotas, multi-org users, and schema-per-tenant or DB-per-tenant isolation for compliance customers are post-MVP.

## Open Design Questions

These do not change the shape of the platform, but each needs an answer before or during implementation.

- **Stateful hook lookups.** Hooks are pure functions, but some real policies need state — rate limits, sliding windows, "has this sender messaged this agent N times this hour." Future enhancement: platform-maintained counters and lookups exposed as readable fields on the event payload (e.g. `event.sender.rate_1h`), so hooks query but never maintain state themselves. Not in v1; customer-supplied state is explicitly out of scope.
- **Observability and audit.** What is logged, how sessions are inspected, what the audit trail captures, retention.
- **Batched reply waits.** Whether to add an opt-in flag on `send_message` to group a batch and only resume the session once all replies (or a timeout) arrive — Promise.all-shaped. Not needed for v1, but the tool signature should not preclude it.

## Extending Relay

When a new requirement arrives, the first check is against the data model: can it be expressed as agents, sessions, tasks, memory, and hooks, plus a trigger?

If yes, it is configuration: a new system prompt, a new hook rule, a new tool, a new connector, a new task. No platform change.

If no, that is a real signal — either the requirement is an existing entity wearing a costume, or the data model is genuinely missing something. Adding to the data model is a deliberate decision, not a per-feature escape hatch.
