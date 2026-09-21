# Porter

One connector that lets an AI agent find, quote, book, reschedule, cancel and pay for local services — salons, barbers, nail studios, cleaners, plumbers, electricians, HVAC — across many businesses.

Porter does not onboard businesses one at a time. It integrates with the booking and field-service software those businesses already run, and normalises all of it behind one small tool surface.

Targets Meta Muse first, and serves Claude and ChatGPT from the same MCP server.

**Status: milestone 2 complete.** Core, mock adapter and MCP server work end to end locally, with tests. Square and Jobber adapters are milestone 3.

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
  db/                  Drizzle schema, in-memory store
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

## How the design is shaped by the platform

Porter is built against the Muse Connector Terms and Policies, which are not merely a submission hurdle — several clauses decide how the code is written. See [`docs/muse-requirements.md`](docs/muse-requirements.md).

**Nothing books or charges in one call.** Every mutating tool returns a confirmation envelope first: cost, frequency, cancellation terms and penalties. It commits only when a signed, single-use token comes back. Because Muse may paraphrase Porter's text and that is explicitly not a breach, the displayed summary is never the record — the token is, and the server re-derives the terms at commit time and refuses if anything moved.

**Cached availability is never bookable.** Slots carry a `fetchedAt` and are re-read from the provider immediately before committing. If the slot has gone, the call fails with `SLOT_TAKEN` and fresh alternatives attached, so the agent can offer a choice rather than dead-end the user.

**Every write takes an idempotency key.** Same key and same payload replays the stored response. Same key and a *different* payload is a hard error — that is the case that catches real double-booking bugs. A failed call releases the key so a retry works.

**Provider text is data, never instructions.** Business names and descriptions are user-editable in the upstream platform, so they are an injection surface. They are typed `UntrustedText` and cannot be serialised without passing through `sanitize()`. Hostile records live in the default fixture set, so every test run exercises this path.

**Adapters receive only the customer fields they declared.** Each adapter names its required and optional fields; core projects the record down before calling it. Forwarding an extra field is a compile error.

**The audit log holds no personal data.** Pseudonymous ids, argument hashes, outcomes, and the *names* of fields disclosed downstream. That is what lets it survive a deletion request while still answering an audit.

**Porter never scrapes.** API only, always.

## Testing

```bash
pnpm test
```

69 tests: unit, adapter conformance, prompt injection, compliance, and integration tests that drive the real MCP server over real HTTP through a full booking lifecycle.

Any new adapter must pass the conformance suite in `packages/adapters/contract` unchanged. That is what makes "add a platform without touching core" a real claim.

## Deploying to Railway

Not yet deployed. When it is:

1. Set `PORTER_SIGNING_SECRET` to a stable 32+ character secret. Rotating it invalidates outstanding slot ids and confirmation tokens.
2. Set `PORTER_ISSUER` to the public HTTPS origin, exactly. It is the OAuth issuer and the RFC 9728 resource identifier, and Muse requires HTTPS.
3. Add Railway Postgres and set `DATABASE_URL` (milestone 3).
4. Health check: `GET /healthz`.
