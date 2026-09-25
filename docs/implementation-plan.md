# Porter salon pilot — implementation plan

Updated: 2026-09-24. Implementation authorized and delivered through incremental, reviewed and tested pull requests.

The approved product requirements are in [product-prd.md](./product-prd.md). For session continuity, start with [session-handoff.md](./session-handoff.md).

## Progress

The first change implements PostgreSQL storage and migrations, wrapped encryption keys, durable retry/confirmation state, stronger confirmation binding, Square adapter contract corrections, and startup/readiness/shutdown checks. See [local development](./local-development.md) and [the Square integration contract](./square-integration-contract.md).

Phase 0 remains open for OAuth, policy variants, isolation, notifications and Muse validation. The user accepted the Developer Terms. The application and a dedicated sandbox seller now exist; the exact seven buyer scopes passed discovery, create, identical replay, time-only reschedule and cancellation. See the [sandbox validation record](square-sandbox-validation.md). The merchant OAuth redirect/refresh/revocation lifecycle remains unimplemented. Phase 1 remains open for merchant identities/connections, email sign-in, individual connector credential issuance, and reconciliation. Public onboarding and dashboards have not shipped. Do not label either phase complete based on the foundation tests.

## Current implementation and gaps

| Area | Evidence in the repo | Work needed for the pilot |
|---|---|---|
| MCP server | `apps/mcp-server/src/app.ts`, `tools.ts` expose nine tools, API-key authentication and PostgreSQL storage. | Real customer identities/credential lifecycle, pilot-specific capability exposure and named-salon lookup. |
| Booking engine | `packages/core/src/engine.ts` handles confirmations, slot rechecks, durable idempotency/guards and adapter routing. | Route through merchant-scoped connections and safely reconcile uncertain upstream writes. |
| Persistence | `app.ts` now selects PostgreSQL from `DATABASE_URL`; explicit migrations and production stores are implemented in `packages/db`. | Add merchant/account records and reconciliation on top of durable booking/confirmation/retry storage. |
| Merchant credentials | `apps/mcp-server/src/adapters.ts` reads a deployment-wide Square token; core indexes credentials by adapter ID. | Model many merchant connections and authorize each request against the correct merchant/location. |
| Square adapter | `packages/adapters/square-appointments` passed one buyer-mode sandbox lifecycle and has recorded response regressions. | Extend validation to policy/price variants, notifications, isolation and recovery; implement the actual merchant OAuth journey. |
| Public pages | `packages/adapters/web` reads pages; `square-public` contains experimental undocumented booking endpoints. | Build a reviewed import pipeline. Use the official Square integration for the pilot's booking contract. |
| Product UI | No public onboarding, merchant dashboard, or operator console. | Build the approved journeys and account management. |
| Search | Current `SearchArgs` requires category; there is no first-class business-name argument. | Add explicit active-business name/location lookup without relying on category matching. |
| Deployment | Railway demo configuration and deployment guide exist. | Persistent pilot environment, migrations, recoverability, observability, and public product pages. |

## Phase 0 — validate the integration contract

Start here when the user begins implementation. Inspect the current branch/PR state and preserve existing work before creating a feature branch.

- Verify Square developer application ownership, redirect URLs, scopes, plan requirements, and available test environment. Identify a participating owner separately from an example URL.
- Exercise one location/service through the official APIs: catalog, staff, availability, create, retrieve, update, cancel, refresh/revoke, and relevant webhook events. Use test resources; coordinate any real appointment with its participant.
- Determine which configuration combinations truly qualify for the pay-at-salon pilot. Verify whether bookings confirm immediately and when notifications occur. Document unsupported or pending-confirmation cases explicitly.
- Record sanitized fixtures from actual responses and compare them with the current adapter. Verify price ranges, staff selection, time zones, cancellation rules, and the documented non-zero-fee limitation.
- Verify the current personal Muse integration with individual credentials. Define a reproducible customer setup path without assuming directory approval or automatic connector installation.
- Check applicable provider/Muse terms and existing privacy/rights items against the proposed public-site import and merchant-authorized data use. Correct stale product claims in submission/legal docs before launch.

Exit: a documented supported booking path, eligibility rules, tested response examples, and a Muse setup procedure. Missing account access is an external dependency to record; useful persistence/UI work can continue with fixtures without claiming live validation.

## Phase 1 — persistent identities and merchant routing

- Introduce explicit owner/operator/customer roles, businesses, pilot invitations, selected locations, and merchant connections. An owner may have a customer role, but role boundaries remain explicit.
- Implement email-link account access and individually issued/revocable customer connector credentials. Store credential hashes where verification permits; encrypt retrievable provider tokens and keep them out of logs/public docs.
- Replace in-memory production stores with Postgres implementations. Persist booking references, pending/uncertain attempts, confirmation consumption, idempotency responses, account sessions, and audit outcomes with appropriate transactional constraints.
- Review the existing schema before extending it: `linkedAccounts` is keyed by user/adapter, while the product needs merchant-owned connections independent of the customer making a booking.
- Make routing, caches, provider identifiers, and webhook processing merchant-aware. The current single adapter/token wiring must not be reused across unrelated businesses.
- Define backup, restore, deletion, retention, and secret handling. The accepted product requires retention documentation; final periods are still open.

Exit: durable, isolated accounts and connections with meaningful tests for cross-customer/cross-merchant access, process restarts, and duplicate requests.

## Phase 2 — website import and owner onboarding

- Build the public URL-entry and anonymous preview experience with bounded fetches and resumable import jobs. Preserve drafts across later authentication.
- Treat URL fetching as a server-side request boundary: allow public HTTP(S) destinations, validate redirects/resolution, reject private/internal destinations, bound resources, respect source restrictions, and sanitize untrusted content.
- Extract the approved fields with source URLs and confidence/unknown markers. Support rendered public pages when ordinary extraction is insufficient; do not assume a simple HTML fetch can read the Mildred example.
- Detect Square links and provide the official authorization flow. Bind OAuth state to the authenticated owner/session; handle refusal, expiry, refresh, revocation, and reconnect.
- Reconcile Square's catalog/policies with the website draft, check merchant/location association, and expose editing only where it does not override authoritative booking data.
- Implement invitation checks, service eligibility, review, activation, draft recovery, and unsupported-platform messaging.
- Provide a salon share page and simple Muse onboarding instructions. Never publish a merchant or customer secret on that page.

Exit: an invited owner can go from public URL to an active eligible business without developer assistance. Ineligible drafts explain how to recover and cannot receive bookings.

## Phase 3 — customer booking in Muse

- Add explicit lookup by salon name/location across active pilot businesses and expose eligible services/staff.
- Preserve the confirmation/recheck design. Bind each operation to the customer, merchant, selected service/staff/time, price, and current terms.
- Persist request/outcome state before and after provider calls. Reconcile timeouts/crashes with stable provider idempotency/reference data before retrying.
- Support creation, listing, rescheduling, and cancellation of Porter-originated appointments. Verify ownership on every operation; do not import unrelated customer appointment history.
- Restrict buyer rescheduling to time changes with the original staff, service and duration. Filter unsupported choices before confirmation and handle definite pre-write rejection without leaving an unnecessary uncertain guard; do not weaken protection for ambiguous provider outcomes.
- Define pilot tool exposure so payment, home-service quote, and unsupported messaging tools cannot imply unsupported capabilities. Keep mock/demo capabilities in their own environment.
- Return actual provider status. A pending, failed, or uncertain response is never a confirmed appointment. Show changes in terms and require fresh confirmation when appropriate.
- Validate notification behavior for the selected API permission mode, then fill only necessary gaps. Do not assume Square always sends messages after every API write.

Exit: the supported customer lifecycle works inside Muse, including stale slots, changed terms, declined confirmations, retries, and restart recovery.

## Phase 4 — dashboards, synchronization, and pilot operations

- Build the owner dashboard for profile/service controls, connection state, Porter bookings, counts, pause, disconnect, and deletion requests.
- Build a restricted operator console for invitations and actionable import/connection/booking failures. Keep operator access auditable and limited.
- Apply Square updates through verified webhook processing and a recovery sync strategy. Preserve owner website edits and ask for review of substantial descriptive changes.
- Handle disconnected accounts and paused businesses consistently across discovery, new bookings, and existing-appointment management.
- Instrument the accepted pilot metrics and provide user-facing recovery messages. Resolve the support contact, email sender, domain, and final retention policy before real onboarding.

Exit: owners and operators can detect, understand, and recover from ordinary failures without editing server variables or database rows manually.

## Phase 5 — Railway pilot rollout

- Continue using Railway; provision and wire Postgres, deploy migrations, and validate restore/restart behavior. Choose additional services only where required by the implementation and budget.
- Keep the existing personal demo distinguishable from the real pilot. Recheck deployment source/branch rather than assuming the Railway project tracks GitHub.
- Update public documentation, privacy/terms pages, and the submission packet to describe actual pilot capabilities. Treat directory review as a separate later release path.
- Before sharing real-user credentials, resolve the previously disclosed demo key exposure and ensure the current secret is not carried into the pilot. Never copy secrets into docs, commits, or public pages.
- Run required build/tests and focused end-to-end checks for critical risks: merchant isolation, persistent retry protection, confirmation integrity, credential refresh, disconnected accounts, and supported provider policy combinations.
- Onboard the first participating salon, then expand to the agreed three-salon cohort. Observe genuine customer bookings against the agreed targets.

Exit: accepted PRD criteria are demonstrated with documented results, a working support route, and a deployment that survives restarts without losing booking ownership or operation state.

## Delivery and change control

Use reviewable changes around the phases above; do not bundle the entire product into the existing demo-readiness PR by accident. The phase sequence is a proposal for execution, not an estimate or a claim of completion. Scope is the free Square/Muse pilot described in the PRD; other providers, payments, multi-location scheduling, public discovery rankings, and other agent clients are deferred.

The user has authorized continuing implementation, routine cleanup, and a high bar for code quality. Do not ask the 24 product questions again; collect only missing factual inputs when they affect the next concrete step.
