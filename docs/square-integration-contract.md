# Square integration contract for the salon pilot

Updated: 2026-09-24 (America/New_York). Status: the exact seven-scope sandbox grant passed discovery, create, identical replay, time-only reschedule and cancellation. See the [validation record](square-sandbox-validation.md) for captured evidence and remaining checks. Production and Muse have not been tested with this integration. This document supports [the PRD](./product-prd.md) and [implementation plan](./implementation-plan.md); it does not establish launch readiness.

Mildred is a website reference, not a participating merchant. The user accepted the Developer Terms. The Porter Sandbox application and a separate Porter Pilot Salon sandbox seller are configured. Do not connect or create appointments at Mildred based on the public URL.

## Permission mode

Use merchant-authorized OAuth with **buyer-level booking permissions**. Square calls this buyer-level because of the booking operations allowed; the merchant still approves access to its account through Continue with Square. It fits Porter's app-created booking scope and does not require a seller to purchase Appointments Plus/Premium. Seller-level writes add broader calendar control and require a paid Appointments plan. [Bookings API overview](https://developer.squareup.com/docs/bookings-api/what-it-is), [CreateBooking reference](https://developer.squareup.com/reference/square/bookings/create-booking).

Request these scopes together when connecting the merchant:

| Scope | Porter purpose |
|---|---|
| `APPOINTMENTS_READ` | Availability; retrieve and list the application's bookings; booking webhooks. |
| `APPOINTMENTS_WRITE` | Create, reschedule and cancel supported customer bookings. |
| `APPOINTMENTS_BUSINESS_SETTINGS_READ` | Business, location and bookable staff profiles. |
| `ITEMS_READ` | Service variations, locations, prices and durations from the catalog. |
| `MERCHANT_PROFILE_READ` | Match the authorized merchant and its location. |
| `CUSTOMERS_READ` | Find the customer record needed for the appointment. |
| `CUSTOMERS_WRITE` | Create that customer record with required contact details. |

Endpoint scope requirements come from [Square's OAuth permissions table](https://developer.squareup.com/docs/oauth-api/square-permissions). Do not request `APPOINTMENTS_ALL_WRITE`, payment scopes, catalog write access or business-settings write access for this pilot. `APPOINTMENTS_ALL_READ` is unnecessary for the selected buyer endpoints; the overview's broader free-plan example includes it, but the endpoint permissions table distinguishes it as seller-level read access. The exact seven-scope grant was verified through token status and the sandbox lifecycle. For further failures, record the specific endpoint/error instead of silently escalating permissions.

Buyer-level list/webhook visibility is application-wide within the merchant, not an authorization boundary between Porter's customers. Porter must persist and enforce customer ownership itself. Only its stored booking references belong in customer or owner views. [RetrieveBooking permissions](https://developer.squareup.com/reference/square/bookings/retrieve-booking), [booking event visibility](https://developer.squareup.com/docs/bookings-api/use-webhooks).

## Merchant connection lifecycle

The server should use Square's confidential-client authorization code flow. Bind a short-lived, single-use OAuth `state` to the signed-in owner and draft business; compare it on callback before accepting either success or denial. Exchange the authorization code on the server, then bind the returned `merchant_id` to the connection and explicitly choose/match one location. Configure the exact callback in the correct Square environment. Production requires HTTPS; Square's OAuth overview permits localhost HTTP for sandbox development. Use HTTPS for the shared test deployment. [OAuth overview](https://developer.squareup.com/docs/oauth-api/overview), [redirect registration](https://developer.squareup.com/docs/oauth-api/create-urls-for-square-authorization).

Store provider access/refresh tokens encrypted and record the requested scopes and provider expiry. Schedule refresh at least every seven days, monitor failures, and support revocation/reconnection. Store new token values atomically. Revocation must pause new booking without deleting appointments. Do not put provider tokens into browser storage, agent tools, public pages, source control or logs. Square supports tokens of varying lengths, so token length is not a validity check. [Token handling and renewal](https://developer.squareup.com/docs/oauth-api/receive-and-manage-tokens).

The adapter receives an access token; it does not implement OAuth, refresh or revocation. Its caches are partitioned by a non-reversible token digest. This prevents reuse of cached catalog/profile data across different credentials, but does not replace merchant ownership checks, unique provider identities, or durable merchant connections.

`SquareOAuthClient` now implements the provider side of authorization: the consent URL, code exchange, token-status verification, refresh and full-grant revocation. It verifies the application, merchant, expiry and exact scope set, uses fixed Square environment origins, and does not follow redirects or retry authorization writes. Errors contain only Porter's closed messages. This module is covered by transport-level tests; the browser callback, session/state binding, encrypted connection store and owner journey must be integrated separately before it can be used for onboarding.

## Activation and booking eligibility

The selected merchant/location must satisfy the PRD's US, USD, single-location, ordinary salon/spa scope. Import review must establish each enabled offering's exact service variation, bookable staff, duration and price. An unavailable slot is an ordinary business result; an unavailable booking connection blocks activation.

| Check | Source and enforcement |
|---|---|
| Appointments initialized; online booking enabled | Retrieve the business and selected location booking profiles. Set up Appointments in the seller dashboard first. |
| Service visible at the selected location | Respect both the parent item's and variation's `present_at_all_locations`, `present_at_location_ids`, and `absent_at_location_ids`; exclude deleted/archived entries. |
| Explicitly bookable service with known duration/version | Require `available_for_booking`, positive duration and catalog version. Do not manufacture a duration. |
| Resolved service price | Use the selected location's pricing override where supplied; unresolved or variable pricing does not qualify for booking. Staff-dependent pricing still needs live validation. |
| Staff can perform the service at the requested time | Use returned availability segments and preserve the selected team member and duration. A generally bookable staff member is not proof of availability for a service. |
| No online payment obligation | Exclude deposits, prepayments, card guarantees and cancellation fees. A known non-zero cancellation fee blocks creation. Missing machine-readable settings do not prove eligibility; retain owner confirmation and provider validation. |
| Customer contact | Square requires the attached Customer's phone number. Porter asks for given name and phone with an explicit international country code; email/family name/notes are optional. Display spaces, parentheses and hyphens are normalized without guessing a country. |

Catalog location rules and overrides: [CatalogObject](https://developer.squareup.com/reference/square/objects/CatalogObject), [CatalogItemVariation](https://developer.squareup.com/reference/square/objects/CatalogItemVariation), [ItemVariationLocationOverrides](https://developer.squareup.com/reference/square/objects/ItemVariationLocationOverrides). Square's [booking prerequisites](https://developer.squareup.com/docs/bookings-api/get-ready-to-use-the-api) prohibit API creation with non-zero cancellation fees. Square's [booking walkthrough](https://developer.squareup.com/docs/bookings-api/use-the-api) documents the required customer phone and the service/team-member availability sequence.

**The official responses reviewed do not establish a complete automated deposit/card-policy detector.** Their absence in a response must not enable an offering automatically. The current adapter rejects known fee and unresolved-price cases; a merchant activation policy review remains required. Preserve seller protections. Do not change salon settings merely to pass eligibility.

`booking_policy` may require seller acceptance. `PENDING` must stay pending, and only `ACCEPTED` maps to confirmed. Do not advertise an immediate-confirmation journey for a merchant whose settings require approval. Square remains authoritative if a booking is declined or changed later. [Booking status model](https://developer.squareup.com/reference/square/objects/Booking).

Buyer cancellation/rescheduling must respect the seller's rules, including `allow_user_cancel`, the cancellation window and appointment start time. Square describes the window as a cutoff for changes, not a promise that paying a fee permits late cancellation. The UI should show the merchant's policy text and a contact route when online management is unavailable. [Booking lifecycle rules](https://developer.squareup.com/docs/bookings-api/use-the-api), [BusinessAppointmentSettings](https://developer.squareup.com/reference/square/objects/BusinessAppointmentSettings).

Buyer rescheduling changes **time only**, preserving the booked service, staff member and duration. Send a sparse `UpdateBooking` with the current version and new `start_at`; including even unchanged `appointment_segments` returned 403 under the verified grant. The adapter rejects segment changes or multiple segments before sending the update. Do not infer seller permissions from a merchant's subscription, request broader scopes, or cancel/recreate to bypass this restriction. The pilot quote/UI must filter unsupported changes before confirmation; the current engine can conservatively retain an uncertain-operation guard when the adapter rejects a mutation. [Square's buyer update fields](https://developer.squareup.com/docs/bookings-api/use-the-api), [sparse updates](https://developer.squareup.com/reference/square/bookings-api/update-booking).

## Sandbox setup sequence

Once the developer account owner can sign in:

1. Open the [Square Developer Console](https://developer.squareup.com/apps) and create a Porter application.
2. In **Sandbox Test Accounts**, open **Default Test Account** to enter its sandbox dashboard. A separately created test account is also valid.
3. Open **Appointments**, select **Get started**, and complete the test business details and timezone. Skip the optional app download.
4. Keep the free Appointments plan for this buyer-mode test. Add one test service with a fixed USD price, duration and online booking enabled.
5. Under **Staff**, configure a bookable staff member, assign that service and location, and provide working hours. API creation of an employee alone does not make that person bookable.
6. Select a test booking policy with no fee/card/deposit requirement; record the exact settings. Set customer cancellation/rescheduling terms. Use synthetic customer contact data.
7. For adapter validation before the callback exists, use the Developer Console's sandbox OAuth authorization controls for the test account and select exactly the seven scopes above. Keep that token in an ignored local file. To validate the actual owner journey later, register the implemented Porter callback, configure the sandbox application ID/secret securely, and exercise the authorization code flow.
8. Use `https://connect.squareupsandbox.com` for sandbox API requests. Retrieve the business profile and location to verify initialization. A production token must never be substituted to make a sandbox test pass.

Square documents the dashboard/Appointments setup in [Onboard to Square Appointments](https://developer.squareup.com/docs/bookings-api/onboard-to-the-api), sandbox grants in [Sandbox overview](https://developer.squareup.com/docs/devtools/sandbox/overview), and application callback setup in [OAuth redirect registration](https://developer.squareup.com/docs/oauth-api/create-urls-for-square-authorization). The [validation record](square-sandbox-validation.md) distinguishes completed setup from remaining policy and OAuth checks.

## Required provider validation record

Run this matrix with the exact OAuth grant and selected API version. Save sanitized response fixtures with date, environment, version and requested scope set; retain no tokens, private contact data or unauthorized real appointments.

| Scenario | Evidence needed before pilot |
|---|---|
| Authorized merchant and selected location | Merchant/location association; timezone/currency; business and location booking profiles. |
| Catalog and staff | Pagination, real presence/override fields, bookable staff, fixed and variable price cases; compare service duration against availability. |
| Create/retrieve | Synthetic customer with phone; exact selected segment; actual `PENDING` or `ACCEPTED`; real provider reference. |
| Repeat and uncertain create | Same full idempotency key + immutable payload; one resulting booking; recovery after response loss/restart. |
| Reschedule/cancel | Current version, preserved segment with changed start time, seller restrictions, actual resulting status, same-key retries. |
| Policy failures | Non-zero fee, card/deposit protection and unresolved prices remain unsupported; no silent booking-site handoff. |
| OAuth lifecycle | Denial/invalid state, refresh, revoked/expired credentials, reconnect to same/different merchant. |
| Events and notifications | Signed `booking.created`/`booking.updated` webhook delivery; edits from seller dashboard; determine buyer-mode email/SMS behavior for create/change/cancel. |
| Isolation | Two sandbox merchants and two Porter customers cannot read or mutate each other's bookings or reuse catalogs/policies. |

Square explicitly says seller-level create/update operations do not send customer email/SMS. Buyer-level delivery must be observed for the actual settings before promising it. Webhooks are integration events, not customer notifications. [Square webhook guide](https://developer.squareup.com/docs/bookings-api/use-webhooks).

## What this implementation change verifies

Local tests exercise phone validation, contact matching, customer-lookup failures, known-fee rejection, preservation of selected durations and full idempotency keys, honest empty cancellation outcomes, catalog pagination/presence/overrides, fresh catalog checks and credential cache separation. The fake's fee-free and location fixtures now match documented structures. It rejects bookings without a customer phone.

The adapter still pins `Square-Version: 2025-01-23`, which was used for the successful sandbox run. The live documentation reviewed currently shows newer versions. Preserve the pin until a separately tested migration establishes the target. Older fake fixtures remain synthetic; newly recorded examples are explicitly identified in the validation record.

Durable customer booking ownership is implemented. Remaining integration work includes merchant ownership/routing, operation reconciliation, merchant OAuth, complete activation policy review, staff-dependent terms, buyer notification evidence, webhook processing, and an end-to-end Muse test. The successful smoke test is narrower evidence than the complete matrix above.
