# Relay — Tech Stack

Grounded in [`SPEC.md`](./SPEC.md) (pipeline, Postgres + pgvector, OpenTelemetry) and
[`CLAUDE.md`](./CLAUDE.md) (Bun-scripted gates, strictest TypeScript, TDD with real Postgres,
zero-dependency bias). Every entry below pulls its weight — no choice here is aspirational.

## TL;DR

| Layer            | Pick                                                                |
| ---------------- | ------------------------------------------------------------------- |
| Language         | TypeScript with `@tsconfig/strictest`                               |
| Runtime          | Bun (runtime + test + package manager)                              |
| Lint / format    | ESLint (type-aware) + Prettier                                      |
| DB               | Postgres 16 + pgvector                                              |
| DB driver        | `postgres` (porsager) + Kysely for typed joins                      |
| Migrations       | `graphile-migrate` or hand-rolled runner (SPEC requires reversible) |
| Ephemeral state  | Redis via `ioredis` — leases, locks, rate counters only             |
| Blobs            | S3 / MinIO via `@aws-sdk/client-s3`                                 |
| LLM              | `@anthropic-ai/sdk` (prompt caching on by default)                  |
| Embeddings       | `openai` SDK → `text-embedding-3-small` (1536-dim)                  |
| Tool protocol    | `@modelcontextprotocol/sdk`                                         |
| Work queue       | Postgres-backed, `FOR UPDATE SKIP LOCKED`, hand-rolled              |
| Hook predicates  | CEL, in-tree evaluator                                              |
| HTTP             | Hono on `Bun.serve`                                                 |
| Boundary parsing | Zod → smart constructors → branded types                            |
| Observability    | `@opentelemetry/api` + `sdk-node` + OTLP/HTTP (only logger)         |
| Testing          | `bun test`, real Postgres, Playwright E2E, hand-rolled fake clock   |
| Crypto           | `node:crypto` + `@noble/ciphers`                                    |
| CI / CD          | GitHub Actions, Docker images for `worker` + `api`                  |

## Language & runtime

- **TypeScript** — single language. `tsconfig.json` extends `@tsconfig/strictest` with every
  CLAUDE §7 override pinned explicitly (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`, `isolatedModules`, and so on). `allowImportingTsExtensions: true` so
  imports use the source extension under `verbatimModuleSyntax` without an emit step.
- **Bun** ≥ 1.1 — runtime, test runner, and package manager. Matches the `bun run lint | fmt |
typecheck | test` gates in CLAUDE §3. Node LTS remains a viable deploy target because we
  stay inside standard ESM + `isolatedModules`.
- **ESLint** (flat config, type-aware with `projectService: true`) + **Prettier**. ESLint
  enforces the CLAUDE §7 bans: `no-explicit-any`, `no-non-null-assertion`, `ban-ts-comment`,
  `no-floating-promises`, `switch-exhaustiveness-check`, `no-console` (off under `test/`).

## Storage layer

- **Postgres 16** with **pgvector** is the source of truth — agents, sessions, tasks, memory,
  hook rules, audit trail (SPEC §Architecture).
- **Driver:** `postgres` (porsager). Tagged-template parameterization satisfies CLAUDE §10;
  tiny dep; no ORM bloat.
- **Query typing:** **Kysely** where compile-time column types pay off (joins, aggregates).
  Raw `postgres` for hot paths. No Prisma, no Drizzle, no TypeORM — engines/metadata fight
  the zero-dep bias and hide query shape.
- **Migrations:** forward + tested reversible rollback per CLAUDE §14. Either
  `graphile-migrate` or a small hand-rolled runner in `src/db/`. Squash-after-merge forbidden.
- **Redis** via **`ioredis`** — per-agent execution leases, distributed locks, rate counters
  only. Never the source of truth (SPEC §Architecture).
- **Object storage** via **`@aws-sdk/client-s3`** — blobs. MinIO locally, S3 in prod.

## Embeddings

- **`openai` SDK** — `text-embedding-3-small` (1536-dim). Experimentation-phase pick;
  RELAY-214 owns the Qwen3-Embed-8B migration when the trigger fires (see that task for
  trigger conditions and swap plan). The memory column and `EMBEDDING_DIM` constant both
  commit to 1536 — do not parametrize.
- One adapter file (`src/memory/embedding-openai.ts`) behind an `EmbeddingClient` seam;
  swapped wholesale, not runtime-selected.
- Adds `openai` (≥ v4) as a runtime dependency. An in-tree ≤ 200 LOC reimplementation is
  possible but would duplicate retry-respecting of `Retry-After`, typed error surfacing, and
  streaming-connection handling the SDK already implements. The SDK ships with a single
  non-test dependency and a vendor-agnostic interface — supply-chain footprint is small.
  Upgrade cadence: pinned in `package.json`, bumped deliberately alongside model changes.

## Agent runtime

- **`@anthropic-ai/sdk`** for model calls. Prompt caching enabled by default.
- **`@modelcontextprotocol/sdk`** for MCP tool connectors (SPEC §Integration).
- **Work queue:** Postgres-backed, hand-rolled with `FOR UPDATE SKIP LOCKED` + visibility
  timeout. Chosen over BullMQ/pg-boss because SPEC §Retry and idempotency ties the
  `hash(session_id, turn_id, tool_call_id)` idempotency key into the same transaction as the
  enqueue. Owning the primitive keeps exactly-once semantics under our control.
- **Leases** via Redis `SET NX PX` with renewal; worker crash → lease expires → the
  SPEC §Execution Model resume path kicks in.

## Hooks

- **CEL-style predicates** — sandboxed expression language evaluated per SPEC §Hooks. Either
  a small in-tree evaluator or `cel-js`. Zero-dep bias (CLAUDE §8) favours in-tree; scope
  is < 500 LOC for the subset we need. CLAUDE §3 requires **100% coverage** on the hook
  evaluator, so the surface must stay small and testable.

## HTTP / webhooks

- **Hono** on `Bun.serve`. Typed, small, middleware-friendly. Used for webhook receivers and
  the admin API. Not a framework lock-in — just a router.

## Validation / branded types

- **Zod** at boundaries only (CLAUDE §1). Schemas feed smart constructors that return branded
  types (`AgentId`, `SessionId`, `TenantId`, `Depth`, `Importance`, …). Zod types never leak
  into the core.

## Observability

- **`@opentelemetry/api`**, **`@opentelemetry/api-logs`**, and
  **`@opentelemetry/semantic-conventions`** are the only instrumentation surfaces (CLAUDE §2).
  No `console.log`, no competing logger. The platform facade lives at
  `src/telemetry/otel.ts` — span names, `relay.*` attribute keys, a `withSpan()` helper that
  guarantees `recordException` + `ERROR` status + `end()` on every path.
- **SDK:** `@opentelemetry/sdk-node` with OTLP/HTTP exporters for traces, metrics, and logs.
- **Auto-instrumentation:** `@opentelemetry/auto-instrumentations-node` (HTTP + pg).
- Backend is vendor-agnostic; Honeycomb is the likely default.

## Testing

- **`bun test`** runner. Unit + integration share the same runner for a single coverage
  aggregation. Integration tests gate on `INTEGRATION_DATABASE_URL` — skipped when unset so
  the suite stays green on machines without Docker.
- **Real Postgres** for integration (CLAUDE §3 forbids mocking the DB). We spin a
  `pgvector/pgvector:pg16` container out-of-band (Bun + `testcontainers-node` has a known
  hang on macOS) and point tests at it via the env var.
- Paid / external services (Anthropic, S3) are mocked via recorded fixtures; LocalStack is
  optional for S3.
- **Playwright** for E2E where the surface exists (admin UI).
- **Fake clock** (`src/core/clock.ts`) — production takes a `Clock`; tests pass `FakeClock`
  whose `advance(ms)` deterministically resolves pending `sleep`s (CLAUDE §11).

## Crypto

- **`node:crypto`** for HMAC (webhook signature verification) and idempotency-key hashing.
- **`@noble/ciphers`** for at-rest encryption of tenant connector secrets (SPEC §Connector
  state). Auditable, zero native deps — fits CLAUDE §8.

## CI/CD

- **GitHub Actions**, two parallel jobs:
  - `static` — `lint`, `fmt:check`, `typecheck`. Fast feedback, no DB.
  - `test` — pgvector service container, full `bun test` (unit + integration) with one
    coverage aggregation.
- Bun version pinned via `BUN_VERSION` in the workflow. Bump deliberately — never float to
  `latest`.
- Migration round-trip (forward + rollback against a staging dump) required before merge on
  any schema-touching PR (CLAUDE §14).
- **Docker images** for `worker` and `api`. `bun build --compile` is an option if we want
  zero-runtime deploys later.

## Explicitly rejected

| Rejected                       | Why                                                           |
| ------------------------------ | ------------------------------------------------------------- |
| Prisma / Drizzle / TypeORM     | Engines/metadata vs. zero-dep bias; hides query shape         |
| BullMQ / Temporal              | SPEC §Architecture rejects third-party workflow engines       |
| Express / Fastify              | Hono on Bun is lighter and typed end-to-end                   |
| Winston / Pino                 | OTel logs bridge is the only logger (CLAUDE §2)               |
| Jest / Vitest                  | `bun test` is the CLAUDE §3 gate                              |
| `sinon` / `jest.useFakeTimers` | Hand-rolled `Clock` per CLAUDE §11                            |
| Arbitrary-code hooks           | SPEC §Hooks bans arbitrary code, shell, and customer webhooks |

## Traceability

Every dependency above is justified by a specific SPEC or CLAUDE section. Adding a new
runtime dependency requires a PR paragraph per CLAUDE §8: what it does, why not < 200 LOC
in-tree, and who owns the upgrade cadence.
