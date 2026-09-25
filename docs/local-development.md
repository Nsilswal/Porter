# Local development

Porter currently has a working MCP demo and the first persistence/integration foundations for the Square salon pilot. Public onboarding, merchant accounts and dashboards are still being built. The [PRD](product-prd.md) describes the intended product; this guide describes what runs today.

## Quick demo

Use Node 22+, Docker Desktop for database tests, and the repository's pinned pnpm version.

```sh
pnpm install
pnpm demo
```

The demo uses fake businesses and an in-memory store. It completes the booking lifecycle without a Square account or real payments.

For an interactive local MCP server, copy `.env.example` to `.env` **only if you do not already have an environment file**, then run `pnpm dev:mcp`. The default endpoint is `http://localhost:8080/mcp`; the example demo key is `demo-key`. In Muse's API-key field enter the raw key. Clients that set headers directly use `Authorization: Bearer <key>` or `X-API-Key: <key>`.

## Run with PostgreSQL

```sh
pnpm db:up
```

This starts PostgreSQL 17 on `127.0.0.1:55432` with a persistent Docker volume. Its development-only username/password are `porter`/`porter`. It is not exposed on the local network. Existing PostgreSQL 16 volumes are not upgraded or deleted.

Set these in your ignored `.env`:

```dotenv
DATABASE_URL=postgres://porter:porter@127.0.0.1:55432/porter
PORTER_STORAGE=postgres
PORTER_DEMO_MODE=true
PORTER_SIGNING_SECRET=<stable random signing secret>
PORTER_ENCRYPTION_KEY=<different 64-character hexadecimal secret>
```

Generate the two secrets separately with `openssl rand -hex 32`. Keep them stable across restarts and out of Git. The encryption key wraps per-user data keys; losing it makes their encrypted responses unreadable. The server checks the key against the database at startup and rejects a mismatch. Configuration never silently falls back to memory when PostgreSQL is selected.

```sh
pnpm db:migrate
pnpm dev:mcp
```

Migrations run explicitly before startup, under a database lock. Applied migration checksums must match the application. Starting with missing migrations fails rather than accepting bookings without durable storage.

- `/healthz`: process liveness.
- `/readyz`: database readiness, storage backend and demo/provider mode.
- `/docs`: connector setup instructions; never includes credentials.

Bookings, confirmation consumption, retry outcomes and audit records survive process restarts. Demo provider state is still simulated and resets; a persisted mock booking is not an appointment in Square. Development OAuth sessions remain in memory and are disabled in production. Static API keys remain a temporary setup method until individual credential issuance ships.

Memory storage rejects provider/payment credentials even when mock demo mode is also enabled. A deployment cannot accidentally put real provider writes behind an ephemeral store.

`pnpm db:down` stops the database without deleting its volume.

## Verify changes

```sh
pnpm test
TEST_DATABASE_URL=postgres://porter:porter@127.0.0.1:55432/porter pnpm test
```

The second command includes real PostgreSQL concurrency, isolation, encryption and server-restart tests. Database suites create and remove their own randomly named schemas. Use a development database whose role can create schemas. Without `TEST_DATABASE_URL`, these tests are explicitly skipped; a successful default run alone does not validate persistence.

## Square sandbox

Follow [the Square integration contract](square-integration-contract.md) for developer setup, buyer permissions and remaining live checks. Keep the existing Railway personal demo separate. Mildred is a public reference, not a participating pilot business.

## Uncertain outcomes

Before an external mutation, Porter persists its operation identity and marks the outcome uncertain. If a provider response is lost or local persistence fails afterward, Porter keeps that reservation. Repeating the same request does not resubmit the mutation, even after its retention timestamp. A completed result is replayed after restart without requiring a still-valid confirmation token.

Mutations of an existing booking also acquire a durable guard before reading its current state. Different request IDs cannot charge, reschedule or cancel against the same stale record concurrently. An uncertain operation retains that guard. A completed replay can release its own guard if a restart interrupted cleanup; a new request cannot release another request's guard.

Automatic reconciliation and an operator recovery UI are not implemented yet. An uncertain operation requires checking Square's record using its stored operation identity before resolving it. Do not delete the reservation or switch to a new request key to force a retry. This restriction is a pilot launch dependency, not a claim that every failure already recovers automatically.
