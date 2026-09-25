# Square sandbox validation

Validated on **2026-09-24 America/New_York** (successful run completed `2026-09-25T03:24:33.624Z` UTC), using `Square-Version: 2025-01-23` and `https://connect.squareupsandbox.com`.

This verifies the adapter against one configured test seller. It does not verify the owner OAuth journey, multi-merchant routing, Muse, production notifications, or pilot readiness. No production appointment or payment was created. Mildred remains a public reference only.

## Account and configuration

The user accepted Square's Developer Terms. The existing developer account now contains:

| Resource | Configuration |
|---|---|
| Developer application | **Porter Sandbox** in the [Developer Console](https://developer.squareup.com/console/en/apps/sq0idp-aA1YrLQjhRCsgfZsz3Z8Ww/credentials). |
| Dedicated sandbox test account | **Porter Pilot Salon**, US; Appointments initialized on the free plan. |
| Location | One US/USD location; `America/New_York`; Monday–Friday, 09:00–17:00. |
| Service | **Porter Sandbox Haircut**, fixed $65, 30 minutes, available for online booking. |
| Staff | Synthetic **Sandbox Seller**, bookable and assigned to the service/location. |
| Booking settings | Business/location online booking enabled; `ACCEPT_ALL`; customer cancellation enabled; seller-level writes unsupported. |
| OAuth setup | Console-issued sandbox authorization with exactly the seven buyer scopes below. Porter callback, code exchange, refresh and revocation are not implemented. |

`POST /oauth2/token/status` returned HTTP 200 and exactly:

```text
APPOINTMENTS_BUSINESS_SETTINGS_READ
APPOINTMENTS_READ
APPOINTMENTS_WRITE
CUSTOMERS_READ
CUSTOMERS_WRITE
ITEMS_READ
MERCHANT_PROFILE_READ
```

No all-appointments, payment or catalog-write permissions were granted. The current test authorization expires `2026-10-25T03:07:36Z`. Regenerate it through the sandbox console if needed until the actual token lifecycle exists.

Credentials are in the ignored local `.env.square-sandbox`, mode `0600`, separate from the local mock server's `.env` and the Railway demo. Passwords, access/refresh tokens and application secrets do not belong in this record. The application's secret has not been configured for a Porter callback.

## Observed results

Successful run ID: `porter-smoke-05541483-6c8b-4104-927f-f1252c753d9f`.

| Check | Result |
|---|---|
| Business, location, staff and catalog reads | HTTP 200 with the scoped grant; correct timezone, currency, fixed price and duration. |
| Availability and exact-slot recheck | Returned valid service/staff slots; the widened provider search retained the customer's exact requested time. |
| Customer and booking creation | Synthetic given name and phone; no email. Square returned `ACCEPTED`, mapped to `confirmed`; service, staff, location and times matched. |
| Identical create retry | Same full idempotency key and serialized booking body returned the same booking reference. |
| Occupancy | The newly booked slot was no longer offered. |
| Booking retrieval | HTTP 200; current provider booking/version available for management. |
| Reschedule | Sparse update with current version and new `start_at` succeeded; same staff, service, duration and booking reference. |
| Missing booking | Expected HTTP 404 mapped to `NOT_FOUND`. |
| Cancellation | Confirmed by the smoke test and a separate GET returning `CANCELLED_BY_CUSTOMER`. |
| Cleanup | All three appointments created during diagnostics and the final run were independently retrieved as cancelled. Final report: no unresolved references and no uncertain create. Synthetic customer records remain in the sandbox. |

The harness uses its transport to capture the first create body, refuses a different replay payload before sending it, tracks every returned booking reference, and attempts cancellation in `finally`. Failed or uncertain cleanup remains a failure requiring dashboard inspection; the command never silently treats it as a pass. Scope inspection was a separate API check; the smoke command itself does not verify scopes.

## Defects found and corrected

1. **Too-short availability range.** The previous two-minute recheck returned HTTP 400 `INVALID_TIME_RANGE`, with a minimum of one hour in the actual error. Current documentation specifies a 24-hour minimum. The adapter now widens narrow upstream searches to 24 hours and filters times and selected staff locally before applying limits. Both the recorded error and the documented stricter range are covered. [Square availability walkthrough](https://developer.squareup.com/docs/bookings-api/use-the-api).
2. **Buyer update permissions.** Sending even unchanged `appointment_segments` returned HTTP 403 `INSUFFICIENT_SCOPES`. Square allows buyer updates to `start_at` but not the booked segments. Porter now sends a sparse update and rejects changes to staff/service/duration, missing versions and unsupported segment shapes before PUT. It does not request broader scopes or cancel/recreate the appointment. [Buyer update rules](https://developer.squareup.com/docs/bookings-api/use-the-api), [UpdateBooking](https://developer.squareup.com/reference/square/bookings-api/update-booking).
3. **Synthetic smoke email.** Customer creation accepted the generated `example.com` address, but booking creation rejected the email field. The harness now uses the supported minimal given-name/phone path. This does not establish which other email addresses Square accepts; optional email still needs focused validation.

Captured examples and their provenance live in the adapter's [fixture directory](../packages/adapters/square-appointments/src/fixtures/). Older fake catalog, staff, policy and booking fixtures remain synthetic. Recorded examples remove customer details and replace opaque identifiers consistently; they are not a dump of credentials or the full request log.

## Remaining checks

- **Policy eligibility:** The API returned cancellation currency without an amount and omitted cutoff/text fields. Porter correctly reports the policy as unknown. The sandbox Payments & cancellations page repeatedly returned Square's own error page, so no full policy configuration was verified. The successful API write does not prove a salon has no deposit/card/fee obligation. Keep the owner policy review and activation gate.
- **OAuth and isolation:** Owner authorization/state/callback, encrypted token lifecycle and merchant routing are implemented; see the integrated validation below. Extend live tests to two merchants and two customer identities, expired credentials, refresh/disconnect/reconnect.
- **Booking variants and recovery:** Pending acceptance, staff-specific prices, restricted policies, same-key update/cancel retries, lost responses/restarts against Square and operator reconciliation remain open. Pilot quote/UI work must reject unsupported reschedules before confirmation; adapter errors can currently retain conservative engine guards.
- **Notifications and events:** No customer email/SMS delivery or webhook processing was verified. Square documents sandbox email limitations; production buyer notifications require their own evidence. [Sandbox limitations](https://developer.squareup.com/docs/devtools/sandbox/overview).
- **Customer experience:** Run the complete lifecycle through the actual Muse store connection with automatic customer OAuth. The local integration below does not establish Muse acceptance. Keep the Railway personal mock demo separate.

## Reproduce

Use the [setup sequence](square-integration-contract.md#sandbox-setup-sequence) for another sandbox seller. Configure a fixed-price, bookable service/staff and future availability before running. Store only the sandbox base URL and scoped access token in your ignored `.env.square-sandbox`.

```sh
chmod 600 .env.square-sandbox
pnpm build
node --env-file=.env.square-sandbox apps/mcp-server/dist/square-smoke.js
```

The command creates synthetic customer records and test appointments, then cancels every appointment it can identify. Only the official sandbox origin is accepted; redirects and automatic HTTP retries are disabled. If cleanup fails or a create response is lost, inspect the sandbox using the reported run ID before another run.

## Integrated pilot validation — 2026-09-25

The local pilot now also passed a browser and MCP integration run using the synthetic salon, official merchant OAuth credentials and customer OAuth. No production resources or participating customer appointments were used.

- Browser: email-link sign-in, official **Continue with Square**, callback, location/catalog review and activation. The website was an explicit `example.com` sandbox placeholder. Only the $65, 30-minute synthetic haircut was enabled; unpriced services were excluded.
- Customer browser: explicit consent to a clearly named **Porter local OAuth test** client, automatic S256 code exchange with resource binding, all six MCP tools, refresh rotation and revocation. A loopback callback served as the test client. No customer API key was entered.
- OAuth-authenticated MCP: named-salon discovery, availability, two-step confirmed booking, same-request replay returning the same booking, time-only confirmed reschedule, and two-step cancellation all passed through the actual merchant facade and Square sandbox.
- Cleanup: two appointments were created across the diagnostic and successful runs; both cancellation responses reported cancelled. The diagnostic run stopped before rescheduling because the temporary harness compared the wrong time-field name; its `finally` cleanup cancelled that appointment. The corrected run completed. All local test OAuth grants were revoked, including the interrupted run's grant. Synthetic customer records remain in the sandbox.
- Browser layout: the customer connection page has a persistent sandbox banner, no manual key instructions, and an explicit pending-directory-review notice.

This is additional evidence beyond the earlier direct-adapter harness. It does not establish actual Muse compatibility, directory approval, multi-merchant live isolation, Square token refresh/disconnect/reconnect, production notifications, verified webhooks, or uncertain-outcome recovery. Square cancellation fields remain incomplete and unknown; the synthetic owner review does not verify omitted settings. Current automated tests cover many of these failure paths with fixtures, separately from this live evidence.
