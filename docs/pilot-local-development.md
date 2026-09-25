# Local salon pilot

The pilot runs separately from the personal mock demo. It requires PostgreSQL, email-link accounts and merchant OAuth; it does not accept the demo's static API key or global Square access token.

## Configure

1. Start PostgreSQL with `pnpm db:up`. Use a separate local database for pilot development; migrations and encryption keys must match that database.
2. Create an ignored `.env.pilot` with file mode `0600`. Copy the server/storage settings from `.env.example`, choose an unused port, and set `PORTER_ISSUER` to that exact origin (for example `http://localhost:8082`). Generate independent stable signing and encryption secrets.
3. Set `PORTER_PILOT_ENABLED=true`, `PORTER_DEMO_MODE=false`, `PORTER_STORAGE=postgres`, and `PORTER_API_KEYS=`. Leave global provider, payment and experimental public-page adapter settings empty.
4. Set `PORTER_SQUARE_ENVIRONMENT=sandbox` and the Square sandbox application ID and application secret. Register `http://localhost:8082/square/callback` in that application's sandbox OAuth settings, substituting your actual origin.
5. Use `PORTER_EMAIL_MODE=file` and `PORTER_EMAIL_OUTBOX=.porter/mail`. This mode is accepted only for local, nonproduction sandbox development. Files contain private sign-in links; they are excluded from Git and Docker and created with restrictive permissions. Open the latest link in the browser where it was requested. Do not post links in chat, screenshots, issue reports or logs.

Run these commands from the repository root:

```sh
pnpm build
node --env-file=.env.pilot packages/db/dist/migrate.js
node --env-file=.env.pilot apps/mcp-server/dist/index.js
```

Use the explicit environment file on both commands. `pnpm dev:mcp` and `pnpm db:migrate` load the existing `.env`, which may belong to the mock demo.

## Accounts and Square

Open `/signin`. Request a link and confirm it in the same browser within fifteen minutes. Opening a link does not consume it until the confirmation button submits. Sessions last fourteen days and sign-out revokes the current session.

The owner connection page uses **Continue with Square**. Square states are single-use and bound to the signed-in owner, browser session, business, environment and connection generation. The returned grant is verified against the required scopes and merchant before encrypted persistence. Refresh uses the saved refresh token and validates the replacement before updating it.

Disconnect pauses the business before revoking its Square grant. If the remote outcome or final database write is uncertain, the connection remains blocked for review. Porter never automatically repeats a whole-grant revocation: a delayed second request could invalidate a newer authorization. Existing appointments remain in Square.

This account/connection increment is a foundation. Website import, activation, merchant routing, operator recovery and the complete Muse journey have separate implementation and validation gates; account tests do not establish launch readiness.

## Customer connector access

Open `/connect` after signing in. Create a named API key and copy it once. Only its hash is persisted. Each customer has their own credential and appointment ownership; merchant Square credentials never leave Porter.

The pilot exposes search, availability, create, list, reschedule and cancel. It disables the development OAuth flow, quotes, payments and provider messaging. All booking mutations require explicit confirmation. `/docs` describes the pilot's actual connector surface.

Muse needs a public HTTPS endpoint. Local HTTP tests validate MCP behavior but do not prove an actual Muse integration. For a hosted pilot, configure HTTPS and `PORTER_EMAIL_MODE=resend` with a verified sender, `PORTER_RESEND_API_KEY` and `PORTER_EMAIL_FROM`; file delivery is refused there. Keep secrets in the hosting secret store.

## Verification and rollback

```sh
TEST_DATABASE_URL=postgres://porter:porter@127.0.0.1:55432/porter pnpm test
```

Database tests create and drop isolated schemas. They cover browser-bound links, replay and CSRF defenses, customer key persistence/revocation, owner isolation, OAuth grant races and refresh/disconnect handling. No production Square calls are part of these tests.

Migration v3 adds identities and connections. Older application versions that lack that migration's ledger entry refuse startup after it is applied. A source rollback must retain migration compatibility or use a reviewed database restore. Do not rewrite applied migration SQL or rotate encryption keys to bypass startup checks.
