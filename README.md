# Porter

> **Current product direction (2026-09-24):** a self-serve Square salon/spa pilot with confirmed bookings through Muse. The [accepted PRD](docs/product-prd.md), [implementation plan](docs/implementation-plan.md), and [session handoff](docs/session-handoff.md) capture this next phase. The overview below describes the existing broader prototype; pilot onboarding and persistent merchant accounts are not implemented yet.

One connector that lets an AI agent find, quote, book, reschedule, cancel and pay for local services — salons, barbers, nail studios, cleaners, plumbers, electricians, HVAC — across many businesses.

The Square salon pilot adds self-serve merchant onboarding behind shared tools. Website content enriches the profile; official Square access supplies booking data and creates appointments.

Targets Meta Muse first, and serves Claude and ChatGPT from the same MCP server.

**Status: pilot foundations in progress.** The MCP demo runs locally. PostgreSQL now persists bookings, confirmations, encrypted retry outcomes and audit records; uncertain writes are held for reconciliation. The Square adapter has documentation-based regression coverage. Public onboarding, merchant OAuth/accounts, recovery tools and dashboards are not implemented yet. See [local development](docs/local-development.md) and [the Square integration contract](docs/square-integration-contract.md).

The [implementation plan](docs/implementation-plan.md) tracks remaining product and launch work, including the unresolved requirements in [the compliance notes](docs/muse-compliance.md). Historical milestone completion does not establish pilot readiness.

> **Provider fixtures are synthetic.** Validate the official Square contract against a sandbox before a real pilot. The experimental public Square adapter is not the approved pilot booking path. See [Provider adapters](#provider-adapters).

---

## Try it

```bash
pnpm install
pnpm demo
```

That starts Porter in demo mode, connects a real MCP client over Streamable HTTP, and walks a full lifecycle against realistic sample businesses: search, availability, the two-phase confirmation, a booking, a retry with the same idempotency key, a reschedule, a deposit paid, a cancellation with a fee, a quote-required job, and the audit trail. Nothing real is touched and no money moves.

It also demonstrates the things that are easy to claim and hard to prove — that quoting a fee does not cancel anything, that a retry does not double-book, and that a business with a hostile name is treated as data.

### Read any Square booking page

```bash
pnpm square:public                      # the built-in example
pnpm square:public "https://book.squareup.com/appointments/<site>/location/<loc>/services"
```

No account, no key, no config. Prints the business, every service with real prices and durations, and the actual cancellation terms.

### Run the tests

```bash
pnpm test        # builds first; PostgreSQL suites require TEST_DATABASE_URL
pnpm build       # typecheck everything
```

### Drive it yourself with the MCP Inspector

```bash
test -f .env || cp .env.example .env
pnpm dev:mcp
npx @modelcontextprotocol/inspector
```

Connect to `http://localhost:8080/mcp` over **Streamable HTTP**, header `Authorization: Bearer demo-key`. Start with `search_providers` and category `"haircut"`. Try `"massage"` for a deposit and `"plumber"` for a quote.

### Point a real agent at it

Works with Claude and ChatGPT as well as Muse, because it is a standards-compliant remote MCP server. Deploy it somewhere with HTTPS (see [`docs/deploy-railway.md`](docs/deploy-railway.md)), then add `https://<your-host>/mcp` as a custom connector.

### Poke at the endpoints

```bash
curl -s localhost:8080/healthz
curl -s localhost:8080/.well-known/oauth-protected-resource | jq
curl -s localhost:8080/docs                       # connector documentation
curl -s -i -X POST localhost:8080/mcp -d '{}'     # 401 + WWW-Authenticate
curl -s -H "Authorization: Bearer demo-key" localhost:8080/v1/audit | jq
```

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
  adapters/web/        reads public booking pages; off by default
  adapters/square-public/  Square's public booking pages; books when no card is required; off by default
  db/                  PostgreSQL store, migrations, encryption, in-memory test store
  payments-stripe/     Stripe Connect gateway
apps/
  mcp-server/          remote MCP over Streamable HTTP; local development OAuth
submission/            Muse form values, icon, validator, checklist
legal/                 privacy notice, terms of service, incident runbook
docs/                  research, plan, compliance mapping, deploy notes
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
| `square-appointments` | beauty, wellness | slots; provider returns pending or confirmed | no | no | yes, from the booking profile |
| `jobber` | home services | arrival windows, business confirms later | no | yes | none published |
| `web` | both | reads public pages; **writes go to the user** | no | no | none published |
| `square-public` | beauty, wellness | slots, confirmed immediately when no card is required | no | no | **yes, per service** |

Square and Jobber expose different booking models through adapter capability flags:

- **Square** publishes open slots. You book a specific minute with a specific team member; the returned status reflects whether the merchant accepts it immediately or requires approval. The team member id travels as `providerSlotRef` so the selected staff member is preserved.
- **Jobber** has no open-slot API at all. It is field-service software: a customer asks for work in an arrival window and the business schedules it afterwards. So `getAvailability` returns *requestable windows*, and a booking comes back `pending` rather than `confirmed`. Saying "confirmed" would tell the user something untrue.

Adding both required **zero changes to `packages/core`**. The only change to an existing package was adding credential support to the conformance suite, which is test infrastructure.

### Before either talks to a real account

1. **Upstream rights clearance.** Connector Terms 4.2 requires Porter to represent it can sublicense provider data to Meta under 3.1, and section 8 makes Porter indemnify Meta for it. Square's and Jobber's developer terms have not been reviewed.
2. **Re-record the fixtures.** Both adapters are tested against wire-level fakes written from published documentation. Square's API is fully documented, so its shapes are solid. **Jobber's full schema sits behind a developer login**, so the mutation inputs are inferred — every one is listed under `VERIFICATION STATUS` at the top of `packages/adapters/jobber/src/api.ts`.

## How the design is shaped by the platform

Porter is built against the Muse Connector Terms and Policies, which are not merely a submission hurdle — several clauses decide how the code is written. See [`docs/muse-requirements.md`](docs/muse-requirements.md).

**Nothing books or charges in one call.** Every mutating tool returns a confirmation envelope first: cost, frequency, cancellation terms and penalties. It commits only when a signed, single-use token comes back. Because Muse may paraphrase Porter's text and that is explicitly not a breach, the displayed summary is never the record — the token is, and the server re-derives the terms at commit time and refuses if anything moved.

**Cached availability is never bookable.** Slots carry a `fetchedAt` and are re-read from the provider immediately before committing. If the slot has gone, the call fails with `SLOT_TAKEN` and fresh alternatives attached, so the agent can offer a choice rather than dead-end the user.

**Booking and payment writes take an idempotency key.** The same key and payload replay the stored response; a different payload is rejected. Validation failures before an external write can release the key. Once a write may have reached the provider, its durable reservation blocks retries until the outcome is known. Existing-booking mutations also hold a durable guard so different keys cannot act on the same stale record. Automatic reconciliation and operator recovery remain required before the pilot. The prototype messaging tool is outside this guarantee and the approved pilot scope.

**Provider text is data, never instructions.** Business names and descriptions are user-editable in the upstream platform, so they are an injection surface. They are typed `UntrustedText` and cannot be serialised without passing through `sanitize()`. Hostile records live in the default fixture set, so every test run exercises this path.

**Adapters receive only the customer fields they declared.** Each adapter names its required and optional fields; core projects the record down before calling it. Forwarding an extra field is a compile error.

**The audit log holds no personal data.** Pseudonymous ids, argument hashes, outcomes, and the *names* of fields disclosed downstream. That is what lets it survive a deletion request while still answering an audit.

**The web adapter reads, it does not write.** It covers businesses that aren't on a connected platform by reading their public page, and it is deliberately read-only. Reading a page wrongly returns a wrong price, which the confirmation step catches because the user sees it. *Booking* through a page wrongly books the wrong appointment, and there is no error to catch — it just happens. So writes hand the user a deep link to the business's own page, the same way a CAPTCHA or a bank's 3-D Secure prompt does. Porter never attempts to solve a CAPTCHA.

**`square-public` reads the page and books through the same buyer API the page uses.** The `<meta name="widget">` tag carries the business, every service and variation with real prices and durations, staff, the location, the cancellation policy text, the no-show cutoff, and **per-variation no-show fees**. Open times come from `POST /buyer/availability`. Booking is a hold, a buyer, then `POST /buyer/reservations`, and it confirms immediately when the business does not collect a card.

A deposit, a no-show hold, or a required card on file needs a payment nonce from Square's page, so those bookings hand the person that link. It needs no merchant account, which is the difference between covering businesses that signed up and businesses that exist. Verified against a live page and a live booking on a salon that does not take a card.

Both are **off unless their source list is set**, and kept separate from the API adapters because the Muse Connector Policies name "violating robots.txt" as a prohibited practice. A Muse-facing deployment leaves it unset.

**Money moves only after a confirmed summary.** Porter charges through its own Stripe account using Connect destination charges, so the business gets its share immediately. Three things matter in the detail:

- **Agent payments are off-session.** Nobody is at a checkout page, so if the bank demands 3-D Secure nobody can answer it. That comes back as a distinct `authentication_required` error with somewhere to send the user, not a generic decline.
- **A card decline and a Stripe outage are different problems.** A decline is the cardholder's to fix; a bad API key or an outage is ours. Reporting the second as the first would send the user to change a card that is fine.
- **Cancel first, then settle.** If a cancellation fee cannot be collected, the appointment is still cancelled — that is what the user confirmed — and the uncollected fee is reported plainly rather than hidden. Taking a fee and then failing to cancel would be the worse failure.

Porter never stores or enters card details. It keeps opaque gateway references, and nothing personal is sent in payment metadata.

## Testing

```bash
pnpm test
```

The suite covers unit behavior, adapter conformance, prompt injection, confirmations, concurrent mutations, payments, routing, and the MCP booking lifecycle over real HTTP. Set `TEST_DATABASE_URL` to include PostgreSQL ownership, encryption, migration and server-restart tests; see [local development](docs/local-development.md).

Any new adapter must pass the conformance suite in `packages/adapters/contract` unchanged. That is what makes "add a platform without touching core" a real claim.

## Submitting to Muse

```bash
pnpm submission:validate
```

That applies Muse's own client-side rules — required fields, the 80 and 120 character limits, HTTPS on the endpoint, and the icon's byte-level 512×512 and 256 KiB checks — and refuses to pass while any placeholder remains.

See [`submission/checklist.md`](submission/checklist.md) for the ordered steps and [`docs/deploy-railway.md`](docs/deploy-railway.md) for deployment.
