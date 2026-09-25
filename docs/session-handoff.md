# Porter — session handoff

Updated: 2026-09-25. Read this, [the PRD](product-prd.md), and [the implementation plan](implementation-plan.md).

## Current instruction and product

The user authorizes continuing merchant **Continue with Square**, secure merchant connections, self-serve onboarding and the full Muse experience. Maintain a high quality bar, review every PR, test its committed state, and automatically merge when review and required checks pass. Deliver coherent increments that can be rolled back. This agreement is also in `AGENTS.md`.

**Latest correction:** Porter will be published in Meta Muse's store/directory. Customers select Connect, sign in to Porter and consent through OAuth with PKCE. They never type an API key or endpoint. Merchant Square OAuth is separate. Directory approval and the actual store journey are launch dependencies; local SDK/browser tests do not establish Muse acceptance. Earlier custom-connector/API-key customer instructions are superseded.

The accepted pilot is invited US Square salons/spas, one location per business, English/USD, pay at salon, one customer/service/appointment. Public website preview precedes email sign-in, official Square authorization, service/policy review and activation. Customers find a named salon and create/view/reschedule/cancel Porter-originated appointments with confirmation and live checks. Dashboards, synchronization, recovery, deletion/retention/support and rollout remain part of the agreed scope.

Targets: three participating salons, ten genuine bookings, owner setup under five minutes when Square is configured, reschedule/cancel exercised, no retry-created duplicates. No deadline, hosting budget, domain or email provider has been selected.

## Account and testing boundaries

- Mildred is reference only: https://mildred-101695.square.site/. No participating owner or production appointment/payment is authorized.
- The user accepted Square Developer Terms. A Porter Sandbox developer app and dedicated synthetic Porter Pilot Salon seller are configured. Seven buyer scopes passed the raw adapter lifecycle; earlier test appointments were cancelled. See [sandbox validation](square-sandbox-validation.md).
- Reuse authenticated browser sessions. Never put passwords, application secrets, grants, login URLs, bearer tokens or customer contacts in commits, logs or documentation.
- Current Muse submission form/terms require Meta sign-in. The public platform page was checked on 2026-09-25 and confirms review before directory publication. Exact current callback/client requirements and published listing URL remain unverified. The user was asked to sign in; do not fabricate them.

## Delivered increments

| PR | Outcome |
|---|---|
| [#2](https://github.com/Nsilswal/Porter/pull/2) | Secure legacy Railway demo; old public key disclosure removed. Subsequent rotation remains unverified. |
| [#3](https://github.com/Nsilswal/Porter/pull/3)–[#5](https://github.com/Nsilswal/Porter/pull/5) | Square corrections, durable core PostgreSQL storage/confirmation/retry guards, server lifecycle and CI. |
| [#6](https://github.com/Nsilswal/Porter/pull/6)–[#7](https://github.com/Nsilswal/Porter/pull/7) | Sandbox harness, recorded provider responses and buyer-mode lifecycle fixes. |
| [#8](https://github.com/Nsilswal/Porter/pull/8) | Square OAuth client lifecycle. 425 tests. |
| [#9](https://github.com/Nsilswal/Porter/pull/9) | Separate PilotStore v3, identities/sessions, encrypted merchant grants, exclusive disconnect claim. 449 tests. |
| [#10](https://github.com/Nsilswal/Porter/pull/10) | Email sign-in, browser sessions, Square HTTP flow, initial pilot runtime. 493 tests. Initial customer keys are superseded by OAuth. |
| [#11](https://github.com/Nsilswal/Porter/pull/11) | Bounded public-site importer, anonymous drafts v4, Square catalog review, guarded atomic activation. 648 tests. |
| [#12](https://github.com/Nsilswal/Porter/pull/12) | Isolated merchant booking routing, name lookup, owned existing-booking management, fresh cancellation and final price/policy checks. 750 tests. |
| [#13](https://github.com/Nsilswal/Porter/pull/13) | Customer OAuth storage v5 and protocol service, PKCE/resource bindings, refresh rotation/reuse detection, consent and owned revocation. 823 tests. |

All merged increments above passed independent review, exact committed-state tests with PostgreSQL, GitHub CI and secret scanning. [PR #14](https://github.com/Nsilswal/Porter/pull/14) contains public onboarding, customer OAuth HTTP/UI wiring and accurate pilot/submission documentation. The integrated workspace passed 850 tests across 43 files with PostgreSQL, plus the browser/Square checks below. PR #14 merged as `0312622edf1e94ecbd5b47ae7d81a90c08a05ab2` after final independent review, 850 committed-state tests, CI and secret scanning.

## Current implementation and local evidence

- Customer OAuth: public registration, metadata discovery, exact redirect/resource/client binding, S256, browser-bound pending authorization, explicit live-session consent, single-use codes, hashed opaque tokens, fixed refresh families and revocation. Names from dynamic registration are unverified and callback origins are shown. Access lasts 15 minutes; authorization request 20 minutes; code two minutes; refresh family 30 days. Retain replay hashes until family expiry; no automated cleanup yet.
- Normal `/connect` UI explains the Muse directory connection and explicitly says publication is pending. No API key instructions. Optional internal keys default off and are confined to local nonproduction sandbox.
- Onboarding imports a browser-bound draft, preserves it across sign-in, connects Square and reviews an authoritative catalog. Activation checks invitations, live session/grant, review version and catalog digest. Hidden draft/request fields prevent concurrent tabs from submitting another tab's preview or consent. Unknown Square policy fields remain unknown despite owner attestation.
- Merchant facade selects credentials by owned business/location and persists immutable booking provenance. New bookings require an active reviewed business; paused businesses can still manage existing appointments while connected. Uncertain provider writes retain durable guards; operator reconciliation remains unfinished.
- Live browser owner testing succeeded through email sign-in, real Square sandbox OAuth, catalog/location review and activation of the synthetic salon. Website `https://example.com` was a sandbox placeholder. Local business ID: `50c81c74-abf7-41ce-b06b-4a33f6cdd8b1`. Only the fixed $65/30-minute synthetic haircut is enabled; unpriced demo services were disabled.
- Live local browser customer testing succeeded through explicit consent, automatic PKCE exchange, all six MCP tools, token refresh and revocation. The OAuth-authenticated pilot also completed real sandbox discovery, availability, confirmed create, identical replay, time-only reschedule and cancellation. Two synthetic appointments created during validation were cancelled; the first run stopped before rescheduling because of a temporary harness field-name error, then the corrected run passed. The local test client was named `Porter local OAuth test`, used a loopback callback and was disconnected after testing. This was **not an actual Muse connection**.
- Browser fixes to preserve: `Referrer-Policy: strict-origin` permits native same-origin POST Origin checks without leaking URL paths/queries. Cross-origin OAuth handoffs use a 200 continuation page/normal link navigation; a POST→cross-origin 303 is blocked by Chromium `form-action 'self'` CSP.
- Bounded HTML extraction does not execute website scripts. Rendered-page fallback and full extraction coverage remain open. See [Muse readiness](muse-compliance.md) for accurate capability and launch gaps.

## Workspace and run commands

Repo: `/Users/kavinsaravanan/Desktop/Projects/Porter`. Use `git status` before changing branches and preserve current work. Three unexpected untracked duplicate Square fixture/test files ending in ` 2` appeared during integration work; they were left untouched and excluded from PR #14. Use `codex/` branch names. GitHub CLI authentication may require the existing private `/tmp/porter_gh.py` credential helper. Never print its credential. Per-command signing overrides may be necessary; do not change global Git settings.

Docker PostgreSQL 17 is running on `127.0.0.1:55432`, local user/password `porter`. Tests use isolated schemas in database `porter`:

```sh
TEST_DATABASE_URL=postgres://porter:porter@127.0.0.1:55432/porter pnpm test
```

Ignored mode-0600 `.env.pilot` configures separate database **porter_pilot**, port **8082**, stable signing/encryption keys, sandbox app credentials and private file email delivery. It has been migrated through v5. The registered Square callback is `http://localhost:8082/square/callback`.

```sh
pnpm build
node --env-file=.env.pilot packages/db/dist/migrate.js
node --env-file=.env.pilot apps/mcp-server/dist/index.js
```

Private sign-in mail is in ignored `.porter/mail`. Local customer validation scripts/artifacts, if present in `.porter`, are temporary development aids and are not a supported production client. Do not expose their tokens. Legacy ignored `.env` uses port8081/databaseporter; another unrelated process uses8080. Do not kill either indiscriminately. `.env.square-sandbox` contains the older scoped direct test token; whole-app merchant revocation can invalidate it.

Never rewrite applied migrations v1–v5. The exact migration ledger check means application rollback must retain all applied migration definitions or use a reviewed database restore. `pnpm db:down` preserves the local volume.

## Next work and launch gates

1. Onboarding and customer OAuth HTTP/UI shipped in PR #14. The user now wants a public web test on Railway. The deployment guide describes the unified website/MCP service. Email is the remaining external setup input: Resend can send to its account email from `onboarding@resend.dev` for an individual test without a custom domain. A question about existing Resend access versus setting up individual testing is pending. Do not enable file-email mode on public hosting.
2. Extend the now-passing OAuth-authenticated sandbox lifecycle to Square refresh/disconnect/reconnect, multiple customers and merchants, policy variants and notifications. Verify actual Muse behavior separately.
3. Implement owner booking history/counts, restricted operator recovery and reconciliation for uncertain writes/ambiguous revocation. Never release uncertain guards merely because time passed.
4. Add verified Square webhooks/recovery sync and website refresh preserving owner edits. Complete deletion/request handling and settle retention/support/public policies.
5. Verify authenticated Muse form, terms and callback/client requirements; configure the actual client/listing when provided. Test actual store connection, renewal/revocation and booking UX. Meta approval remains external.
6. Deploy a separate HTTPS Railway pilot with PostgreSQL, verified email sender, accurate public privacy/terms/support pages, migration and restore checks. No participating production salon has been authorized yet.

## Railway continuity

The existing project `ideal-amazement` has one service, `@porter/mcp-server`, connected to `Nsilswal/Porter` main. On 2026-09-25 Railway reported successful automatic deployment of main commit `0312622edf1e94ecbd5b47ae7d81a90c08a05ab2`. The running endpoint is `https://portermcp-server-production.up.railway.app/mcp`; its configuration remains mock demo (`PORTER_DEMO_MODE=true`, pilot flag absent, no database/email/Square application configuration). `/readyz` returns memory/demo, and `/` returns404. No manual Railway deployment, approval or variable change was performed. Public pilot testing needs its database, email, credentials and callback configured; keep pilot credentials separate from the demo. The previously disclosed demo key must be rotated before any reuse for real users.

## Document precedence

The PRD records accepted scope, the implementation plan tracks remaining execution, and older prototype/legal/form captures are historical where they conflict. Building a local flow does not establish production readiness or Muse publication.
