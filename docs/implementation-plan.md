# Porter salon pilot — implementation plan

Updated: 2026-09-25. Implementation authorized and delivered through incremental, reviewed and tested pull requests.

## Updated customer connection requirement — 2026-09-25

The product will be published in Meta Muse's store. Customers select Connect and authorize their Porter account through OAuth with PKCE. They never type an API key or endpoint. This supersedes the earlier private custom-connector setup below. Keep merchant Continue with Square independent of customer OAuth. Implement durable registered clients, browser-bound authorization requests, explicit signed-in consent, single-use codes, resource/audience validation, hashed access tokens, rotating refresh tokens with reuse detection, and grant revocation. The demo OAuth flow must stay disabled in the pilot. Muse directory approval and its actual connection journey are release gates, not optional later distribution.

The API-key flow delivered in PR #10 is an internal validation path only. Remove it from the pilot's normal customer UI and public setup docs as the production OAuth flow is integrated. Inspect the current authenticated Muse submission form for actual callback/client requirements; do not invent those values. The public platform page was rechecked on 2026-09-25; protected form and current terms require Meta sign-in.

The approved product requirements are in [product-prd.md](./product-prd.md). For session continuity, start with [session-handoff.md](./session-handoff.md).

## Progress

The first change implements PostgreSQL storage and migrations, wrapped encryption keys, durable retry/confirmation state, stronger confirmation binding, Square adapter contract corrections, and startup/readiness/shutdown checks. See [local development](./local-development.md) and [the Square integration contract](./square-integration-contract.md).

Phase 0 remains open for provider policy variants, notifications and actual Muse store validation. Square merchant OAuth and local browser authorization now work. Persistent accounts, isolated merchant grants, bounded website drafts, guarded activation, merchant routing and customer OAuth are implemented through PRs #8–#13. The next increment connects public onboarding and customer OAuth to the HTTP/UI surface. Operator recovery, dashboards, synchronization and rollout remain open. Do not label the pilot complete from automated tests alone.

## Current implementation and gaps

| Area | Implemented | Remaining pilot work |
|---|---|---|
| Customer connection | Durable OAuth with PKCE, explicit account consent, hashed credentials, rotation/reuse detection and owned revocation. | Ship HTTP/UI wiring, verify exact Muse requirements and approved directory journey. |
| Merchant connection | Email sign-in, official Square authorization, encrypted per-business grants, refresh and exclusive disconnect claim. | More real sandbox lifecycle/isolation tests and operator review for ambiguous revocation. |
| Booking engine | Durable confirmations, retries/guards, merchant/location routing, named-salon lookup, fresh terms and owned mutation checks. | Reconcile uncertain external writes and validate actual Muse/provider notifications. |
| Public onboarding | Bounded public-site importer, anonymous browser-bound drafts, Square catalog review and atomic activation. | Ship browser UI; extend extraction/rendered-page support with source restrictions. |
| Product UI | Owner connection/profile/service controls, pause, salon share pages and customer consent are in the current increment. | Owner booking counts/history, operator console, account deletion and recovery. |
| Synchronization | Live booking/terms/availability checks before operations. | Verified webhooks, recovery sync and website refresh preserving owner edits. |
| Deployment | Local PostgreSQL pilot on port 8082; separate legacy Railway demo. | Separate public pilot, email sender, support/legal URLs, restore validation and Muse review. |

## Phase 0 — validate the integration contract

Start here when the user begins implementation. Inspect the current branch/PR state and preserve existing work before creating a feature branch.

- Verify Square developer application ownership, redirect URLs, scopes, plan requirements, and available test environment. Identify a participating owner separately from an example URL.
- Exercise one location/service through the official APIs: catalog, staff, availability, create, retrieve, update, cancel, refresh/revoke, and relevant webhook events. Use test resources; coordinate any real appointment with its participant.
- Determine which configuration combinations truly qualify for the pay-at-salon pilot. Verify whether bookings confirm immediately and when notifications occur. Document unsupported or pending-confirmation cases explicitly.
- Record sanitized fixtures from actual responses and compare them with the current adapter. Verify price ranges, staff selection, time zones, cancellation rules, and the documented non-zero-fee limitation.
- Verify the Muse directory connection with automatic customer OAuth, distinct identities, refresh and revocation. Confirm the authenticated submission form and callback/client requirements before claiming compatibility.
- Check applicable provider/Muse terms and existing privacy/rights items against the proposed public-site import and merchant-authorized data use. Correct stale product claims in submission/legal docs before launch.

Exit: a documented supported booking path, eligibility rules, tested response examples, and a Muse setup procedure. Missing account access is an external dependency to record; useful persistence/UI work can continue with fixtures without claiming live validation.

## Phase 1 — persistent identities and merchant routing

- Introduce explicit owner/operator/customer roles, businesses, pilot invitations, selected locations, and merchant connections. An owner may have a customer role, but role boundaries remain explicit.
- Implement email-link account access and scoped customer OAuth grants with explicit consent, PKCE, refresh and revocation. Store credential hashes where verification permits; encrypt retrievable provider tokens and keep them out of logs/public docs.
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
- Update public documentation, privacy/terms pages, and the submission packet to describe actual pilot capabilities. Complete Muse directory review and test the actual store connection before launch.
- Before sharing real-user credentials, resolve the previously disclosed demo key exposure and ensure the current secret is not carried into the pilot. Never copy secrets into docs, commits, or public pages.
- Run required build/tests and focused end-to-end checks for critical risks: merchant isolation, persistent retry protection, confirmation integrity, credential refresh, disconnected accounts, and supported provider policy combinations.
- Onboard the first participating salon, then expand to the agreed three-salon cohort. Observe genuine customer bookings against the agreed targets.

Exit: accepted PRD criteria are demonstrated with documented results, a working support route, and a deployment that survives restarts without losing booking ownership or operation state.

## Delivery and change control

Use reviewable changes around the phases above; do not bundle the entire product into the existing demo-readiness PR by accident. The phase sequence is a proposal for execution, not an estimate or a claim of completion. Scope is the free Square/Muse pilot described in the PRD; other providers, payments, multi-location scheduling, public discovery rankings, and other agent clients are deferred.

The user has authorized continuing implementation, routine cleanup, and a high bar for code quality. Do not ask the 24 product questions again; collect only missing factual inputs when they affect the next concrete step.
