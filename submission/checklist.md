# Submission checklist

Ordered so the blockers come first.

## Blockers — do not submit until these are resolved

- [ ] **Upstream rights clearance (§4.2).** Confirm Square's and Jobber's developer terms permit redistributing their business data to Meta under the §3.1 licence — worldwide, sublicensable, usable to improve Muse. Porter indemnifies Meta for this under §8, and Meta's own liability caps at $1,000. Legal review.
- [ ] **Read Meta's Data Protection Requirements (§4.3(d))** at `facebook.com/legal/terms/Privacy`. Porter is an independent controller and is bound by them directly.
- [ ] **Legal review** of `legal/privacy-notice.md`, `legal/terms-of-service.md`, `legal/incident-response.md`.

## Deploy

- [ ] Deploy to Railway; `PORTER_ISSUER` exactly matches the public HTTPS origin
- [ ] `PORTER_SIGNING_SECRET` set to a stable 32+ character value
- [ ] Publish the privacy notice at `/privacy` and terms at `/terms`
- [ ] `GET /docs` serves the connector documentation
- [ ] `PORTER_DEMO_MODE=true`, with a reviewer API key in `PORTER_API_KEYS`
- [ ] Verify: `/healthz`, both `.well-known` documents, and a 401 from `/mcp` carrying `WWW-Authenticate`
- [ ] Confirm end to end with the MCP Inspector against the deployed URL

## Form

- [ ] `pnpm submission:validate` passes with no remaining placeholders
- [ ] Fill every field from `connector-submission.json`
- [ ] Connection type: **Existing MCP**; endpoint: `https://<domain>/mcp`
- [ ] Auth methods: **OAuth with PKCE** and **API keys**
- [ ] Payments: **My connector accepts payments**
- [ ] Upload `assets/porter-icon-512.png`
- [ ] Paste `extraNotes` in full — it is the aggregator disclosure and the declared action range

## Meta's review criteria

Meta reviews for *"functional, security, and legal requirements"* and completes *"end to end testing"*.

- [ ] **Functional** — a reviewer can run search → availability → confirm → book → reschedule → cancel in demo mode without a merchant account. `pnpm demo` walks exactly that.
- [ ] **Security** — provider text is sanitised; no prompt-injection vector; credentials encrypted; audit log holds no personal data; `pnpm test` green.
- [ ] **Legal** — `docs/muse-compliance.md` maps every clause, with open items named.

## On the day

- [ ] Re-verify the Terms against the live page (§9.4 allows Meta to change them on 30 days' notice)
- [ ] Re-run `pnpm submission:validate`
- [ ] Log in to Muse — the form requires an account
- [ ] Tick the three attestations yourself

## After

- [ ] Watch for the review outcome; no SLA is published
- [ ] Keep demo mode on; §2.1 lets Meta re-review at any time
- [ ] Diary a periodic Terms re-check
