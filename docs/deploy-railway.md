# Deploying Porter to Railway

Hosting is Railway, decided in `plan.md` §9. Database is Railway Postgres.

## 0. Check the image locally first

The Dockerfile is verified: it builds, runs as a non-root `node` user, and
serves health, discovery, `/docs` and the MCP handshake.

```bash
docker build -t porter .
docker run --rm -p 8080:8080 \
  -e PORTER_ISSUER=http://127.0.0.1:8080 \
  -e PORTER_SIGNING_SECRET=$(openssl rand -hex 32) \
  -e PORTER_API_KEYS=demo-key:user_demo \
  porter

curl -s localhost:8080/healthz
```

## 1. Create the service

```bash
railway login
railway init
railway up
```

Railway reads `railway.json`, builds from the `Dockerfile` and health-checks
`GET /healthz`.

## 2. Variables

Set these in the Railway dashboard, not in the repo.

| Variable | Value | Why it matters |
|---|---|---|
| `PORTER_ISSUER` | `https://<your-app>.up.railway.app` | **Must exactly match the public origin.** It is the OAuth issuer and the RFC 9728 resource identifier. A mismatch breaks discovery. |
| `PORTER_SIGNING_SECRET` | 32+ random characters, **stable** | Signs slot ids and confirmation tokens. Rotating it invalidates every outstanding one. Generate with `openssl rand -hex 32`. |
| `PORTER_API_KEYS` | `<key>:<user-id>` | For the Muse custom-connector path and for reviewer demo access. |
| `DATABASE_URL` | from the Postgres plugin | Railway injects this when you attach Postgres. |
| `LOG_LEVEL` | `info` | |
| `PORTER_DEMO_MODE` | `true` | Keep on: Meta's review runs end-to-end tests. |

Leave these **unset** until the gates in `muse-compliance.md` are cleared:

| Variable | Gate |
|---|---|
| `PORTER_SQUARE_ACCESS_TOKEN` | Upstream rights clearance + fixtures re-recorded against a real sandbox |
| `PORTER_JOBBER_ACCESS_TOKEN` | Same, plus confirming Jobber's inferred mutation inputs |
| `PORTER_STRIPE_SECRET_KEY` | Test keys only. The server refuses to boot with a live key unless `PORTER_ALLOW_LIVE_STRIPE=true`. |

`PORTER_SIGNING_SECRET` is required in production: the server throws at startup without it rather than generating one silently, because a generated secret would be different on every restart and would invalidate everything already issued.

## 3. Add Postgres

```bash
railway add --database postgres
```

Then run migrations. Generate them from the Drizzle schema first:

```bash
pnpm --filter @porter/db exec drizzle-kit generate
pnpm --filter @porter/db exec drizzle-kit migrate
```

Milestone 2–4 run on the in-memory store, so Postgres is not strictly needed until you want state to survive a restart. It is needed before any real traffic.

## 4. Verify the deployment

```bash
BASE=https://<your-app>.up.railway.app

curl -s $BASE/healthz
curl -s $BASE/.well-known/oauth-protected-resource | jq
curl -s -i -X POST $BASE/mcp -d '{}' | head -3     # expect 401 + WWW-Authenticate
curl -s $BASE/docs | head -20
```

The 401 must carry a `WWW-Authenticate` header pointing at the
protected-resource metadata. That is how an MCP client discovers authentication.

## 5. Point Muse at it

Once `PORTER_ISSUER` is a real HTTPS origin, `<issuer>/mcp` is what goes in the
submission form's **Hosted MCP endpoint** field, with connection type
**Existing MCP**. Run `pnpm submission:validate` first.

Before the directory listing exists, any Muse user can add the same endpoint as
a **custom connector** — that path needs no Meta review.

## Notes

- **Scaling past one instance** needs Redis for the rate limiter and the
  confirmation-token store, both of which are in-process today.
- **Do not rotate `PORTER_SIGNING_SECRET`** as routine hygiene. It is a
  user-visible action: outstanding confirmations stop working.
