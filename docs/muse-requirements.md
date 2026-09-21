# Muse Connector Platform — Requirements Research

**Project:** Porter — unified service-booking connector for AI agents
**Researched:** 2026-09-21 · **Updated:** 2026-09-21 with the Muse Connector Terms
**Status of the platform:** Opened to developers on 2026-09-18. Three days old at time of research.

> **How to read this doc.** Every claim is tagged with a confidence level.
> - **[CONFIRMED]** — taken from a Meta-owned primary source (muse.ai, meta.com help centre, or Muse's own shipped JavaScript).
> - **[REPORTED]** — from press or third-party write-ups. Plausible, not verified against a Meta source.
> - **[OPEN]** — not documented anywhere public. Listed in §8.
>
> Nothing here is guessed. Where the platform is silent, the doc says so.

---

## 1. What Muse is

**[CONFIRMED]** Muse is Meta's personal AI agent. It runs on the web, iOS, Android, macOS and inside WhatsApp. Each user gets "a persistent, isolated Linux computer with a shared browser" — Meta calls it the Muse Secure VM. The agent plans tasks, drives a browser, and calls connectors.

**[CONFIRMED]** The connector platform lives at `https://muse.ai/platform`. The page is branded "Muse Connector Platform" and the footer reads "© 2026 Meta".

**Consequence for Porter:** the agent runs in Meta's cloud, not on the user's machine. A connector must be a publicly reachable hosted service. Localhost and private networks are unreachable.

---

## 2. Technical integration format

### 2.1 Two accepted connection types

**[CONFIRMED]** The submission form offers exactly two options, as a segmented toggle:

| Form value | Label shown to developer | Endpoint field label |
|---|---|---|
| `MCP` | **Existing MCP** | "Hosted MCP endpoint" |
| `API` | **Raw API** | "API URL" |

Source: Muse's own form bundle, `https://muse.ai/_next/static/chunks/2n03-v9y3gxdz.js` (the lazily-loaded `PlatformSubmissionForm`, module 688211).

**This is the single most important finding: MCP is a first-class, officially accepted integration format.** Porter does not need to invent a Meta-specific protocol. A remote MCP server satisfies the platform directly.

### 2.2 Endpoint constraints

**[CONFIRMED]** From the form's client-side validator:
- The endpoint **must be HTTPS**. Plain `http:` is rejected (`invalidHttpsUrl`).
- If connection type is `API`, an extra **OpenAPI specification** URL field appears (placeholder `https://api.yourproduct.com/openapi.json`). It accepts `http:` or `https:`. It is *not* in the required-field list, so it is optional even for Raw API.
- A separate **API or MCP documentation** URL (`documentationUrl`) is **required** for both connection types.

### 2.3 Transport

**[REPORTED]** Third-party accounts state that Muse connects to remote MCP servers over **Streamable HTTP**, and that when handed an MCP server it builds a client with the official MCP SDK, calls `tools/list`, then exercises each tool end to end.

**[OPEN]** Meta publishes no MCP specification version, no transport requirement, and no statement on SSE vs Streamable HTTP. Streamable HTTP is the current MCP standard and is what Claude and ChatGPT require, so it is the safe target — but this is inference, not documentation.

### 2.4 No SDK

**[CONFIRMED]** The platform page links only to: the submit form, the Muse consumer app, the privacy policy, the cookie policy, and the Muse Connector Terms. There is no documentation link, no SDK, no API reference, and no developer portal.

---

## 3. Auth model

### 3.1 What the form accepts

**[CONFIRMED]** The form has a multi-select `authMethods` field with exactly three choices:

```
["API keys", "OAuth with PKCE", "Other"]
```

Choosing "Other" reveals a free-text field, `authOther` ("Describe the authentication method"), which becomes required.

**OAuth with PKCE is explicitly named and supported.** This matches MCP's own OAuth 2.1 authorization model, so Porter's planned OAuth 2.1 flow is aligned with the platform.

**[CONFIRMED]** `authMethods` is **not** in the required-field list. A connector can be submitted without declaring an auth method — consistent with connectors that need no user auth.

### 3.2 How credentials are handled at runtime

**[CONFIRMED]** From Meta's help centre:
- Credentials go into a **Secure Credentials Store** that "the AI model cannot directly access".
- Muse "performs verification checks before using stored credentials to confirm the service is legitimate and you authorized the action".
- For directory connectors the user is sent through an authorisation step: "Tap Continue to authorize the connection. Follow any additional login or authorization steps." The user can disconnect at any time.
- Data minimisation is a stated principle: Muse exchanges "only the data that's needed" with a connector.

**[REPORTED]** A daemon outside the agent runtime holds the real secret and swaps a surrogate token for the real one at the network boundary, so the agent never holds the credential. Meta's help centre describes the same shape in looser words; the "surrogate token" mechanism itself is third-party reporting.

### 3.3 Consequence for Porter

Porter's OAuth 2.1 + PKCE design is directly supported. Because Meta publishes no conformance profile, build to the **MCP authorization spec** (RFC 9728 protected-resource metadata on a 401, RFC 8414 AS metadata, PKCE S256, dynamic client registration). That is what Claude and ChatGPT require, and it is a strict superset of "OAuth with PKCE". It maximises the chance Muse's client works without changes.

---

## 4. Review requirements

### 4.1 The published funnel

**[CONFIRMED]** Three steps, quoted verbatim from `muse.ai/platform`:

1. **Describe your product** — "Tell us what your connector does and how users will use it."
2. **Submit for review** — "We'll review your connector for functional, security, and legal requirements, and complete end to end testing."
3. **Appear in the directory** — "Once approved, users will be able to find your connector in Muse. Editors will review connectors for featured placement."

"Complete end to end testing" means **Meta will actually call Porter's tools**. A demo/sandbox mode that a reviewer can exercise without a real salon account is therefore a hard requirement, not a nicety.

### 4.2 The three mandatory attestations

**[CONFIRMED]** The form will not submit unless all three checkboxes are ticked:

| Field | Text |
|---|---|
| `authorized` | "I confirm I'm authorized to submit this connector and its brand assets." |
| `termsAccepted` | "I agree to the **Muse Connector Terms**." (links to `/platform/terms`) |
| `distributionUnderstood` | "I understand that submission doesn't guarantee approval and promotion is based on usage and editorial discretion." |

The `authorized` attestation is the one that matters most for Porter — see §6.

### 4.3 Complete submission form specification

**[CONFIRMED]** Recovered from the shipped form bundle. The server action is `createConnectorSubmissionAction`. The form has 4 steps: Overview → Technical specs → Review → Completed.

**Required fields** (validator constant `C`):

| Field | Label | Constraint |
|---|---|---|
| `productName` | Connector name | ≤ **80** characters |
| `companyName` | Company or developer | ≤ **120** characters |
| `website` | Product website | valid http/https URL |
| `useCases` | Example prompts | textarea, ≤10000 chars. Placeholder: *"What might someone ask Muse to do? e.g. 'Add a morning run to my training plan,' 'Dim the lights in the dining room'"* |
| `payments` | Payments | enum: `accepts_payments` \| `does_not_accept_payments` |
| `contactName` | Full name | — |
| `contactEmail` | Work email | must match `\S+@\S+\.\S+`; caption says "Use your company email address." |
| `support` | Support email or URL | email **or** http/https URL |
| `privacyUrl` | Your privacy policy | valid http/https URL |
| `productTerms` | Your terms of service | valid http/https URL |
| `connectionType` | Connection type | `API` \| `MCP` |
| `endpoint` | API URL / Hosted MCP endpoint | **HTTPS only** |
| `documentationUrl` | API or MCP documentation | valid http/https URL |
| `limits` | Access requirements | free text. Caption: "List any account, plan, regional, rate or usage requirements" / "Include anything that affects who can use the connector or what it can do." |
| `brandFiles` | Connector icon | see icon rules below |

**Optional fields:** `openapi` (OpenAPI specification URL, shown only for `API`), `authMethods`, `authOther`, `extraNotes` ("Anything else? (optional)" — "Add any other details you want to share.").

**Connector icon rules** (enforced byte-level in the browser):
- PNG or SVG only (`image/png`, `image/svg+xml`).
- **Exactly 512×512.** PNG dimensions are read from the IHDR chunk. SVG must declare 512×512 width/height or viewBox.
- **≤ 256 KiB** (262144 bytes).
- Must be non-empty, and the file contents must match the extension.

**Other:** the form requires a logged-in Muse account. It is rate-limited ("You've submitted too many requests. Try again later.").

---

## 5. Directory connectors vs custom connectors

**[CONFIRMED]** Meta's help centre describes two distinct classes:

| | **Directory connector** | **Custom connector** |
|---|---|---|
| Who builds it | The developer submits it | Muse builds it for one user, on request |
| Review | Meta reviews functional, security, legal + E2E test | **"Meta doesn't review custom connectors or how they use your information."** |
| Discovery | Listed in the Muse connector directory | Private to that user |
| How it is added | Submission form + approval | User gives Muse an MCP URL or API docs; Muse writes and tests the client itself, then saves it as a skill |

**[CONFIRMED]** Meta warns users to "grant access with caution and review the provider's privacy policies" for custom connectors.

**This gives Porter a day-one distribution path that does not wait on Meta's approval queue.** The moment Porter's MCP endpoint is live and public, any Muse user can point Muse at it as a custom connector. Directory listing is the growth channel; the custom-connector path is the beta channel.

**[REPORTED]** The custom-connector credential flow is built around API keys and headers, so an OAuth-only server "adds friction" there. **Mitigation:** Porter should support a static API key / bearer token as a secondary auth mode alongside OAuth, purely so the custom-connector path stays smooth. This costs little and removes a real adoption barrier.

---

## 6. Are aggregator / multi-business connectors allowed?

**[CONFIRMED] — RESOLVED. Yes, conditionally.** The Muse Connector Terms were obtained on 2026-09-21 and are stored at [`reference/muse-connector-terms-2026-09-18.md`](./reference/muse-connector-terms-2026-09-18.md).

**Nothing in the Terms or the Muse Connector Policies prohibits aggregators, marketplaces or intermediaries.** There is no clause requiring a Developer to own, operate or be affiliated with the businesses its Connector surfaces. The Prohibited Practices and Prohibited Content lists do not mention aggregation.

The condition is §4.2, **Rights and Permissions**, which is the clause that governs Porter's model:

> "You represent that you have all rights necessary for your Connector, Connector Content, and Developer-provided Connector Interfaces to be made available to and through Muse and Users, and that Meta's exercise of the rights granted under these Terms will not violate any third-party rights, terms, or privacy commitments."

Read together with §3.1, the license Porter grants Meta, this is a demanding representation. "Connector Content" is defined to include **any** data returned through the interface — so business names, descriptions, service lists, prices and availability all count. And the §3.1 license Porter grants over that content is worldwide, royalty-free, **transferable, sublicensable**, and covers reproducing, modifying, distributing and displaying it, plus using it to personalise User experiences and improve Muse.

**So Porter must be able to sublicense third-party business data to Meta on those terms.** Porter does not own that data. The rights must flow through Square's and Jobber's API terms, or through direct agreements with businesses.

**This converts the aggregator question from a platform-permission question into a rights-clearance question.** The platform allows it. Whether Porter can lawfully make that representation depends on the upstream API terms, which is a new open question (§8 item 1) and a legal workstream, not an engineering one.

Two clauses sharpen the stakes:

- **§8 Indemnification.** Porter defends and indemnifies Meta against third-party claims arising from Connector Content, *explicitly including intellectual property infringement and privacy violations*. Every business record Porter surfaces is Porter's liability.
- **§9 Limitation of Liability.** Meta's aggregate liability is capped at **$1,000 USD**. The risk is asymmetric by design.

Two further points that favour Porter:

- **§2.1** requires that submission information be "true and accurate" and forbids misrepresenting or obscuring the Connector's functionality. Porter should describe itself plainly as a multi-business aggregator in the submission. That is both the honest path and the protection against the "exceed declared scope" policy rule.
- **§2.2** confirms Meta may remove any Connector "at any time for any reason". Approval is never permanent. The custom-connector path (§5) remains the fallback.

---

## 6A. Binding obligations from the Connector Terms

**[CONFIRMED]** These are the clauses that change how Porter is built. Full text in [`reference/muse-connector-terms-2026-09-18.md`](./reference/muse-connector-terms-2026-09-18.md).

### 6A.1 Accuracy is contractual, not just good practice

**§4.1** requires "commercially reasonable measures to ensure it generates accurate and up-to-date Connector Content", and to "promptly fix material defects, broken endpoints, and **stale data**, and maintain commercially reasonable uptime and support contact information."

The brief's "never return stale availability as bookable" rule is now a contract term. The slot TTL plus mandatory re-check at booking time satisfies it. Uptime monitoring and a live support contact become deliverables.

### 6A.2 Porter is an independent controller, not a processor

**§4.3(d):** "You and Meta are each acting as an **independent controller** of User Data (including Personal Data)". Porter must comply with Meta's Data Protection Requirements, incorporated by reference from `facebook.com/legal/terms/Privacy`.

Independent controller status means Porter carries its own GDPR/CCPA obligations directly: its own lawful basis, its own privacy notice (**§4.3(c)** requires a publicly accessible one), and its own handling of data-subject requests. Porter cannot rely on Meta's compliance posture.

### 6A.3 Downstream disclosure is capped

**§4.3(e):** "You may disclose User Data to another recipient only where necessary to fulfill the User's request. **No recipient may receive broader access, purpose, or retention rights than you hold.**"

This is the clause with the most direct effect on Porter's architecture. Porter forwards customer details to Square, Jobber and ultimately the business. That is permitted — it is necessary to fulfil the booking. But Porter may not hand over more than the specific booking requires, and may not give a downstream recipient broader rights than Porter itself holds.

**Design consequence:** there is no blanket "customer object" passed to adapters. Each adapter declares the minimum customer fields it needs, and core forwards only those. See `plan.md` §5.8.

### 6A.4 Retention is bounded by the request

**§4.3(f):** retain User Data "only as long as necessary to fulfill the User's request", and delete or render it inaccessible on the earlier of the User's revocation or deletion request, or when the data is no longer necessary.

This sits in tension with **§4.3(g)**, which requires "records sufficient to demonstrate compliance" available to Meta on request, and with the brief's audit-log requirement. The resolution is that the audit log must contain **no personal data** — pseudonymous actor ids, argument hashes, outcomes and timings only. Then compliance records survive a deletion request without breaching it. See `plan.md` §5.6 and §5.9.

### 6A.5 A 48-hour incident clock

**§4.3(b):** notify Meta "within forty-eight (48) hours of any security incident involving User Data", and cooperate with investigations. Notices go to `Legal-Notices@meta.com`, with a copy to Meta Legal, 1 Meta Way, Menlo Park, CA 94025 (§10 Notices).

This needs a written incident-response runbook with the 48-hour clock and those addresses in it, before launch.

### 6A.6 Annual audit right

**§4.4:** Meta may audit compliance once per calendar year, or more often on material suspected violation, "including by providing reasonable access to your systems and records". Porter needs an audit-ready posture: documented data flows, a written retention policy, and access logs.

### 6A.7 Policy rules that constrain the product

From the Muse Connector Policies:

| Policy rule | Effect on Porter |
|---|---|
| **Exceed declared scope** — "performing undisclosed functions, accessing undeclared endpoints... Non-deterministic skill(s) must define a bounded action range." | The nine tools are the whole surface. No hidden tools, no undeclared endpoints. Porter must declare an explicit bounded action range — including a maximum transaction value. |
| **Extract or reconstruct data** — "building exfiltration or **prompt-injection vectors**" | Passing provider-supplied text through unsanitised could itself be a policy violation. The `UntrustedText` design is now compliance, not only security. |
| **Circumvent restrictions** — "violating robots.txt" | **Porter never scrapes. API-only, always.** This becomes a hard architectural invariant, closing off any future "just scrape the salon's site" shortcut. |
| **Infer or act on sensitive attributes** — health, religion, sexual orientation, race and others, "unless the attribute was explicitly stated by the data subject or expressly provided by the User" | Service bookings leak sensitive inferences. A medical spa, a physiotherapist, an addiction clinic, a faith-linked service. Annex I confirms transferred data "may include special categories of data (for example... data concerning health)". **Porter must not profile users or build recommendations from booking history.** |
| **Execute high-consequence actions without explicit user authorization** — "financial transactions above material thresholds... without the User having directly and unambiguously authorized **the specific action**" | The confirmation envelope plus single-use token binds the exact action. Add a configurable material threshold above which confirmation is re-required. |
| **Fail to disclose material terms before financial commitment** — "without clear notice of **cost, frequency, cancellation terms, and penalties**" | The confirmation envelope must carry all four. Adds `recurrence` and `nonRefundable` to the envelope type. See `plan.md` §5.1. |
| **Practice regulated professions without authorization** — medical/health, legal, financial advice | Keep the v1 taxonomy to beauty and home services. Exclude medical, legal and financial service categories. |
| **Deceive or mislead** — "facilitating false engagement (e.g., fake reviews)" | If Porter surfaces ratings, they must be genuine and attributed to their source. Never synthesise or blend ratings. |

### 6A.8 The agent may paraphrase Porter's output

**§7.2:** Meta will use commercially reasonable efforts to "CONVEY CONNECTOR CONTENT AS RECEIVED THROUGH THE CONNECTOR", but "AI SYSTEMS ARE NON-DETERMINISTIC" and "INCIDENTAL DEVIATIONS WILL NOT CONSTITUTE A BREACH".

**Porter cannot assume its confirmation summary reaches the user verbatim.** The design must survive paraphrase: keep summaries short and structured, make the critical numbers unmissable, and — most importantly — never trust the displayed text as the record of what was agreed. The signed confirmation token is the authority, and the server re-verifies terms at commit time. The existing two-phase design already handles this; it is now justified by the contract as well as by good sense.

### 6A.9 Porter's own terms of service are partly void in this channel

**§10, Entire Agreement:** "Any clickwrap, shrinkwrap, online, or other terms accompanying or relating to your Connector that impose obligations on Meta or Users beyond these Terms are void unless Meta expressly agrees in a separate written agreement."

Porter must publish a terms-of-service URL (it is a required submission field), but must not rely on it to impose obligations on Muse users beyond Meta's terms. Draft it accordingly.

### 6A.10 Other operational facts

- **§9.4** Meta may modify the Terms at any time, with at least 30 days' notice only for material adverse changes. **Re-verify before submission and periodically after.**
- **§10** Governing law is California; venue is San Mateo County or N.D. Cal.
- **§10** Porter may not assign the Terms without Meta's written consent. Meta may assign freely.
- **§6.1** Either party may terminate on 30 days' notice. Meta may suspend immediately on suspected violation.
- **§2.1** Meta "may re-review any Connector at any time", and **§4.5** may impose additional certifications or assessments as a condition of continued access.

---

## 7. Stripe Link payments

**[CONFIRMED]** `muse.ai/platform` says: Meta has "partnered with Stripe to make accepting payments easy with Link." The submission form makes developers declare `accepts_payments` or `does_not_accept_payments`. That is the entirety of Meta's published developer-facing payment documentation.

**[CONFIRMED]** From Muse's consumer page: "When shopping, a one-time card number is generated at checkout so your real card stays hidden from the merchant and your agent." Eligible purchases carry Link's purchase protections.

**[REPORTED]** From Stripe's newsroom and payments press:
- At the 1M+ businesses that already accept Link, Muse checks out using the consumer's saved Link payment method.
- For businesses that do not accept Link, **Link issues Muse a single-use virtual card scoped to the approved purchase**.
- "For every purchase, consumers are asked to approve the transaction total directly in the chat interface, and Muse never sees their underlying payment details."

**[OPEN]** No published answer on: whether a connector charges through its *own* Stripe account or through a Muse-mediated Link checkout; whether there is a connector-specific payments API; fees; revenue share; payout terms; whether the Agentic Commerce Protocol (ACP) or shared payment tokens are involved. Stripe's press release is a partnership announcement, not developer documentation.

**[CONFIRMED]** The Connector Terms are **silent on payments**. There is no revenue-share clause, no fee schedule and no payments API. The only binding payment-related rules are in the Policies: disclose cost, frequency, cancellation terms and penalties before any financial commitment, and never execute a transaction above a material threshold without the user authorising that specific action.

**Consequence for Porter:** the safe design is Porter charging through **its own Stripe account** (Stripe Connect, with the service business as the connected account), and treating "Link as the funding instrument" as an optimisation to revisit once Meta documents it. The confirm-the-total-in-chat behaviour Muse already enforces aligns exactly with Porter's human-confirmation requirement.

---

## 8. Open questions

Ranked by how much they can change Porter's design. Items 1, 2 and 6 of the previous version are now resolved by §6 and §6A.

| # | Question | Impact | How to resolve |
|---|---|---|---|
| 1 | **Do Square's and Jobber's API terms permit redistributing business data to Meta under the §3.1 license — transferable, sublicensable, usable to improve Muse?** | **High** — §4.2 requires Porter to represent that they do. This is now the top risk. | Read the Square Developer ToS and Jobber Developer ToS. Legal review before milestone 3. |
| 2 | Does the connector charge via its own Stripe account, or via Muse/Link? Fees? Revenue share? | **High** — changes the whole payment design | Ask Meta via the submission contact. Still no public source; the Terms are silent on payments. |
| 3 | What are Meta's Data Protection Requirements (the DPA at `facebook.com/legal/terms/Privacy`), incorporated by reference in §4.3(d)? | **Medium-High** — binding on Porter as independent controller | Read that document. Not yet reviewed. |
| 4 | Which MCP spec version and transport does Muse's client implement? Does it honour RFC 9728 / RFC 8414 / DCR? | **Medium** — determines whether OAuth works unmodified | Test against a live endpoint once deployed |
| 5 | Tool count limit, tool-description length limit, request timeout, rate limits | **Medium** — constrains the tool surface | Undocumented. Measure empirically. |
| 6 | Does Muse pass any end-user identity to the connector? | **Medium** — affects `list_my_bookings` and account linking | Test empirically |
| 7 | What counts as a "material threshold" for financial transactions under the Policies? | **Medium** — sets the extra-confirmation trigger | Undefined by Meta. Pick a conservative default and document it. |
| 8 | Does Muse render structured confirmation UI, or only text? | **Medium** — §7.2 says paraphrase is not a breach, so design must not depend on it | Test empirically |
| 9 | Review SLA and rejection/appeal process | Low | Not in the Terms. Ask Meta. |
| 10 | Is there a sandbox or test mode for reviewers? | Low | Assume not. Ship a demo mode. |
| 11 | Category taxonomy for the directory | Low | Not in the form or the Terms. Likely assigned by Meta editors. |

---

## 9. What this means for Porter's architecture

1. **Build a standards-compliant remote MCP server over Streamable HTTPS.** It satisfies Muse's "Existing MCP" option directly, and the same server serves Claude and ChatGPT. No Meta-specific protocol exists to build against.
2. **`apps/muse-adapter` is not needed.** The brief said to build it "only if Muse needs something beyond standard MCP". Research says it does not. Replace it with a `submission/` package holding the form values, the 512×512 icon, and the checklist.
3. **Add a thin REST + OpenAPI 3.1 facade over the same core.** Cheap insurance: it covers the "Raw API" connection type, and it makes the custom-connector path work well. A serialisation layer, not a second implementation.
4. **Support a bearer/API-key auth mode alongside OAuth 2.1.** The custom-connector credential flow favours keys.
5. **Ship a demo mode backed by the mock adapter.** Meta runs end-to-end tests (§2.1 review, and the platform page's "complete end to end testing"). A reviewer must complete a full booking lifecycle without a real Square or Jobber account.
6. **Porter must publish a privacy notice and a terms-of-service page.** Both are required submission fields, and §4.3(c) makes the privacy notice a contract term. The ToS must not impose obligations on users beyond Meta's terms (§10).
7. **Treat all provider text as untrusted.** Building "prompt-injection vectors" is an explicit policy violation, so the `UntrustedText` design is compliance as well as security.
8. **Human confirmation is required by policy**, not only by the brief: no high-consequence action without the user "directly and unambiguously" authorising "the specific action", and no financial commitment without notice of cost, frequency, cancellation terms and penalties.
9. **Minimise what goes downstream.** §4.3(e) caps what Porter may disclose to Square, Jobber and businesses. Per-adapter field minimisation, enforced in types.
10. **Keep personal data out of the audit log.** It is the only way to satisfy the §4.3(f) deletion duty and the §4.3(g) records duty at once.
11. **Never scrape. API-only, always.** Violating robots.txt is an explicit policy breach.
12. **No user profiling.** Booking history is used to answer `list_my_bookings`, never to infer or act on sensitive attributes.

---

## 10. Sources

**Primary (Meta-owned):**
- [Muse Connector Platform](https://muse.ai/platform) — the platform page
- **Muse Connector Terms**, last updated 2026-09-18 — obtained 2026-09-21, stored at [`reference/muse-connector-terms-2026-09-18.md`](./reference/muse-connector-terms-2026-09-18.md). The live page at `muse.ai/platform/terms` requires a Muse login; unauthenticated fetches return the consumer landing page.
- `https://muse.ai/_next/static/chunks/2n03-v9y3gxdz.js` — the shipped `PlatformSubmissionForm` bundle; source of the complete field, validation and icon spec in §4.3
- [How Muse works with Connectors — Meta Help Center](https://www.meta.com/help/artificial-intelligence/1687253048996149/)
- [How Muse handles your privacy, safety and security — Meta Help Center](https://www.meta.com/help/artificial-intelligence/1047255454427887/)
- [Muse consumer site](https://muse.ai/)
- Meta Data Protection Requirements — `https://www.facebook.com/legal/terms/Privacy`, incorporated by reference by §4.3(d). **Not yet reviewed** (open question 3).

**Secondary (press and third-party, tagged [REPORTED] above):**
- [Stripe helps Muse, Meta's new personal AI agent, shop across the internet with Link](https://stripe.com/newsroom/news/stripe-helps-meta-muse-shop-with-link)
- [Parallel: Muse custom integrations](https://parallel.ai/articles/meta-muse-custom-integrations)
- [Parallel: Best MCP servers for Meta Muse](https://parallel.ai/articles/best-mcp-servers-for-meta-muse)
- [CellCog: Muse Connector Platform](https://cellcog.ai/blog/muse-connector-platform/)
- [RuntimeWire: Meta opens Muse connectors](https://runtimewire.com/article/meta-opens-muse-connectors-developers)
- [Payments Dive: Stripe's wallet embraces AI bots](https://www.paymentsdive.com/news/stripes-digital-wallet-paypal-embraces-ai-bots-agentic-commerce/830753/)
- [GeekWire: Amazon blocks Meta's Muse AI assistant](https://www.geekwire.com/2026/amazon-blocks-metas-muse-ai-assistant-in-new-standoff-over-agentic-shopping/)
