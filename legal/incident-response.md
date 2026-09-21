# Security incident response runbook

**Owner:** REPLACE_ME_SECURITY_CONTACT
**Last updated:** 2026-09-21

> **The clock is 48 hours.** Muse Connector Terms §4.3(b): *"You will implement reasonable administrative, technical, and physical safeguards, promptly notify Meta within forty-eight (48) hours of any security incident involving User Data, and reasonably cooperate with investigations."*
>
> The clock starts when Porter becomes **aware** of the incident, not when the incident is understood or fixed. Notify on partial information. A late, complete notification breaches the Terms; an early, incomplete one does not.

---

## What counts as an incident involving User Data

Notify if any of these is confirmed **or reasonably suspected**:

- Unauthorised access to the database, the audit log, or backups
- Exposure of adapter credentials, the token signing secret, or Stripe keys
- User data sent to the wrong recipient — the wrong business, the wrong user's agent
- A defect that let one user read or change another user's bookings
- Compromise of a dependency with access to user data or credentials
- A provider platform telling us their breach exposed data we sent them

Not an incident for this purpose: an outage with no data exposure, a failed login, a rate limit, a single declined payment.

**If it is unclear, treat it as an incident and notify.** The cost of an unnecessary notification is an email. The cost of a missed one is a breach of §4.3(b), which is carved out of the liability cap in §9.

---

## Step 1 — Contain (immediately)

1. Rotate `PORTER_SIGNING_SECRET`. This invalidates every outstanding slot id and confirmation token, so nothing already issued can be redeemed.
2. Revoke adapter OAuth tokens for affected accounts; roll Stripe keys if payment credentials are in scope.
3. Scale the service to zero if data is actively leaking. An outage is recoverable; continued exposure is not.
4. Preserve evidence. Snapshot the database and capture logs **before** redeploying.

## Step 2 — Start the clock

Record, in writing:

- **Time of awareness** (UTC) — this is what the 48 hours runs from
- Who noticed it, and how
- What is known, and what is still unknown

## Step 3 — Notify Meta, within 48 hours of awareness

Send to **`Legal-Notices@meta.com`**, with a copy to:

> Meta Legal
> 1 Meta Way
> Menlo Park, CA 94025, US

Per Muse Connector Terms §10 (Notices).

**Template:**

```
Subject: Security incident notification — Porter connector — <YYYY-MM-DD>

Connector: Porter
Developer: <legal entity>
Contact: <name, email, phone>

Time of awareness (UTC): <timestamp>
Incident window (UTC):   <start> to <end, or "ongoing">

What happened:
<plain description of the facts known so far>

User Data involved:
<categories, e.g. names, contact details, service addresses, booking records.
 State "under investigation" where not yet established. Do not guess.>

Users affected: <count, or "under investigation">

Containment taken so far:
<actions and timestamps>

Outstanding unknowns:
<what is still being established>

Next update: <date/time>
```

Send it even if most fields read "under investigation". Then keep sending updates.

## Step 4 — Notify users and regulators

Porter is an **independent controller** (§4.3(d)), so statutory breach-notification duties fall on Porter directly and are not discharged by telling Meta.

- Assess GDPR Article 33 (72 hours to the supervisory authority) and Article 34 (to data subjects) where EU or UK users are affected.
- Assess US state breach-notification laws for affected residents.
- Notify affected users in plain language: what happened, what data, what we have done, what they should do.

Legal review before any user-facing notice.

## Step 5 — Cooperate

§4.3(b) requires reasonable cooperation with investigations, and §4.4 gives Meta an audit right on a material suspected violation. Keep the evidence, the timeline and the decision log intact and available.

## Step 6 — Write it up

Within 10 working days: a blameless post-mortem covering timeline, root cause, why it was not caught earlier, and the specific changes made. Add a regression test for the defect. File the write-up with the compliance records §4.3(g) requires.

---

## Contacts

| Role | Who |
|---|---|
| Incident lead | REPLACE_ME |
| Legal | REPLACE_ME |
| Meta notices | `Legal-Notices@meta.com` + Meta Legal, 1 Meta Way, Menlo Park, CA 94025, US |
| Stripe support | via the Stripe dashboard |

## Rehearse it

Run a tabletop exercise twice a year. An untested runbook is a document, not a plan.
