# Muse submission packet

Everything needed to fill the form at <https://muse.ai/platform>.

## Files

| File | What it is |
|---|---|
| `connector-submission.json` | Every form field, keyed exactly to the form's own payload |
| `validate.ts` | Muse's own client-side rules, so the form should not reject anything |
| `assets/porter-icon-512.png` | 512×512, 11 KiB — within the 256 KiB cap |
| `assets/porter-icon-512.svg` | SVG twin, also accepted |
| `checklist.md` | Step-by-step, with the blockers called out |

## Before you paste anything

```bash
pnpm submission:validate
```

It applies the real rules: required fields, the 80 and 120 character limits,
HTTPS on the endpoint, email-or-URL on support, and the icon's byte-level
512×512 and 256 KiB checks. It also refuses to pass while any `REPLACE_ME`
placeholder remains.

Those placeholders are deliberate. Terms §2.1 requires the submission to be
true and accurate, so nothing that only you can know — your legal entity,
domain and contact address — has been guessed on your behalf.

## What you still have to do yourself

The three attestations are yours to make, on the form:

- *"I confirm I'm authorized to submit this connector and its brand assets."*
- *"I agree to the Muse Connector Terms."*
- *"I understand that submission doesn't guarantee approval and promotion is based on usage and editorial discretion."*

Read [`../docs/muse-compliance.md`](../docs/muse-compliance.md) before ticking
the first one. The open rights question under §4.2 is directly relevant to it.
