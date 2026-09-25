# Muse salon pilot submission checklist

Updated 2026-09-25. Porter is not represented here as approved, published, or tested end to end inside Muse.

The public [Muse Connector Platform page](https://muse.ai/platform), checked on 2026-09-25, describes review before directory appearance. Current authenticated form fields, terms, OAuth callbacks and client requirements remain unverified. The packet and validator contain an earlier form schema; validation does not prove compatibility with today's authenticated form.

## Requirements to verify before submission

- [ ] Verify the current authenticated Muse submission form, Connector Terms, incorporated policies and data-protection requirements; retain a dated, credential-free record.
- [ ] Obtain Muse's actual OAuth client-registration, callback, PKCE, resource and scope requirements. Compare them with Porter's public-client implementation; do not invent callback URLs or assume dynamic registration will be accepted.
- [ ] Review permissions for merchant-authorized Square data and public website descriptions under the current source/provider and Muse terms.
- [ ] Review final privacy and product terms for publication and the incident-response runbook for operation; resolve legal entity, domain, support contact, retention and deletion procedures.
- [ ] Keep the accepted customer journey: find Porter in the Muse directory → Connect → Porter sign-in and OAuth consent → return to Muse. Customers do not copy keys or configure endpoints.

## Deploy the pilot

- [ ] Use a separate pilot deployment/database from the personal mock demo. Set `PORTER_PILOT_ENABLED=true`, `PORTER_DEMO_MODE=false`, `PORTER_STORAGE=postgres` and `PORTER_API_KEYS=`; leave deployment-wide provider/payment/public-page adapter credentials unset.
- [ ] Set a stable `PORTER_SIGNING_SECRET` and independent `PORTER_ENCRYPTION_KEY`. Keep secrets in deployment secret storage and apply the committed migrations, including customer OAuth v5, before startup.
- [ ] Set `PORTER_ISSUER` to the exact public HTTPS origin; configure and verify email delivery. File-email mode and `PORTER_INTERNAL_API_KEYS=true` are restricted to local sandbox testing and must not be enabled on the hosted pilot.
- [ ] Register the Square callback `<PORTER_ISSUER>/square/callback` in the correct Square application/environment. Merchant Square authorization is separate from customer Muse OAuth.
- [ ] Configure invited owners, complete Square location/service/policy review and activate only supported test businesses. Do not authorize production appointments through a test checklist.
- [ ] Publish `/privacy`, `/terms` and accurate `/docs`; verify `/healthz`, OAuth metadata, the `/mcp` bearer challenge and deployment restart behavior.
- [ ] Leave `PORTER_MUSE_CONNECTOR_URL` unset until an approved directory URL is known. Do not treat a locally active salon as a published Muse connector.

## Functional and security evidence

- [ ] Run the complete committed-state suite with PostgreSQL and required CI checks. Retain the reviewed commit and test results.
- [ ] Verify the hosted customer OAuth flow: registered callback, S256 PKCE, exact resource, browser-bound consent, denied consent, expiry, refresh rotation/reuse detection and revocation.
- [ ] Use two distinct customer accounts to verify appointment isolation and granted-scope enforcement; verify tokens and private sign-in links never appear in public docs or logs.
- [ ] Exercise named-salon lookup → availability → confirmed create → list → confirmed time-only reschedule → confirmed cancellation inside Muse using authorized sandbox resources. Record actual provider states, appointment references and cleanup.
- [ ] Verify paused businesses reject new discovery/bookings while supported management of existing appointments remains available; disconnected access supplies an honest failure/contact route.
- [ ] Verify price, policy and upstream booking changes invalidate earlier confirmation. Confirm unsupported fees never produce a pilot payment or a false success.
- [ ] Test unknown-write recovery and support procedures before inviting customers. A sent request is not proof of a confirmed appointment; no blind retry is allowed.
- [ ] Record actual Muse presentation, callback completion and notification behavior separately from SDK/HTTP tests and the earlier Square sandbox lifecycle.
- [ ] Review website import claims: bounded public HTML scraping, robots-policy checks, source provenance and owner review; scripts are not executed. Unsupported pages must display warnings rather than invented services or prices.

## Submission packet

- [ ] Replace every factual placeholder in [connector-submission.json](connector-submission.json); keep approval attestations false until an authorized person reviews the current form and accepts them.
- [ ] Run `pnpm submission:validate`, then compare its historical rules with the authenticated form. A green local validator is only one check.
- [ ] Use the actual HTTPS MCP endpoint and describe OAuth with PKCE as the customer auth method. Do not advertise manual API keys as product setup.
- [ ] State that the pilot does not accept payments: customers pay at the salon. Do not include Stripe, payment, quote or provider-messaging tools in the pilot scope.
- [ ] Declare all six tools: `search_providers`, `get_availability`, `create_booking`, `list_my_bookings`, `reschedule_booking`, `cancel_booking`.
- [ ] Disclose the multi-business Square routing, bounded website import, invited US salon/spa scope, one location, English/USD, eligible fixed-price services and unsupported payment obligations.
- [ ] Provide the icon, final support/policy/documentation URLs and reviewer access through the agreed authorization flow. Synthetic test resources must be clearly identified.
- [ ] Have an authorized person make the submission attestations. Review [muse-compliance.md](../docs/muse-compliance.md) for remaining gates.

## After review

- [ ] Record Meta's actual decision and address requested changes; no approval or review deadline is presumed.
- [ ] Once approved, set the verified directory URL and test a fresh customer's published connection journey.
- [ ] Maintain an authorized review environment, support ownership, incident response, monitoring and periodic terms checks. Keep mock, sandbox and production evidence distinguishable.
