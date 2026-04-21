# Relay

Platform for running agents that act on behalf of people, teams, or any group of interests.

- Design: [`SPEC.md`](./SPEC.md)
- Engineering rules (binding): [`CLAUDE.md`](./CLAUDE.md)

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.1
- Docker (for Postgres + Redis + MinIO via testcontainers and local compose)

## Getting started

```sh
bun install
cp .env.example .env
bun run check          # lint + fmt:check + typecheck + unit tests
```

## Scripts

| Script              | Purpose                                                       |
| ------------------- | ------------------------------------------------------------- |
| `bun run lint`      | ESLint, `--max-warnings=0`                                    |
| `bun run fmt`       | Prettier write                                                |
| `bun run fmt:check` | Prettier check (CI gate)                                      |
| `bun run typecheck` | `tsc --noEmit` with strictest settings                        |
| `bun test`          | Unit + integration tests via `bun test`                       |
| `bun run test:e2e`  | Playwright E2E suite (where the surface exists)               |
| `bun run check`     | All of the above — the exit gate defined in CLAUDE.md §3      |

## Layout

```
src/
  core/          brand, result, assert, clock — depended on by everything
  telemetry/     OTel facade (the only instrumentation API)
  ids.ts         branded IDs for every SPEC entity
  session/       session pipeline + its limits.ts
  memory/        memory store + consolidation + its limits.ts
  hook/          hook evaluator + its limits.ts
test/
  unit/          fast, in-process
  integration/   real Postgres via @testcontainers/postgresql
```

New subsystems follow the same shape: a `limits.ts` alongside the code, constants named and
commented with _why this number_ (CLAUDE.md §5).
