# Porter salon pilot — product requirements

Updated: 2026-09-24. Status: product recommendations accepted; foundation implementation in progress. Product scope below remains the agreed target, not a list of shipped features.

The user approved the recommendations to all 24 discovery questions. This document records those decisions. Factual answers the user did not supply remain open; agreement with a recommendation does not supply credentials, a deadline, or a participating business.

Read this with [the implementation plan](./implementation-plan.md) and [the session handoff](./session-handoff.md). This is the current product direction. The broader architecture in [plan.md](./plan.md) is historical where it conflicts with this document.

## Product promise

A salon or spa enters its public website URL. Porter imports its business information, detects Square, lets the owner review the result and authorize Square access, then enables customers to book through Meta Muse.

**Activated means customers can complete supported bookings through Muse and receive confirmation from Square.** A listing or a link to finish booking elsewhere does not satisfy activation. If Square reports a request as pending, Porter must report pending; it must never present it as a confirmed appointment.

The pilot targets a few US salons and spas using Square Appointments, one location per business, English, and USD. Customers use one Porter connector across participating businesses. Each business becomes data and a merchant connection behind shared tools, not a newly generated MCP server or tool set.

## Accepted decision register

The numbers correspond to the discovery questionnaire.

| ID | Decision |
|---|---|
| 1 | Use Mildred as a reference until its owner agrees to participate. Arrange real appointment testing with a participating owner. The user's relationship to Mildred is unknown. |
| 2 | Include a simple **Continue with Square** authorization step. Detect Square automatically; the owner signs in and approves access without handling API keys. A strict URL-only activation requirement was not retained. |
| 3 | Start with one location per business, US, English, USD, ordinary salon/spa appointments. Defer medical treatments and complex group bookings. |
| 4 | Public visitors can preview an import. Invited businesses can activate through a self-serve flow. Invitation controls cohort size, not a manual setup service. |
| 5 | Show an import preview before account creation. Use an emailed sign-in link to save progress and activate. |
| 6 | Import business name, description, address, public contact information, hours, services, prices, durations, public staff profiles, booking policies, and booking links. Logo/selected photos require owner approval. Reviews, large galleries, retail products, memberships, and gift cards are outside the initial scope. |
| 7 | Square is authoritative for bookable services, prices, staff, availability, and booking rules. Website content supplies descriptive information. Show discrepancies; do not let a Porter edit silently override Square's booking terms. |
| 8 | Require one editable owner review before activation. Show provenance and missing/uncertain data. Leave unknowns empty and resolve booking-critical gaps before enabling the affected service. |
| 9 | Save unsupported or incomplete businesses as drafts with clear recovery steps. Do not activate a reduced booking-link experience as though it fulfills the product promise. |
| 10 | Start with invited Muse testers using a short setup guide and individual Porter credentials. Public Muse directory submission is a separate milestone, not a prerequisite for the private pilot. |
| 11 | One Porter connector covers all active businesses. Give each salon a share page explaining how to connect Porter and ask Muse to book that salon. |
| 12 | Prioritize booking a named salon, with basic name/location lookup. Defer broad local recommendations, marketplace ranking, and comparison shopping. |
| 13 | One customer, one service, one appointment. Support choosing a staff member or any available staff member. Resolve the selected service's price and duration before confirmation. Defer bundles, multiple services, recurring and group/couples bookings. |
| 14 | Payment occurs at the salon. Only enable services compatible with booking without online deposits, prepayment, card holds, or cancellation fees. Respect existing salon policies; do not remove protections to qualify a service. No Porter charges in the pilot. |
| 15 | Customers can view, reschedule, and cancel appointments created through Porter. Require confirmation before changes and display applicable terms. Managing appointments originally booked elsewhere is deferred. |
| 16 | Give every customer a distinct Porter identity. Collect only required appointment contact details. Return the booking reference/details in Muse. Use Square notifications where supported; add Porter messages only to fill a verified gap. Separate Porter email/SMS confirmations are not a default launch requirement. |
| 17 | Owner dashboard: profile, enabled services, connection status, Porter-originated appointments, basic booking counts, and pause/disconnect controls. Square remains the daily scheduling system. |
| 18 | Synchronize Square booking data automatically. Periodically refresh website content, preserve owner edits, and request review of substantial descriptive changes. Recheck live availability and terms before committing. |
| 19 | Explain failures, preserve onboarding progress, and pause new booking when the merchant connection fails. Reconcile uncertain booking outcomes before retrying. Disconnecting Porter leaves Square appointments intact and explains how to manage them. |
| 20 | Provide a small operator dashboard for onboarding failures, connection issues, and booking outcomes. Restrict access to customer information. A named support contact is still needed. |
| 21 | Support account disconnection and deletion requests, minimize customer data, and document retention. Explain the distinction between deleting Porter data and appointment records held by Square/the salon. Exact retention periods remain unresolved. |
| 22 | Free pilot for salons and customers. Measure value before adding billing. |
| 23 | Retain the Porter name. Use a clean, mobile-friendly interface focused on bookings. Custom domain, logo, and visual references are not supplied; propose defaults during design. |
| 24 | Targets: three participating salons, ten genuine customer bookings, owner setup under five minutes when Square is already configured, successful reschedule/cancel tests, and no duplicate bookings caused by retries. Deadline and monthly infrastructure budget remain unknown. |

## Main journeys

### Owner onboarding

1. Open the public Porter URL and paste a public business website URL.
2. Show import progress and identify the booking provider. If extraction fails, explain it and allow retry or correction; do not invent content.
3. Preview the extracted profile, services, source URLs, and uncertain/missing fields.
4. Sign in with an email link to save the draft. Preserve the preview through authentication.
5. Select **Continue with Square** and authorize the merchant connection. Match the connected business and selected location to the imported profile; resolve mismatches explicitly.
6. Reconcile the website preview with Square's catalog and rules. Let the owner edit descriptive fields and choose eligible services.
7. Show an activation checklist: pilot invitation, authorized merchant/location, reviewed profile, valid connection, and at least one supported service. No actual appointment is created by this check.
8. Activate, show the salon share page and Muse setup instructions, and open the owner dashboard.

Owner review and Square authorization may be arranged to avoid repeating forms. The non-negotiable sequence is preview before mandatory signup and explicit review of the final authoritative information before activation.

Suggested states: importing, draft, needs information, needs Square connection, ready, active, paused. Present a specific reason for every blocked transition. A valid salon with no currently open slots is different from a broken connection.

### Customer booking

1. An invited customer creates a Porter identity and connects Porter to Muse using their own credential.
2. The customer names an active salon; Muse retrieves its eligible services through Porter.
3. Resolve service, staff preference, local appointment time, duration, price, and required contact information.
4. Retrieve live availability and present a specific appointment with applicable terms.
5. Obtain explicit customer confirmation. Recheck availability and terms, then create the booking in the correct Square merchant account.
6. Return the provider's actual outcome and booking reference. Report pending or uncertain states honestly; a request being sent is not proof of a confirmed booking.
7. Allow the customer to list, reschedule, or cancel their Porter-created appointments subject to the same ownership and confirmation rules.

Merchant Square authorization and customer Muse credentials serve different purposes. Never reuse a salon credential as a customer's connector credential or share one demo user across pilot customers.

### Owner operation and recovery

Owners see only their business's profile and Porter-originated booking activity. They can pause discovery/new bookings, inspect connection issues, and reconnect. Pause and disconnect must distinguish new bookings from management of existing appointments. If revoked access prevents management, provide a clear route to the salon's own booking/support channel.

Operators can diagnose failures without exposing secrets or unrelated customer data. Unknown upstream booking outcomes require reconciliation before offering a retry that could create another appointment.

## Acceptance criteria

- An anonymous visitor can import and preview a supported public site without creating an account; progress survives the later email sign-in.
- The final review distinguishes imported facts, owner edits, unknowns, and authoritative Square values. Refreshes preserve owner edits.
- An invited owner can authorize Square without handling API keys. A mismatched merchant/location cannot silently activate the imported business.
- Only active businesses and eligible services appear in customer lookup. Draft, unsupported, and paused businesses cannot accept new bookings.
- A completed booking uses the selected merchant, location, service, staff/time, and current terms; success includes a confirmed upstream reference.
- A range such as Mildred's displayed $70–$80 is not silently treated as a fixed $70 quote. Resolve the selected offering from Square; unresolved booking-critical values block that offering.
- Price/time/policy changes after confirmation require a fresh customer decision. A vanished slot returns a clear outcome and alternatives where available.
- Customer and merchant access are isolated. One customer cannot read/change another's bookings; one merchant cannot receive another's credentials or see unrelated appointments.
- Retry, timeout, and process-restart paths do not produce duplicate bookings or lose the ability to reconcile a submitted request.
- Bookings, identities, credentials, confirmation consumption, and retry records persist across deployment/restart. Adding a database without using it does not meet this criterion.
- Reschedule/cancel results reflect Square. Existing Square appointments survive Porter disconnection and data deletion.
- The supported journey is exercised inside Muse with individual customer credentials. SDK/HTTP tests alone do not establish the Muse user experience.
- Pilot and demo environments/data remain distinguishable. A demo payment or mock appointment can never be shown as a real pilot result.
- Owners can request data deletion and understand what remains with Square; support can explain an incident without logging credentials or unnecessary customer details.

## Measures

Track import success, preview-to-activation conversion, owner setup time, supported booking attempts, confirmed bookings, failed/uncertain outcomes, reschedules, cancellations, and repeat use. Separate technical failures from ordinary outcomes such as no available appointment or a customer declining confirmation.

The agreed targets are pilot goals, not results already achieved. Do not manufacture real appointments to meet the ten-booking target. Final measurement windows can be set when a launch date is available.

## External evidence and unresolved facts

Observed on 2026-09-24:

- [Mildred's public site](https://mildred-101695.square.site/) renders a service menu, a haircut at $70–$80 for 30 minutes, and a New York location. Basic text fetching returned no readable content; rendered browser inspection exposed the menu. No private merchant configuration, payment requirements, eligibility, or owner participation was verified, and no booking was attempted.
- [Square OAuth](https://developer.squareup.com/docs/oauth-api/overview) provides seller sign-in and permission approval. Porter must build and operate the callback, credential storage, and refresh/revocation handling.
- [Square Bookings API limitations](https://developer.squareup.com/docs/bookings-api/get-ready-to-use-the-api) include a restriction on creating bookings with non-zero cancellation fees. Paid-plan requirements apply to seller-level booking writes; validate buyer-level versus seller-level permissions for the selected workflow instead of assuming every salon needs an upgrade.
- [Square booking creation](https://developer.squareup.com/reference/square/bookings/create-booking) documents the booking fields and relevant permissions. Validate actual provider behavior before making eligibility claims.
- [Muse's platform page](https://muse.ai/platform) says public directory appearance follows review/approval. An activated salon is available through the connected Porter integration; it is not automatically discoverable by every Muse user.

Recheck provider requirements during implementation. Existing repo documents also record unresolved upstream data rights, privacy requirements, and draft public policies. Carry those items forward as launch work; user approval of this PRD does not establish external permissions or platform approval.

Remaining factual inputs:

- Participating pilot owners and authority to connect/test their accounts; Mildred's status is unknown.
- Availability of a Porter-owned Square developer application and appropriate testing credentials/configuration.
- Actual Square plans, settings, bookable staff, service prices, and payment/cancellation requirements for pilot businesses.
- Invited customers able to test the journey inside Muse.
- Launch date, monthly operating budget, public domain, optional visual assets, email sender/provider, and support contact.
- Final retention periods and any business-specific reporting requirements.

These facts do not require reopening accepted product decisions. Record new answers here when supplied.

### Implementation-session answers

- Mildred is a reference only; no participating owner or live appointment authorization has been supplied.
- The user has an existing Square account and authorized test setup. Developer Console sign-in succeeded. A `Porter Sandbox` application form was prepared; accepting Square's Developer Terms requires the pending user confirmation. No sandbox API validation has occurred yet.
- There is no launch deadline, monthly budget, domain or preferred email provider yet. Keep low-cost local defaults and make deployment settings configurable.
- Authentication credentials are excluded from these documents and from source control.
