# Muse Connector Terms — compliance mapping

**Last verified against the live form and page:** 2026-09-21 (form chunk byte-identical to the 2026-09-18 capture)
**Terms version:** 2026-09-18, stored at [`reference/muse-connector-terms-2026-09-18.md`](./reference/muse-connector-terms-2026-09-18.md)

This is the document that answers a §4.4 audit. Each clause maps to where Porter satisfies it, with a file to look at.

Status key: **Done** · **Ops** (needs a running deployment or a human) · **Open** (unresolved)

---

## 2. Submission and approval

| Clause | Requirement | Status | Where |
|---|---|---|---|
| §2.1 | Submission information must be true and accurate; functionality not obscured | Done | `submission/connector-submission.json` states plainly that Porter is a multi-business aggregator. Unknowable fields are `REPLACE_ME`, never guessed. `submission/validate.ts` refuses to pass while placeholders remain. |
| §2.1 | Connector may be re-reviewed at any time | Ops | Demo mode stays enabled so a reviewer can re-test at will. |
| §2.2 | Meta may remove any connector at any time | Done | Architecture does not depend on directory listing. The custom-connector path needs no approval, and the same MCP server serves Claude and ChatGPT. |

## 3. Licences

| Clause | Requirement | Status | Where |
|---|---|---|---|
| §3.1 | Broad licence granted to Meta over Connector Content | **Open** | Porter can grant this over its own output. Whether it can sublicense **Square and Jobber business data** is the unresolved rights question. See §4.2. |
| §3.3(d) | No misrepresenting affiliation with Meta | Done | No Meta branding anywhere. Porter's icon and name are its own. |
| §3.3(e) | No circumventing rate limits or safety systems | Done | Porter rate-limits *itself*, per user and per adapter (`packages/core/src/ratelimit.ts`). |

## 4. Developer obligations

### §4.1 Functionality and accuracy

| Requirement | Status | Where |
|---|---|---|
| Perform as described in the submission | Done | Nine tools, matching the submission exactly. `apps/mcp-server/src/tools.ts` |
| Accurate and up-to-date content | Done | Slots carry `fetchedAt` and are re-read from the provider immediately before commit. Stale availability is never bookable. `packages/core/src/engine.ts` (`#recheck`) |
| Never invent data | Done | Unknown cancellation policy reports `known: false` rather than a zero fee. Unmappable service categories map to `null`, not a guess. Ratings are passed through with their source or omitted. |
| Fix stale data and broken endpoints promptly | Ops | `GET /healthz`; uptime monitoring to be attached at deploy. |
| Maintain support contact | Ops | `support` field in the submission packet. |

### §4.2 Rights and permissions — **the open item**

| Requirement | Status | Where |
|---|---|---|
| Represent that Porter holds all rights for Meta's exercise of §3.1 | **Open** | Porter surfaces Square and Jobber business data it does not own. Whether their developer terms permit sublicensing it to Meta on §3.1's terms has **not** been reviewed. `docs/plan.md` §9 item 7. |

**This gates every real provider account.** Both remote adapters ship disabled by default (`apps/mcp-server/src/adapters.ts`), and Square defaults to its sandbox host. The mock adapter involves no third-party data, so demo mode and review are unaffected.

§8 makes Porter indemnify Meta for claims arising from Connector Content, including IP and privacy. §9 caps Meta's own liability at $1,000. The risk is asymmetric and deliberate on Meta's part.

### §4.3 Privacy and data handling

| Clause | Requirement | Status | Where |
|---|---|---|---|
| §4.3(a) | Process User Data only as needed, within authorised scopes | Done | Adapter credentials are decrypted into a single call's `AdapterContext` and never held globally. `packages/core/src/adapter.ts` |
| §4.3(b) | **Notify Meta within 48 hours** of a security incident | Done (runbook) | [`legal/incident-response.md`](../legal/incident-response.md) — clock starts at awareness, notify on partial information, addresses pre-filled. |
| §4.3(c) | Publicly accessible privacy notice | Done (draft) | [`legal/privacy-notice.md`](../legal/privacy-notice.md); publish at `/privacy` before submitting. |
| §4.3(d) | Porter is an **independent controller**, bound by Meta's DPA | Partial | Acknowledged throughout the privacy notice. **Meta's Data Protection Requirements have not yet been read** — `docs/muse-requirements.md` §8 item 3. |
| §4.3(e) | No recipient gets broader access than Porter holds | Done | Per-adapter customer-field minimisation, enforced in the type system: forwarding an undeclared field is a compile error. `packages/core/src/customer.ts`, tested in `customer.test.ts` and `multi-adapter.test.ts`. |
| §4.3(f) | Retain only as long as needed; delete on revocation or request | Done | `BookingEngine.deleteUserData` purges bookings, payments, idempotency records and the saved payment profile, then destroys the per-user encryption key so residual ciphertext is unreadable. Tested in `payments.test.ts`. |
| §4.3(g) | Keep records sufficient to demonstrate compliance | Done | Append-only audit log holding **no personal data** — pseudonymous ids, argument hashes, outcomes, and the *names* of fields disclosed downstream. It survives a deletion request intact. `packages/core/src/audit.ts`; `assertNoPersonalData` runs on every append. |

### §4.4 Prohibited practices and the annual audit

| Requirement | Status | Where |
|---|---|---|
| Cooperate with an audit, once per year or on suspected violation | Done | This document, plus `GET /v1/audit` and the audit-log schema. |

## Muse Connector Policies — prohibited practices

| Policy | Status | Where |
|---|---|---|
| **Deceive users** | Done | Two-phase confirmation shows price, frequency, cancellation terms and penalties before commitment. A Jobber booking is reported `pending`, never `confirmed`, because the business has not scheduled it yet. |
| **Compromise security** | Done | No dynamic code execution; credentials encrypted at rest; a redaction layer over every log line. |
| **Exceed declared scope** · *"Non-deterministic skill(s) must define a bounded action range"* | Done | Exactly nine tools, all declared. Declared bounds: max single transaction USD 2,000; explicit approval flagged at or above USD 200; no action outside the nine tools. `submission/connector-submission.json` → `extraNotes` |
| **Extract or reconstruct data** · *no prompt-injection vectors* | Done | All provider text is `UntrustedText` and cannot be serialised without `sanitize()`. Hostile records live in the default fixture set, so every test run exercises it. `packages/shared/src/untrusted.ts`, `packages/core/src/injection.test.ts` |
| **Circumvent restrictions** · *violating robots.txt* | Done | **Porter never scrapes.** API only, at every layer — an architectural invariant, not a preference. |
| **Infer or act on sensitive attributes** | Done | No user profiling and no recommendation model. Booking history answers `list_my_bookings` and nothing else. Medical, health, legal and financial categories are excluded from the taxonomy, with a test asserting it. `packages/core/src/taxonomy.ts` |
| **Biometric identification** | N/A | Porter processes no biometric data. |
| **High-consequence actions without explicit authorisation** | Done | Signed, single-use confirmation tokens binding the exact terms. The server re-derives the terms at commit and refuses if anything moved. No single-call path books or charges. |
| **Fail to disclose material terms before financial commitment** | Done | The envelope carries cost, `recurrence`, `cancellationPolicy` and `nonRefundable`. The policy is fetched **before** any booking exists, via `getServiceCancellationPolicy`. Tested in `engine.test.ts`. |
| **Act autonomously on professional determinations** | N/A | Porter gives no medical, legal or financial advice; those categories are out of scope. |

## Muse Connector Policies — prohibited content

Porter surfaces only beauty and home-service businesses from connected booking platforms, and generates no content of its own. Business text is sanitised and passed through as data.

| Policy | Status |
|---|---|
| Illegal activity, NCII, harassment, unlawful discrimination | N/A — no user-generated or model-generated content |
| **Practising regulated professions** | Done — medical, health, legal and financial categories excluded from the taxonomy |
| Harm, weapons, self-harm | N/A |
| **Deceive or mislead** · *fake reviews* | Done — ratings are passed through with their source or omitted. Porter never synthesises or blends a rating. |
| Real-money gambling, unlawful tools | N/A |

## 7.2 — the agent may paraphrase

Muse may reword Porter's output, and §7.2 says that is not a breach. So the displayed summary is **never** the record of what was agreed. The signed token is, and the server re-derives the terms at commit time. `packages/core/src/confirmation.ts`

## 9.4 / 10 — operational

| Clause | Status | Where |
|---|---|---|
| §9.4 Terms may change on 30 days' notice | Ops | Dated local copy in `docs/reference/`. Re-verify before submission and periodically after. Last check 2026-09-21: unchanged. |
| §10 Porter's own ToS must not bind users beyond Meta's terms | Done | [`legal/terms-of-service.md`](../legal/terms-of-service.md) deliberately omits arbitration, class-action waiver and user indemnity, with the reason stated in the document. |
| §10 Governing law: California, San Mateo County | Noted | No conflicting clause in Porter's terms. |

---

## Outstanding before submission

1. **Upstream rights clearance** (§4.2) — the only genuinely open compliance item.
2. **Read Meta's Data Protection Requirements** (§4.3(d)) at `facebook.com/legal/terms/Privacy`.
3. Fill the `REPLACE_ME` fields and publish `/privacy` and `/terms`.
4. Legal review of the three documents in `legal/`.
5. Re-verify the Terms on the day of submission (§9.4).
