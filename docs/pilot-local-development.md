# Local salon pilot

The pilot runs separately from the personal mock demo. It requires PostgreSQL, email-link accounts, customer OAuth and merchant Square OAuth. The required customer journey starts from a published Muse directory listing and uses Porter account consent; it requires no manual API key or endpoint setup. Local testing does not establish that Porter is published or that the actual Muse journey works.

## Configure

1. Start PostgreSQL with `pnpm db:up`. Use a separate local pilot database; applied migrations and encryption keys must match that database.
2. Create an ignored `.env.pilot` with mode `0600`. Copy server/storage settings from `.env.example`, choose an unused port and set `PORTER_ISSUER` to the exact origin, such as `http://localhost:8082`. Generate independent stable signing and encryption secrets.
3. Set `PORTER_PILOT_ENABLED=true`, `PORTER_DEMO_MODE=false`, `PORTER_STORAGE=postgres`, `PORTER_API_KEYS=` and `PORTER_INTERNAL_API_KEYS=false`. Leave global provider, payment and experimental public-page adapter settings empty. The onboarding importer is part of the pilot and does not use those adapter settings.
4. Set `PORTER_SQUARE_ENVIRONMENT=sandbox` and the Square sandbox application ID and secret. Register `<PORTER_ISSUER>/square/callback` in that application's sandbox OAuth settings.
5. Set `PORTER_PILOT_INVITED_EMAILS` to the comma-separated owner emails authorized to activate pilot businesses. Sign-in and draft setup alone do not grant activation.
6. Use `PORTER_EMAIL_MODE=file` and `PORTER_EMAIL_OUTBOX=.porter/mail` only for local, nonproduction sandbox development. Outbox files contain private sign-in links, are excluded from Git/Docker, and have restrictive permissions. Open the latest link in the browser where it was requested; do not copy it into chat, screenshots, issues or logs.
7. Leave `PORTER_MUSE_CONNECTOR_URL` empty until Meta provides an approved Porter directory URL. The connection page then displays publication as pending.

Run from the repository root:

```sh
pnpm build
node --env-file=.env.pilot packages/db/dist/migrate.js
node --env-file=.env.pilot apps/mcp-server/dist/index.js
```

Use the explicit file for both commands. `pnpm dev:mcp` and `pnpm db:migrate` load `.env`, which may belong to the mock demo.

## Website preview and owner activation

Open `/` and submit a public salon website. The anonymous preview is tied to that browser and expires after 24 hours. Sign in through `/signin` to claim it; sign-in preserves the pending preview. Email links require confirmation in the initiating browser within fifteen minutes. Sessions last fourteen days; sign-out revokes the current session.

The importer reads one public HTML page plus robots-policy requests and bounded redirects. It uses `PorterBot/1.0`, validates and pins public DNS destinations, respects robots disallows and fails closed when robots policy cannot be verified. Robots HTTP 404/410 means no policy was found. It does not execute website JavaScript, fetch subresources, use site cookies or submit forms. A 15-second network deadline, response/decompression limits, a separate 256 KiB HTML parsing limit and structural bounds limit the work. Complex or JavaScript-dependent sites may return a sparse preview and warnings. Prices or ranges in that preview are not authoritative booking quotes.

After claiming a draft, choose **Continue with Square** on the owner page. Square authorization is bound to the owner, browser session, business, environment and connection generation. Returned scopes and merchant identity are verified before encrypted storage. Select and confirm one supported US location, then review fresh Square services and policies. The first selected location cannot be replaced silently.

Invited owners can activate eligible fixed-price USD services with bookable staff after confirming merchant/location identity and reviewing payment and cancellation obligations. Square does not expose every card, deposit or prepayment setting, so the owner must attest that selected services have none of those obligations or cancellation/no-show fees. Missing provider policy fields remain unknown. Website descriptions and owner edits remain separate from authoritative Square booking data.

Activation enables the salon in Porter; it does not publish Porter in Muse. Pause blocks new discovery and bookings while preserving supported management of existing Porter appointments. Disconnect first pauses the business and then revokes its Square grant; existing appointments remain in Square. An uncertain revocation stays blocked for operator review and is never automatically repeated.

## Customer OAuth and Muse

`/connect` explains the directory journey and lists the signed-in customer's authorized applications, with revocation controls. Once the listing is approved, the intended flow starts from Porter in Muse, continues through Porter sign-in and consent, and returns to Muse. Client display names are self-registered and unverified; the consent screen also shows the callback origin. Merchant Square credentials never become customer credentials.

The pilot exposes customer OAuth metadata, public-client registration, authorization-code exchange with S256 PKCE, exact redirect/resource checks, and refresh/revocation endpoints. Pending authorization lasts twenty minutes, authorization codes two minutes, access tokens fifteen minutes and refresh families thirty days without sliding expiry. Consent requires the initiating browser and a live session. Access and refresh tokens are opaque and stored only as hashes. Correctly bound replay of a spent authorization code or refresh token revokes the family. Signing out of the website does not revoke an already authorized application; use its Disconnect control.

The six tools are search, availability, create, list, reschedule and cancel. Granted booking read/write scopes limit tool access. Create, reschedule and cancel require explicit confirmation and live checks. Time-only reschedules retain the original service, staff and duration. Payment is at the salon; payment, quote and provider-message tools are absent. Unsupported live fee obligations block the operation instead of charging a test gateway.

The public [Muse platform page](https://muse.ai/platform), checked on 2026-09-25, describes review before directory appearance. Current authenticated submission terms, actual Muse callbacks/client configuration and the completed Muse lifecycle remain unverified. Developers can exercise the OAuth/MCP implementation locally; that evidence does not replace an approved public listing or a test inside Muse.

For a hosted pilot, configure a public HTTPS origin and `PORTER_EMAIL_MODE=resend` with a verified sender, `PORTER_RESEND_API_KEY` and `PORTER_EMAIL_FROM`. File delivery is refused there. Keep secrets in deployment secret storage. Register each provider/client callback through its actual configuration; the merchant Square callback is not the customer Muse callback.

## Optional internal key compatibility

`PORTER_INTERNAL_API_KEYS=true` enables legacy credential endpoints/authentication only for integration testing with a loopback issuer, Square sandbox and a nonproduction process. It defaults off and startup rejects its use on a hosted or production pilot. `/connect` continues to describe the OAuth customer journey. Do not use internal keys as reviewer/customer onboarding or document them as the published Muse connection.

## Verification and rollback

```sh
TEST_DATABASE_URL=postgres://porter:porter@127.0.0.1:55432/porter pnpm test
```

Tests create/drop isolated schemas and cover browser-bound sign-in/imports, live-session consent, owner/customer isolation, code and refresh replay, expiry, revocation, migrations, merchant routing and booking protections. Their provider responses are fixtures unless a separate sandbox validation record says otherwise. No production Square calls are part of this command. See [database notes](../packages/db/README.md), [sandbox evidence](square-sandbox-validation.md) and the [submission checklist](../submission/checklist.md).

Migrations v3, v4 and v5 add identities/connections, import drafts and customer OAuth respectively. The exact migration ledger gate prevents an older application without these entries from starting against the upgraded database. A source rollback must retain migration compatibility or use a reviewed database restore. Never rewrite applied SQL or rotate encryption keys to bypass checks.

Automated retention cleanup, coordinated full-account deletion and operator reconciliation of uncertain writes remain separate work. Spent OAuth codes and refresh hashes, plus their referenced request/session rows, must remain until the family expires for replay detection. Local success does not establish production notifications or Muse publication readiness.
