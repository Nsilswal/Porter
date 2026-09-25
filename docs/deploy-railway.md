# Deploy the salon pilot to Railway

Porter's website and MCP endpoint run in the **same Node service**. It renders
onboarding, sign-in, owner and connection pages and serves `/mcp`. Deploy the
repository once, with a separate PostgreSQL service. No separate frontend host
or static-site build is needed.

This recipe creates a **Square sandbox web pilot**. Publishing Porter in Muse is
separate: customers will choose **Connect → Porter sign-in and consent → return
to Muse**, with OAuth credentials exchanged automatically and no API key entry.

## 1. Configure the application and database

Create a separate Railway environment or project for the pilot, with a fresh
PostgreSQL service and an application service connected to `Nsilswal/Porter`,
branch `main`. Use separate secrets from the personal demo.
[Railway PostgreSQL setup](https://docs.railway.com/databases/postgresql).

Set these application service settings explicitly:

| Setting | Value |
|---|---|
| Root Directory | `/` (repository root) |
| Builder / Dockerfile Path | Dockerfile / `Dockerfile` |
| Custom Build Command | Empty; the Dockerfile builds the workspace |
| Start Command | `node apps/mcp-server/dist/index.js` |
| Pre-Deploy Command | `node packages/db/dist/migrate.js` |
| Pre-Deploy Timeout | `300` seconds |
| Healthcheck Path / Timeout | `/readyz` / `30` seconds |
| Restart Policy | On Failure, maximum 5 retries |
| Replicas | One, in one region |

Railway's automatic monorepo import may select package-specific commands and
watch only `/apps/mcp-server/**`. Replace those settings because shared packages
also affect this app. Leave Watch Paths empty to build every change, or include:

```text
/apps/**
/packages/**
/package.json
/pnpm-lock.yaml
/pnpm-workspace.yaml
/tsconfig*.json
/Dockerfile
/.dockerignore
/railway.json
```

The existing `railway.json` contains Docker build and health/restart defaults;
it does not configure migrations, variables, databases or domains. If this
service uses legacy Config as Code, its file path is `/railway.json`, not
`/apps/mcp-server/railway.json`. Check the resolved settings on the deployment
before relying on that file. The settings above can be entered directly without
adding a new config file. [Railway monorepo settings](https://docs.railway.com/deployments/monorepo),
[build settings](https://docs.railway.com/builds/build-configuration).

The migration pre-deploy step runs with service variables and private database
access. A failure prevents deployment. [Pre-deploy commands](https://docs.railway.com/deployments/pre-deploy-command).

## 2. Get the URL and register the Square callback

Open the application service's **Settings → Networking → Public Networking →
Generate Domain**, targeting port `8080`. Railway provides HTTPS; no purchased
domain is needed for the website test.
[Railway public networking](https://docs.railway.com/networking/public-networking).

Set `PORTER_ISSUER` to that exact origin, such as
`https://<pilot-service>.up.railway.app`, with no path or query. In the Porter
Square application's **Sandbox OAuth** settings, add:

```text
https://<pilot-service>.up.railway.app/square/callback
```

Retain the local callback if needed. The hosted pilot requires a new **Continue
with Square** authorization; local sessions and database records are not copied.
The Square merchant callback is separate from Muse's customer callback.

## 3. Configure sign-in email

Hosted sign-in requires Resend. File email delivery is limited to local sandbox
development and is rejected by the production Docker image.

- **Personal web test:** use a Resend account/API key and
  `PORTER_EMAIL_FROM=onboarding@resend.dev`. Sign in with the email associated
  with that Resend account; the test sender can deliver only to that address.
  [Resend test-sender restriction](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain).
- **Other testers:** verify a domain you control in Resend and use a sender at
  that domain. [Resend domain verification](https://resend.com/docs/dashboard/domains/introduction).

Keep sign-in link tracking disabled. Open the email link in the browser where
it was requested; a different browser cannot complete that sign-in.

## 4. Set application variables

Enter these in the **pilot application's** Railway Variables tab. Store secrets
there, never in the repository, issues or chat.

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` (also set by the Dockerfile) |
| `PORT` | `8080` |
| `PORTER_ISSUER` | Exact generated HTTPS origin |
| `PORTER_PILOT_ENABLED` | `true` |
| `PORTER_DEMO_MODE` | `false` |
| `PORTER_STORAGE` | `postgres` |
| `DATABASE_URL` | Private database reference, e.g. `${{Postgres.DATABASE_URL}}`; substitute the actual PostgreSQL service name |
| `PORTER_SIGNING_SECRET` | Stable random value, at least 32 characters |
| `PORTER_ENCRYPTION_KEY` | Separate stable random 32-byte key, encoded as 64 hexadecimal characters |
| `PORTER_SQUARE_ENVIRONMENT` | `sandbox` |
| `PORTER_SQUARE_APPLICATION_ID` | Porter Square sandbox application ID |
| `PORTER_SQUARE_APPLICATION_SECRET` | That sandbox application's secret |
| `PORTER_EMAIL_MODE` | `resend` |
| `PORTER_RESEND_API_KEY` | Resend API key authorized for the sender |
| `PORTER_EMAIL_FROM` | Sender from step 3 |
| `PORTER_PILOT_INVITED_EMAILS` | Comma-separated emails permitted to activate businesses; use your test email first |
| `PORTER_INTERNAL_API_KEYS` | `false` |
| `LOG_LEVEL` | `info` |

Generate the two Porter secrets independently in a password manager or private
shell; `openssl rand -hex 32` produces one suitable value. Preserve both across
redeployments. Replacing the encryption key breaks access to existing encrypted
data; rotating the signing secret invalidates pending confirmations.

Optional: reserve operator emails with `PORTER_OPERATOR_EMAILS`; the operator console remains unfinished. Leave
`PORTER_MUSE_CONNECTOR_URL` unset until Meta approves an actual Porter listing
URL on `https://muse.ai`; the UI displays publication as pending.

Keep `PORTER_API_KEYS`, `PORTER_SQUARE_ACCESS_TOKEN`,
`PORTER_JOBBER_ACCESS_TOKEN`, `PORTER_STRIPE_SECRET_KEY`, `PORTER_WEB_SOURCES`
and `PORTER_SQUARE_PUBLIC_SOURCES` unset or empty. Pilot startup rejects mixing
these legacy settings with merchant-scoped authorization. Internal API keys are
also refused on hosted pilots. Merchant grants replace a global Square token.

## 5. Deploy and test

Deploy the configured `main` revision, completing any Railway deployment
approval for this pilot service. Check the source revision, Docker build,
migration output and readiness result.

Using the public origin, run:

```sh
PORTER_PILOT_ORIGIN='https://<pilot-service>.up.railway.app'
curl -fsS "$PORTER_PILOT_ORIGIN/readyz"
curl -fsS "$PORTER_PILOT_ORIGIN/.well-known/oauth-protected-resource"
curl -fsS "$PORTER_PILOT_ORIGIN/.well-known/oauth-authorization-server"
curl -sS -i -X POST "$PORTER_PILOT_ORIGIN/mcp" \
  -H 'Content-Type: application/json' -d '{}'
```

Readiness must report `storage: "postgres"` and `mode: "pilot-sandbox"`.
The unauthenticated MCP request must return `401` with an OAuth
`WWW-Authenticate` header. Metadata URLs must use this HTTPS origin.

Open the origin itself in a browser:

1. Submit a public website URL and review the preview. JavaScript-heavy sites
   can require manual completion.
2. Sign in with your invited email and confirm the private email link in the
   same browser.
3. Choose **Continue with Square** using the sandbox test account. Select a
   supported location, review actual Square services and policies, and activate
   only the synthetic salon used for testing.
4. Check `/owner` after a redeploy for persistence. Open `/connect` for customer
   authorization management and the current Muse publication state.

The website supports merchant onboarding. Customer bookings use the six
OAuth-authenticated MCP tools; there is no standalone browser booking checkout.
Full Muse testing also requires Muse's actual OAuth client and connector
access. Deployment alone does not publish a Muse listing.

## Recovery and rollout

Keep one application replica: some MCP rate limits and transport sessions remain
process-local. PostgreSQL persists identities, OAuth grants, merchant
connections, confirmations and retries. No Redis or application filesystem
volume is needed.

Back up PostgreSQL and stable encryption/signing keys. Startup checks the exact
migration ledger; rolling back to code predating applied migrations fails.
Retain migration compatibility or use a reviewed database restore. Never rewrite
applied SQL. See [database recovery notes](../packages/db/README.md).

Before real-user launch, finish the remaining operations, retention/deletion
and support work, configure accurate public privacy/terms/support pages, and
complete Meta review. See [current state](session-handoff.md),
[pilot behavior](pilot-local-development.md) and the
[submission checklist](../submission/checklist.md).

## Historical personal demo

The earlier Railway service was a memory-backed mock MCP demo using a private
API key. Its configuration and credentials are separate from this pilot and the
published Muse flow. For local mock testing, use
[local development](local-development.md). Keep pilot migrations and merchant
and email credentials out of a memory-only demo service.
