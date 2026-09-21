# Porter

One connector that lets an AI agent find, quote, book, reschedule, cancel and pay for local services — salons, barbers, nail studios, cleaners, plumbers, electricians, HVAC — across many businesses.

Porter does not onboard businesses one at a time. It integrates with the booking and field-service software those businesses already run, and normalises all of it behind one small tool surface.

Targets Meta Muse first, and serves Claude and ChatGPT from the same MCP server.

**Status: milestone 4 complete.** Core, mock adapter and MCP server work end to end locally. Square Appointments and Jobber adapters pass the conformance suite. Stripe payments, cancellation fees, the audit trail and rate limiting are live. Muse packaging is milestone 5.

> **Neither remote adapter may be pointed at a real account yet.** Both are tested against wire-level fakes built from published documentation, not recorded sandbox traffic, and the upstream rights question in `docs/plan.md` section 9 item 7 is unresolved. See [Provider adapters](#provider-adapters).

---

## Quick start

```bash
pnpm install
pnpm build
pnpm test

# run the server
PORTER_API_KEYS=demo-key:user_demo pnpm dev:mcp
```

Then:

```bash
curl -s localhost:8080/.well-known/oauth-protected-resource | jq
```

### With the MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

Connect to `http://localhost:8080/mcp` over **Streamable HTTP**, with header `Authorization: Bearer demo-key`.

---

## Layout

```
packages/
  shared/              errors, ids, untrusted text, redaction, logging, money
  core/                domain model, taxonomy, booking engine, adapter interface
  adapters/contract/   the conformance suite every adapter must pass
  adapters/mock/       realistic fake businesses; tests and demo mode
  adapters/square-appointments/  beauty and wellness, REST
  adapters/jobber/     home services, GraphQL
  db/                  Drizzle schema, in-memory store
  payments-stripe/     Stripe Connect gateway
apps/
  mcp-server/          remote MCP over Streamable HTTP + OAuth 2.1
docs/                  research, plan, and a local copy of the Connector Terms
```

## The nine tools

| Tool | What it is for |
|---|---|
| `search_providers` | Find businesses that can do a job |
| `get_availability` | Open appointment times for one business and service |
| `get_quote` | Price estimate for jobs that need one |
| `create_booking` | Book an appointment |
| `reschedule_booking` | Move an appointment |
| `cancel_booking` | Cancel, returning any fee first |
| `list_my_bookings` | The user's appointments |
| `pay_or_deposit` | Pay or place a deposit |
| `message_provider` | Message a business about a booking |

## Provider adapters

| Adapter | Vertical | Shape | Slot hold | Quotes | Cancellation policy |
|---|---|---|---|---|---|
| `mock` | both | slots | yes | yes | yes |
| `square-appointments` | beauty, wellness | slots, confirmed immediately | no | no | yes, from the booking profile |
| `jobber` | home services | arrival windows, business confirms later | no | yes | none published |

Square and Jobber are genuinely different products, and the difference is carried by capability flags rather than by branches in core:

- **Square** publishes open slots. You book a specific minute with a specific team member and it is confirmed immediately. The team member id travels as `providerSlotRef`, because dropping it would silently rebook with someone else.
- **Jobber** has no open-slot API at all. It is field-service software: a customer asks for work in an arrival window and the business schedules it afterwards. So `getAvailability` returns *requestable windows*, and a booking comes back `pending` rather than `confirmed`. Saying "confirmed" would tell the user something untrue.

Adding both required **zero changes to `packages/core`**. The only change to an existing package was adding credential support to the conformance suite, which is test infrastructure.

### Before either talks to a real account

1. **Upstream rights clearance.** Connector Terms 4.2 requires Porter to represent it can sublicense provider data to Meta under 3.1, and section 8 makes Porter indemnify Meta for it. Square's and Jobber's developer terms have not been reviewed.
2. **Re-record the fixtures.** Both adapters are tested against wire-level fakes written from published documentation. Square's API is fully documented, so its shapes are solid. **Jobber's full schema sits behind a developer login**, so the mutation inputs are inferred — every one is listed under `VERIFICATION STATUS` at the top of `packages/adapters/jobber/src/api.ts`.

## How the design is shaped by the platform

Porter is built against the Muse Connector Terms and Policies, which are not merely a submission hurdle — several clauses decide how the code is written. See [`docs/muse-requirements.md`](docs/muse-requirements.md).

**Nothing books or charges in one call.** Every mutating tool returns a confirmation envelope first: cost, frequency, cancellation terms and penalties. It commits only when a signed, single-use token comes back. Because Muse may paraphrase Porter's text and that is explicitly not a breach, the displayed summary is never the record — the token is, and the server re-derives the terms at commit time and refuses if anything moved.

**Cached availability is never bookable.** Slots carry a `fetchedAt` and are re-read from the provider immediately before committing. If the slot has gone, the call fails with `SLOT_TAKEN` and fresh alternatives attached, so the agent can offer a choice rather than dead-end the user.

**Every write takes an idempotency key.** Same key and same payload replays the stored response. Same key and a *different* payload is a hard error — that is the case that catches real double-booking bugs. A failed call releases the key so a retry works.

**Provider text is data, never instructions.** Business names and descriptions are user-editable in the upstream platform, so they are an injection surface. They are typed `UntrustedText` and cannot be serialised without passing through `sanitize()`. Hostile records live in the default fixture set, so every test run exercises this path.

**Adapters receive only the customer fields they declared.** Each adapter names its required and optional fields; core projects the record down before calling it. Forwarding an extra field is a compile error.

**The audit log holds no personal data.** Pseudonymous ids, argument hashes, outcomes, and the *names* of fields disclosed downstream. That is what lets it survive a deletion request while still answering an audit.

**Porter never scrapes.** API only, always.

**Money moves only after a confirmed summary.** Porter charges through its own Stripe account using Connect destination charges, so the business gets its share immediately. Three things matter in the detail:

- **Agent payments are off-session.** Nobody is at a checkout page, so if the bank demands 3-D Secure nobody can answer it. That comes back as a distinct `authentication_required` error with somewhere to send the user, not a generic decline.
- **A card decline and a Stripe outage are different problems.** A decline is the cardholder's to fix; a bad API key or an outage is ours. Reporting the second as the first would send the user to change a card that is fine.
- **Cancel first, then settle.** If a cancellation fee cannot be collected, the appointment is still cancelled — that is what the user confirmed — and the uncollected fee is reported plainly rather than hidden. Taking a fee and then failing to cancel would be the worse failure.

Porter never stores or enters card details. It keeps opaque gateway references, and nothing personal is sent in payment metadata.

## Testing

```bash
pnpm test
```

178 tests: unit, adapter conformance, prompt injection, compliance, payments, multi-adapter routing, and integration tests that drive the real MCP server over real HTTP through a full booking lifecycle.

Any new adapter must pass the conformance suite in `packages/adapters/contract` unchanged. That is what makes "add a platform without touching core" a real claim.

## Deploying to Railway

Not yet deployed. When it is:

1. Set `PORTER_SIGNING_SECRET` to a stable 32+ character secret. Rotating it invalidates outstanding slot ids and confirmation tokens.
2. Set `PORTER_ISSUER` to the public HTTPS origin, exactly. It is the OAuth issuer and the RFC 9728 resource identifier, and Muse requires HTTPS.
3. Add Railway Postgres and set `DATABASE_URL` (milestone 3).
4. Health check: `GET /healthz`.
