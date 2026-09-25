# Muse salon pilot — compliance and readiness

Updated against the implementation on 2026-09-25. This is an evidence map and launch checklist, not a declaration of compliance, approval, or publication.

## Evidence and publication status

Muse's public [Connector Platform page](https://muse.ai/platform), checked on 2026-09-25, describes functional, security and legal review followed by directory appearance after approval. It does not establish Porter's approval or expose the current authenticated submission requirements, OAuth callbacks, or client configuration.

Porter's accepted product requires a published Muse directory connector with account sign-in and OAuth consent. Customers must not have to copy an API key or configure an MCP endpoint. Directory publication and the actual Muse connection remain validation gates; local OAuth tests and the separate Square sandbox lifecycle do not establish either.

The [2026-09-18 Connector Terms capture](reference/muse-connector-terms-2026-09-18.md) was captured on 2026-09-21 and is historical evidence only. Its clauses and incorporated policies must be checked in the authenticated Muse flow before submission. The mapping below uses that capture's section numbers without asserting that they are still current. The submission packet and validator also derive from an earlier form capture and need the same verification.

## Current pilot scope

The pilot supports invited US salons and spas using Square Appointments, one location per business, English and USD. The six MCP tools are `search_providers`, `get_availability`, `create_booking`, `list_my_bookings`, `reschedule_booking` and `cancel_booking`. Granted `bookings:read` and `bookings:write` scopes limit the tools exposed to each customer. See [server registration](../apps/mcp-server/src/server.ts) and [tool definitions](../apps/mcp-server/src/tools.ts).

Payment is at the salon. The pilot exposes no payment, quote or provider-message tool. Activation requires fixed-price eligible services, an owner policy review, and an attestation that selected services have no deposit, prepayment, card-on-file, cancellation-fee or no-show-fee obligation. Known unsupported live fees block the affected operation. Missing provider policy fields stay unknown; owner attestation does not turn them into verified zero fees. See [catalog review](../apps/mcp-server/src/pilot/catalog.ts) and [merchant routing](../apps/mcp-server/src/pilot/adapter.ts).

Customer OAuth is separate from merchant Square authorization. The customer protocol implements registered public clients, exact redirect and resource binding, S256 PKCE, browser-bound consent, expiring opaque access tokens, rotating refresh tokens, replay detection and revocation. Tokens are stored as hashes; merchant grants are encrypted. Names supplied during client registration are unverified. See [customer OAuth](../apps/mcp-server/src/pilot/customer-oauth.ts), [OAuth storage](../packages/db/src/customer-oauth.ts) and [merchant connections](../apps/mcp-server/src/pilot/connections.ts). Muse's actual client requirements still need authenticated verification.

Manual API keys are outside normal customer setup. The optional `PORTER_INTERNAL_API_KEYS=true` compatibility path is restricted to nonproduction, loopback, Square sandbox development and defaults off. The old mock demo is a separate environment and cannot stand in for a tested pilot connection.

## Website import behavior

Porter performs bounded public-page scraping during owner onboarding. The [importer](../apps/mcp-server/src/pilot/importer.ts) reads one HTML document, plus robots-policy requests and bounded redirects, as `PorterBot/1.0`. It extracts descriptions, contact details and structured service information for owner review. It executes no website scripts, loads no subresources, sends no login credentials or cookies, and submits no booking forms.

Every request checks public destination addresses and pins a validated DNS result. Redirects repeat destination checks; page redirects also check the destination's robots policy. A disallow rule, malformed policy, or unverified robots response blocks the page read; robots HTTP 404/410 is treated as an absent policy. Network work has a 15-second deadline, at most four redirects per chain, and response/decompression limits. HTML parsing has a separate 256 KiB input limit and bounded structure; previews are capped at 60 KiB. Complex, protected or JavaScript-dependent sites can produce a limited or empty preview with warnings.

Imported facts retain source URLs and require review. Square supplies bookable services, prices, duration, availability and booking rules. Website price ranges are descriptive evidence, never a fixed booking quote. Respecting robots policy does not establish rights to reuse or distribute a site's content; source permissions remain part of submission review.

## Historical terms mapping

“Implemented” below means code and automated evidence exist. Operational readiness and legal conclusions require their own verification.

| Historical section or policy | Current evidence | Remaining gate |
|---|---|---|
| §2.1: accurate submission and review | [Submission packet](../submission/connector-submission.json) describes six salon tools, merchant routing, website import, OAuth and pay at salon. Unknown entity, domain and contact fields remain placeholders. | Recheck the authenticated form, provide accurate reviewer access and complete Meta review. No approval is claimed. |
| §2.2: directory availability | The owner activation flow and customer connection page distinguish business activation from Muse publication. | Verify an approved listing and its actual URL before setting `PORTER_MUSE_CONNECTOR_URL`. |
| §3.1 / §4.2: rights to supplied content | Pilot data comes from merchant-authorized Square access and reviewed public website imports. | Review current provider/source permissions and the authenticated Muse licence requirements. Owner connection is not blanket redistribution clearance. |
| §3.3: affiliation and restrictions | Client names are marked unverified; provider requests, imports and account actions have bounds or rate limits. | Verify branding and actual client identity in the submission/review process. |
| §4.1: functionality and accuracy | Live slot, policy and booking-state checks bind confirmation to current terms. Pending and uncertain outcomes remain distinct from confirmed results. | Exercise the supported journey inside Muse with separate customer accounts and authorized sandbox resources. |
| §4.3(a), (e): scoped access | Owned Porter bookings select the merchant; caller credentials cannot select another merchant's token. Customer fields are projected per adapter. | Review deployed access settings and disclosure language against the final participating businesses. |
| §4.3(b): incident handling | [Incident-response draft](../legal/incident-response.md) exists. | Verify current reporting obligations, contact routes and an operational response owner. |
| §4.3(c), (d): privacy and controller obligations | [Privacy-notice draft](../legal/privacy-notice.md) describes the service. | Review it for the pilot's actual processing, verify current Meta data-protection requirements, and publish the final notice. |
| §4.3(f): retention and deletion | Core booking/payment deletion helpers and OAuth revocation exist. Disconnecting does not cancel appointments in Square. | Complete and test a coordinated customer/owner deletion and retention workflow across identities, sessions, grants, imports, audit records and merchant recovery. Automated retention cleanup is not implemented. |
| §4.3(g), §4.4: records and audit | [Audit records](../packages/core/src/audit.ts) retain pseudonymous actor IDs, argument hashes, outcomes and disclosed field names. PostgreSQL persists booking and retry evidence. | Treat pseudonymous records as privacy-relevant data; settle retention, support access and audit-response procedures. |
| Policies: misleading content and prompt injection | Business text is untrusted data and sanitized at output boundaries. Unknown fields are disclosed rather than invented. | Verify the real Muse presentation; sanitization alone does not establish immunity from prompt injection. |
| Policies: material terms and authorized actions | Create, reschedule and cancel use signed, single-use confirmations and live checks. Rescheduling preserves the original service, staff and duration. | Verify confirmation UX and notifications in Muse. Unknown provider write outcomes need operator reconciliation before retry. |
| Policies: prohibited content / professional decisions | Accepted pilot scope is salons/spas; no medical services, professional determinations or customer profiling is intended. | Review participating catalogs and public descriptions; third-party content is not automatically compliant. |
| §9.4 / §10: changed terms and Porter's terms | A dated reference capture and [Porter terms draft](../legal/terms-of-service.md) exist. | Reverify authenticated terms on submission day and obtain review of final public policies. |

## Before publication

1. Verify the current authenticated Muse form, terms, incorporated policies, OAuth client-registration method, allowed callbacks and required scopes. Record the results without credentials.
2. Complete provider/source rights review, final public policies, contact details and retention/deletion/support procedures.
3. Deploy a separate HTTPS pilot with PostgreSQL, stable secrets and production email delivery; keep internal key mode disabled.
4. Test account consent, callback completion, renewal, revocation, customer isolation and the six-tool lifecycle inside Muse. Use only appointments explicitly authorized for testing.
5. Resolve unknown-outcome recovery and record remaining provider, notification and Muse limitations honestly.
6. Submit accurate evidence, wait for approval, then verify the published directory journey. Business activation, local tests and the earlier mock deployment do not satisfy this gate.
