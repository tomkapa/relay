# Relay

Platform for running agents that act on behalf of people, teams, or any group of interests.

- Design: [`SPEC.md`](./SPEC.md)
- Engineering rules (binding): [`CLAUDE.md`](./CLAUDE.md)

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.1
- Docker (for Postgres + Redis + MinIO via local compose)

## Getting started

```sh
bun install
cp .env.example .env
bun run check          # lint + fmt:check + typecheck + unit tests
```

## CI

`.github/workflows/ci.yml` runs on every PR against `main`:

- **`checks`** — `bun run lint`, `bun run fmt:check`, `bun run typecheck`, `bun test` (unit + coverage threshold).
- **`integration`** — brings up `pgvector/pgvector:pg16` as a GitHub Actions service container, sets `INTEGRATION_DATABASE_URL`, and runs `bun test test/integration`.

Bun is pinned via `BUN_VERSION` in the workflow. Bump deliberately — never float to `latest`.

## Integration tests (real Postgres)

Integration tests hit a real Postgres (with pgvector) per CLAUDE.md §3. Bun has a known
hang with the `testcontainers-node` JS client on macOS, so we spin Postgres up out-of-band
and point the tests at it via `INTEGRATION_DATABASE_URL`.

```sh
# one-off pgvector container (keep running between test runs)
docker run -d --rm --name relay-it-pg -p 54329:5432 \
  -e POSTGRES_USER=relay -e POSTGRES_PASSWORD=relay -e POSTGRES_DB=relay \
  pgvector/pgvector:pg16

# run the integration tests
INTEGRATION_DATABASE_URL="postgres://relay:relay@localhost:54329/relay" \
  bun test test/integration

# stop when done
docker stop relay-it-pg
```

Without `INTEGRATION_DATABASE_URL`, the integration suite is **skipped** — `bun test`
still green-lights on a machine without Docker.

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
  db/            Postgres client, versioned SQL migrations + its limits.ts
  session/       session pipeline + its limits.ts
  memory/        memory store + consolidation + its limits.ts
  hook/          hook evaluator + its limits.ts
test/
  unit/          fast, in-process
  integration/   real Postgres via INTEGRATION_DATABASE_URL
```

New subsystems follow the same shape: a `limits.ts` alongside the code, constants named and
commented with _why this number_ (CLAUDE.md §5).
