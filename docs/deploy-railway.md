# Deploying Porter to Railway

Railway hosts the remote MCP endpoint. The current server stores bookings and
OAuth state in memory, so this guide is for a single-instance demo deployment.
Restarting the service clears bookings. Do not add Postgres expecting it to
persist them: the application does not yet read `DATABASE_URL`.

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

## 1. Create the service and domain

```bash
railway login
railway init --name porter
railway add --service porter
railway domain --port 8080
```

Copy the generated `https://...up.railway.app` origin. Set variables below
before deploying: the production image refuses to start without a signing
secret. `railway up` then reads `railway.json`, builds from the `Dockerfile`,
and health-checks `GET /healthz`.

## 2. Variables

Set these in the Railway dashboard, not in the repo.

| Variable | Value | Why it matters |
|---|---|---|
| `PORTER_ISSUER` | `https://<your-app>.up.railway.app` | **Must exactly match the public origin.** It is the OAuth issuer and the RFC 9728 resource identifier. A mismatch breaks discovery. |
| `PORTER_SIGNING_SECRET` | 32+ random characters, **stable** | Signs slot ids and confirmation tokens. Rotating it invalidates every outstanding one. Generate with `openssl rand -hex 32`. |
| `PORTER_API_KEYS` | `<random-key>:<user-id>` | For the Muse custom-connector path. Share the key privately; `/docs` does not display it. |
| `LOG_LEVEL` | `info` | |
| `PORTER_DEMO_MODE` | `true` | Keep on: Meta's review runs end-to-end tests. |

Leave these **unset** until the gates in `muse-compliance.md` are cleared:

| Variable | Gate |
|---|---|
| `PORTER_SQUARE_ACCESS_TOKEN` | Upstream rights clearance + fixtures re-recorded against a real sandbox |
| `PORTER_JOBBER_ACCESS_TOKEN` | Same, plus confirming Jobber's inferred mutation inputs |
| `PORTER_STRIPE_SECRET_KEY` | Test keys only. The server refuses to boot with a live key unless `PORTER_ALLOW_LIVE_STRIPE=true`. |

`PORTER_SIGNING_SECRET` is required in production: the server throws at startup without it rather than generating one silently, because a generated secret would be different on every restart and would invalidate everything already issued.

After setting variables, deploy the current checkout with `railway up`.

The local OAuth flow accepts an unverified `porter_user` value. Production
disables its `/oauth/*` endpoints. Use an API key for a personal Muse test;
implement real user sign-in and persistent OAuth state before claiming OAuth
support in a public connector submission.

## 3. Persistent storage

Postgres and Redis are not used by the running app. Add them only after wiring
the store and OAuth state to persistent implementations. Keep this deployment
to one instance and demo data.

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

For a personal test, ask Muse to create a **Custom Connector** for the endpoint
and provide the API key privately. Meta's public help page does not specify a
guaranteed MCP custom-connector flow, so verify the connection in Muse.

## Notes

- **Scaling past one instance** needs Redis for the rate limiter and the
  confirmation-token store, both of which are in-process today.
- **Do not rotate `PORTER_SIGNING_SECRET`** as routine hygiene. It is a
  user-visible action: outstanding confirmations stop working.
