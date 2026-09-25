# Porter — session handoff

Updated: 2026-09-24. Read this, [the PRD](product-prd.md), and [the implementation plan](implementation-plan.md).

## Current instruction

The user authorized continuing implementation, necessary clarifications, routine cleanup and a very high code-quality bar. The 24 product decisions are accepted; do not restart discovery. Persistence foundations and one scoped Square sandbox lifecycle are implemented; the self-serve product is not complete.

The user additionally authorizes opening PRs, reviewing every PR, and automatically merging to main when review and testing pass. Deliver incrementally so changes can be reverted independently. This agreement is also recorded in AGENTS.md.

## Agreed product

Public salon/spa website import with anonymous preview, email-link owner sign-in, one reviewed profile and official **Continue with Square** authorization. Small free pilot: invited US Square businesses, one location each, English/USD. One Porter connector, separate customer credentials in Muse. Named-salon booking first; one customer/service/appointment with staff preference or any staff.

Activation means supported real appointments can be completed in Muse; pending results remain pending. Square controls booking terms; website content supplies descriptions with provenance. Pay at salon only; exclude unsupported fees/card/deposit/prepayment obligations without changing salon policies. View/reschedule/cancel Porter-created appointments with explicit confirmation, live rechecks, ownership isolation and durable retries. Owner/operator dashboards, synchronization, recovery, pause/disconnect, deletion/retention/support are in scope. Public Muse directory approval is separate.

Goals: three participating salons, ten genuine bookings, owner setup under five minutes when Square is configured, reschedule/cancel exercised, no retry-created duplicates.

## New factual answers

- Mildred is **reference only**: https://mildred-101695.square.site/ . No participating owner or live appointment testing has been authorized.
- There is no deadline, monthly budget, domain or preferred email provider yet. Use configurable low-cost local defaults.
- The user accepted Square's Developer Terms. **Porter Sandbox** exists, and a dedicated **Porter Pilot Salon** US sandbox seller has Appointments enabled on the free plan. A $65, 30-minute service and bookable synthetic staff are configured.
- Exactly the seven documented buyer scopes were authorized and verified through the token-status API. The final sandbox run passed discovery, slot recheck, confirmed creation, identical replay, occupancy check, time-only reschedule and cancellation. All three test appointments were independently retrieved as cancelled. See the [validation record](square-sandbox-validation.md) for setup, evidence and remaining checks. No production appointments or payments are authorized.
- Credentials must never be copied to docs, code, logs or commits. Reuse the authenticated browser session if available.

## Foundation work

- PostgreSQL Store, explicit ordered/checksummed migrations, wrapped per-user encryption keys, key/schema startup validation, ownership constraints and health/shutdown lifecycle.
- Durable confirmation consumption, completed-outcome replay after expiry/restart, uncertain-operation identities persisted before external writes. No blind retries or automatic reservation expiry.
- Confirmations bind request fields and complete terms; signed payloads hold hashes instead of readable customer details.
- Durable guards serialize existing-booking mutations even across distinct request IDs. Uncertain operations retain guards; operator reconciliation is still pending.
- Square adapter fixes: phone requirement, actual catalog presence/pricing rules and pagination, fresh terms, credential-separated caches, known-fee/unresolved-price guards, full idempotency keys and honest missing results. Real sandbox testing added valid availability windows and sparse time-only rescheduling under buyer permissions. Explicitly marked recorded fixtures supplement the older synthetic fixtures.
- Async server initialization, PostgreSQL selection from DATABASE_URL, stable secrets, memory limited to mock writes, readiness, bounded SSE shutdown, safer key verification and database-error logging.
- Compose PostgreSQL, local/deployment guides, PostgreSQL CI and Docker context exclusions.

Details: [local development](local-development.md), [database notes](../packages/db/README.md), [Square contract](square-integration-contract.md).

## Workspace and verification

- Repo: /Users/kavinsaravanan/Desktop/Projects/Porter.
- Delivery: [PR #3](https://github.com/Nsilswal/Porter/pull/3) merged Square adapter corrections after independent review and 246 passing tests. [PR #4](https://github.com/Nsilswal/Porter/pull/4) merged the durable store/engine after independent review and 313 passing tests with PostgreSQL. [PR #5](https://github.com/Nsilswal/Porter/pull/5) merged server wiring, CI and these product documents after independent review, 324 passing tests, CI and Docker/MCP checks.
- [PR #6](https://github.com/Nsilswal/Porter/pull/6) merged the sandbox-only smoke harness after independent review, 346 passing committed-state tests with PostgreSQL, CI and secret scanning. [PR #7](https://github.com/Nsilswal/Porter/pull/7) merged the sandbox API fixes and recorded responses after independent review, 371 passing tests and CI.
- The user explicitly requested continuing merchant sign-in, secure merchant connections, onboarding and the full Muse experience. The provider-side `SquareOAuthClient` is implemented; its browser/session/storage integration is the next increment. It must pass independent review and committed-state tests before merging. Keep unrelated in-progress app/database work out of that client PR.
- Docker Desktop is running. `pnpm db:up` provides PostgreSQL 17 on 127.0.0.1:55432, database/user/password porter (local development only). `pnpm db:down` preserves the volume.
- Ignored `.env.square-sandbox` holds only a scoped sandbox access token and sandbox origin, with mode 0600. Load it explicitly for the smoke command; never copy it into a commit or the demo deployment. Merchant OAuth refresh is not yet implemented.
- Ignored .env now uses local PostgreSQL and port **8081**, with generated stable signing/encryption secrets and restrictive file permissions. No secret values are documented. Another process already occupied 8080; do not kill it without identifying it.
- Run `pnpm db:migrate` before `pnpm dev:mcp`. Never rewrite applied migration SQL. Migration v2 adds booking guards while preserving v1 data.
- Run `TEST_DATABASE_URL=postgres://porter:porter@127.0.0.1:55432/porter pnpm test`. DB tests create/drop isolated schemas. Without TEST_DATABASE_URL they are skipped.
- The combined foundation passed 324 tests across 21 files with real PostgreSQL, including HTTP/MCP restart and SSE shutdown checks. The Docker image builds from source with local secrets/build outputs excluded. Each PR must pass its own committed-state gate before merge; consult its validation record for the final reviewed commit.
- Mock provider state still resets on restart. Durable Porter mock records remain readable, but old mock appointments cannot reliably be changed through a new mock adapter. Mock booking references are now unique across processes.

## Next work

1. Finish and integrate the provider OAuth client, then test redirect/state, refresh/revocation, separate merchant isolation, policy variants and notification behavior. Basic account setup and the seven-scope lifecycle are complete. Sandbox API success does not establish production notification delivery or Muse behavior. The cancellation-policy UI failed in Square and omitted API fields remain unknown; activation must still require policy review.
2. Complete Phase 1: owner/operator/customer identities, merchant connections/locations, encrypted provider token lifecycle, email-link sign-in and individual connector credentials. Static API keys/global provider tokens are still temporary.
3. Implement reconciliation/operator recovery for uncertain operations and stuck guards.
4. Build website import/onboarding, merchant-aware routing, explicit business-name lookup, narrow pilot capabilities, dashboards and synchronization/webhooks.
   Buyer reschedules can only change time with the original service, staff and duration. Reject unsupported choices before confirmation; definite adapter rejections currently can retain conservative engine guards, so improve preflight/recovery without releasing guards after ambiguous writes.
5. Test the actual Muse lifecycle with distinct customers, resolve retention/support/email/domain, then roll out a separate Railway pilot. No participating salon or live appointment/payment was authorized here.

## Git, Railway and security continuity

- PR [#2](https://github.com/Nsilswal/Porter/pull/2), **Prepare secure Railway demo for Muse connector testing**, is verified merged on 2026-09-23. This new feature branch is separate. No product changes deployed this session.
- Railway project ideal-amazement has one production service, @porter/mcp-server, connected to Nsilswal/Porter main. The current running deployment is the earlier personal mock demo; a GitHub-triggered deployment was awaiting Railway approval when inspected. Merging main may queue further deployments. No manual Railway deploy or approval was performed. Endpoint: https://portermcp-server-production.up.railway.app/mcp . Verify deployment state before changing it.
- Muse's API-key field takes the raw key; direct headers use Bearer authorization or X-API-Key.
- The earlier public /docs key exposure was fixed. Subsequent key rotation is unconfirmed; resolve the old exposure before real-user credentials are shared.
- GitHub CLI lacks direct login; system Git credentials were usable. Never print them. Prior commits needed a per-command signing override; do not alter global Git settings.

## Document precedence

The PRD is accepted scope, the implementation plan is execution/progress, and older prototype docs are historical where they conflict. Import/onboarding is authorized; actual source restrictions and provider requirements still apply. Do not declare pilot readiness from old milestone labels.
