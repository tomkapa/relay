# CLAUDE.md — Relay engineering rules

How we write code for Relay. Binding, not advisory. Read `SPEC.md` for the data model and pipeline before non-trivial changes.

Priorities, in order: **correctness, safety, clarity, performance**.
Lineage: TigerBeetle TIGER_STYLE + NASA Power of Ten.

---

## 1. Types encode invariants. Primitives are the exception.

If a value has any invariant — logical or business — brand it. Raw `string` / `number` are reserved for values that genuinely have none.

```ts
declare const __brand: unique symbol;
export type Brand<T, B> = T & { readonly [__brand]: B };

export type Email      = Brand<string, "Email">;
export type AgentId    = Brand<string, "AgentId">;
export type SessionId  = Brand<string, "SessionId">;
export type TenantId   = Brand<string, "TenantId">;
export type Depth      = Brand<number, "Depth">;       // 0 ≤ depth ≤ DEPTH_CAP
export type Importance = Brand<number, "Importance">;  // 0 ≤ x ≤ 1
```

**Parse, don't validate.** Values cross into the typed world exactly once, at the boundary, through a smart constructor that returns the branded type or a typed error.

```ts
export const Email = {
  parse(raw: string): Email | ParseError {
    if (raw.length > 254) return { kind: "too_long" };
    if (!EMAIL_RE.test(raw)) return { kind: "malformed" };
    return raw as Email;
  },
};
```

- Brand every id. `string` for an id is a review-blocking bug.
- Brand every bounded numeric. The constructor enforces the bound.
- Parse every external input at the boundary. No `as` inside the core.
- Prefer tagged unions over booleans-plus-optionals. Exhaustive `switch` with a `never` default is how we prove the match is total.
- Schemas (zod) run only at the boundary and feed the branded constructors. Schemas produce types; they do not replace them.

## 2. OpenTelemetry is the only instrumentation API.

Traces, metrics, and logs go through `@opentelemetry/api` + `@opentelemetry/semantic-conventions`. No `console.log` in app code. No competing logger. A dev printer is allowed only behind `NODE_ENV !== "production"`.

**Spans.**
- Every externally-triggered unit of work opens a span via `tracer.startActiveSpan`.
- Names are stable and low-cardinality (`session.turn`, `hook.evaluate`). Dynamic values go on attributes, never in the name.
- Custom attributes use `relay.*`: `relay.agent.id`, `relay.session.id`, `relay.tenant.id`, `relay.chain.id`, `relay.depth`, `relay.hook.decision`.
- On error: `span.recordException(e)` **and** `span.setStatus({ code: SpanStatusCode.ERROR })`. Both. One without the other is a bug.
- Every span ends on every path. Use `try/finally`.

**Logs.**
- Go through `@opentelemetry/api-logs` so trace correlation is automatic.
- Structured only: severity + short event name + flat attribute bag. Never interpolate values into the message.
- Severity ∈ `DEBUG | INFO | WARN | ERROR | FATAL`. `ERROR` = user-visible failure; `FATAL` = process cannot continue.
- PII is `DEBUG`-only and redacted by production exporters.

**Metrics.**
- Every bounded loop has a saturation counter.
- Every queue has depth and age-of-oldest gauges.
- Hook decisions are counter attributes, not separate spans.

## 3. TDD. Failing test first. Gates are non-negotiable.

Write the failing test before the implementation. A PR without a preceding test commit is reverted.

**Cycle.**
1. **Red.** Smallest test that expresses the next behavior. Confirm it fails for the expected reason — not a compile error, not a typo.
2. **Green.** Minimum code to pass. Nothing the test does not force.
3. **Refactor.** Only with the suite green.

**Exit gates — all must be green:**
- `bun run lint` (`--max-warnings=0`)
- `bun run fmt --check`
- `bun run typecheck`
- `bun test`
- `bun run test:e2e` where E2E exists for the changed surface

Any gate red → task is not done. No commit, no PR, no "done".

**Test shape.**
- One behavior per test.
- Test observable behavior at a boundary. Never reach into private state.
- Real Postgres (testcontainers) in integration. Mock only paid external services and external HTTP.
- Coverage: 80% lines, 100% on the hook evaluator, per-agent lease manager, and idempotency-key generator.

## 4. Control flow: simple, explicit, bounded, non-recursive.

- **No recursion.** Replace with an explicit loop over a bounded stack or queue. A function calling itself is a review-blocking bug.
- **No clever abstractions.** Introduce one only when (a) it maps to a concept in `SPEC.md` and (b) the same code appeared ≥3 times saying the same thing. Three similar lines beats a premature abstraction.
- **Push `if`s up, `for`s down.** Branch at the top of the call tree; loop at the leaves over primitive data.
- **State invariants positively.** `if (depth < DEPTH_CAP)`, not `if (depth >= DEPTH_CAP) else`.
- **Split compound conditions.** `assert(a); assert(b);` beats `assert(a && b);`. Nested `if` beats `&&`-chained conditions.
- **Function length ≤ 70 lines.** Hard ceiling.
- Early-return guards are fine. Mid-function fast-path returns are fine. `return` buried deep inside a loop is not.

## 5. Everything has a limit. Enforce in code.

- Every `for` / `while` has an explicit upper bound, asserted on entry.
- Every queue has a `capacity`. Pushes past it fail fast; never silently resize.
- Every async op has a timeout — `fetch`, DB queries, any `await` on I/O. `ask` timeouts come from SPEC.
- Every batch has a size cap: `MAX_RETRIEVAL`, `MAX_HOOKS_PER_EVENT`, `MAX_TURNS_PER_COMPACTION`.
- Every string crossing a trust boundary has a length cap. No unbounded `TEXT` reads.
- Constants live in `limits.ts` per subsystem (e.g. `session/limits.ts`). Named, exported, commented with *why this number*. Magic numbers in logic are banned.

Unknown bound → pick a pessimistic one and add a metric to watch it.

## 6. Assertions detect programmer errors. Failure crashes the process.

- **Operating error** — expected (flaky network, bad input, DB contention). Return a typed error; handle; retry where safe.
- **Assertion failure** — unexpected. The code's model of the world is wrong. The only correct response is to crash; continuing corrupts more state.

- Use a real `assert` that throws `AssertionError`. Never soften it. In production, `AssertionError` terminates the worker; the lease expires and another worker resumes (SPEC §Retry and idempotency).
- Assert at boundaries: pre/post-conditions, invariants around compound updates, immediately after reads that should have a known shape.
- Assert both what you expect **and** what you don't. `assert(x > 0); assert(x < DEPTH_CAP);`
- Density: ≥2 assertions per non-trivial function.
- Keep assertions in production. Cost negligible, signal priceless.
- `assert` is for invariants; tagged-union `Result<T, E>` is for expected failures. Never mix.

## 7. Strictest compiler settings. Warnings are errors.

`tsconfig.json` extends `@tsconfig/strictest`, plus:

```jsonc
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "allowUnreachableCode": false,
    "allowUnusedLabels": false,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true
  }
}
```

ESLint: `@typescript-eslint` type-aware rules, `--max-warnings=0`. No tolerated warnings — fix the code or delete the rule with PR justification.

**Banned:**
- `any`, explicit or inferred. Use `unknown` and narrow.
- Non-null `!` (except in test fixtures).
- `@ts-ignore` / `@ts-expect-error` without a linked issue and expiry date.
- `eval`, `Function` constructor, dynamic `require`.
- Floating promises (`no-floating-promises`).
- Unhandled `switch` cases (exhaustive `never`).

## 8. Zero-dependency bias.

Every runtime dep costs supply-chain risk, install time, and surface area. Adding one requires a PR paragraph: what it does, why not <200 LOC in-tree, who owns the upgrade cadence. Dev deps: lower bar, not zero.

## 9. Static allocation at module boundaries.

Pools (DB, HTTP), caches, and rate-limiter state are sized at startup from config. Growing-on-demand structures inside a worker are banned — use a bounded data structure (§5).

## 10. No string concatenation into SQL. Ever.

Parameterized queries only, or a typed query builder. Dynamic identifiers (table, column names) pass through an allowlist, never a formatter. RLS (SPEC §Tenancy) defends against a missing `WHERE tenant_id`; this rule defends against injection.

## 11. Tests own the clock.

No test calls `Date.now()`, `performance.now()`, or `setTimeout` directly. Production code that needs time takes a `Clock` parameter — real clock in prod, controllable fake in tests. Flaky real timers are the single biggest waste of debugging hours.

## 12. One error type per module boundary.

Each module exports a tagged union describing every failure. Exhaustive `switch` (§1) forces every caller to handle every variant. `throw new Error("string")` across a module boundary is a review-blocking bug; `throw` is reserved for assertions (§6).

```ts
export type SessionError =
  | { kind: "lease_expired"; agent: AgentId }
  | { kind: "depth_exceeded"; depth: Depth }
  | { kind: "tenant_mismatch"; expected: TenantId; got: TenantId };
```

## 13. PR hygiene.

One logical change per PR. Mechanical refactors (rename, move, reformat) go in their own PR. Description answers *what changed, why now, what could break*. Mixed-concern PRs are reverted.

## 14. Migration discipline.

Every schema change has a forward migration and a tested reversible rollback, both verified against a staging dump before merge. Online migrations (`NOT NULL` on a large table, column-type change, non-concurrent index) require a written rollout plan in the PR. Never squash migrations after merge.