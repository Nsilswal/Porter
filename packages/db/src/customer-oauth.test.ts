import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createCustomerOAuthStore } from "./customer-oauth.js";
import type { CustomerOAuthStore, OAuthAuthorizationRequest } from "./customer-oauth-types.js";
import { createPilotStore } from "./pilot.js";
import type { PilotStore } from "./pilot-types.js";
import { migratePostgres } from "./migrations.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const encryptionKey = randomBytes(32);
const schemaName = `porter_customer_oauth_${randomUUID().replaceAll("-", "")}`;
const resource = "https://porter.example.test/mcp";
const redirectUri = "https://client.example.test/oauth/callback";
const hash = (value = randomUUID()) => createHash("sha256").update(value).digest("hex");
const challenge = () => randomBytes(32).toString("base64url");
const later = (now: Date, ms = 3_600_000) => new Date(now.getTime() + ms);
let scopedUrl: string;
let admin: Pool;
let raw: Pool;
const stores: { close(): Promise<void> }[] = [];

async function openStore() {
  const store = await createCustomerOAuthStore({ connectionString: scopedUrl, encryptionKey, maxConnections: 3 });
  stores.push(store);
  return store;
}

async function openPilot() {
  const store = await createPilotStore({ connectionString: scopedUrl, encryptionKey, maxConnections: 2 });
  stores.push(store);
  return store;
}

async function session(pilot: PilotStore, now = new Date()) {
  const identity = await pilot.identities.getOrCreate(`${randomUUID()}@example.test`);
  const token = { tokenHash: hash(), browserNonceHash: hash(), userId: identity.userId, expiresAt: later(now) };
  await pilot.loginTokens.issue(token);
  return (await pilot.loginTokens.consume({ ...token, sessionHash: hash(), sessionExpiresAt: later(now), now }))!;
}

async function authorization(store: CustomerOAuthStore, now = new Date()) {
  const client = await store.clients.register({ id: randomUUID(), name: "Test assistant", redirectUris: [redirectUri], now });
  const request: OAuthAuthorizationRequest & { browserNonceHash: string; now: Date } = {
    requestHash: hash(), browserNonceHash: hash(), clientId: client.id, redirectUri, resource,
    scopes: ["bookings:read", "bookings:write"], codeChallenge: challenge(), state: "opaque-client-state",
    expiresAt: later(now, 20 * 60_000), now,
  };
  await store.requests.issue(request);
  return request;
}

async function code(store: CustomerOAuthStore, now = new Date()) {
  const pilot = await openPilot();
  const owner = await session(pilot, now);
  const request = await authorization(store, now);
  const consent = { requestHash: request.requestHash, browserNonceHash: request.browserNonceHash,
    userId: owner.userId, sessionHash: owner.sessionHash, codeHash: hash(), codeExpiresAt: later(now, 300_000), now };
  expect(await store.requests.approve(consent)).toMatchObject({ requestHash: request.requestHash });
  const exchange = { codeHash: consent.codeHash, clientId: request.clientId, redirectUri, resource,
    codeChallenge: request.codeChallenge, grantId: randomUUID(), accessTokenHash: hash(), refreshTokenHash: hash(),
    accessExpiresAt: later(now), refreshExpiresAt: later(now, 30 * 86400_000), now };
  return { owner, pilot, request, consent, exchange };
}

function rotation(exchange: Awaited<ReturnType<typeof code>>["exchange"]) {
  return { clientId: exchange.clientId, resource, refreshTokenHash: exchange.refreshTokenHash,
    accessTokenHash: hash(), newRefreshTokenHash: hash(), accessExpiresAt: later(exchange.now), now: exchange.now };
}

beforeAll(async () => {
  if (!databaseUrl) return;
  admin = new Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schemaName}`);
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  scopedUrl = url.toString();
  await migratePostgres(scopedUrl);
  raw = new Pool({ connectionString: scopedUrl });
});

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

afterAll(async () => {
  await raw?.end();
  if (admin) {
    await admin.query(`DROP SCHEMA ${schemaName} CASCADE`);
    await admin.end();
  }
});

describe.runIf(Boolean(databaseUrl))("PostgreSQL customer OAuth", () => {
  it("keeps client registration immutable and requires exact registered redirect URIs", async () => {
    const store = await openStore();
    const request = await authorization(store);
    const client = (await store.clients.get(request.clientId))!;
    expect(client.redirectUris).toEqual([redirectUri]);
    await expect(store.clients.register({ ...client, name: "Replacement", redirectUris: ["https://evil.example/cb"], now: new Date() })).rejects.toThrow();
    expect(await store.clients.get(client.id)).toEqual(client);
    for (const redirect of [`${redirectUri}/`, `${redirectUri}?added=yes`, redirectUri.toUpperCase()]) {
      await expect(store.requests.issue({ ...request, requestHash: hash(), redirectUri: redirect })).rejects.toThrow("Unregistered");
    }
    for (const redirect of ["https://client.example/cb#", "https://user:pass@client.example/cb", "http://remote.example/cb", "javascript:alert(1)"]) {
      await expect(store.clients.register({ id: randomUUID(), name: "Bad", redirectUris: [redirect], now: new Date() })).rejects.toThrow("redirect");
    }
  });

  it("persists browser-bound authorization through restart without exposing its browser nonce hash", async () => {
    const first = await openStore();
    const request = await authorization(first);
    await first.close();
    const second = await openStore();
    const view = await second.requests.get(request.requestHash, request.browserNonceHash, request.now);
    expect(view).toMatchObject({ requestHash: request.requestHash, clientId: request.clientId, state: request.state });
    expect(view).not.toHaveProperty("browserNonceHash");
    await expect(second.requests.get(request.requestHash, hash(), request.now)).resolves.toBeNull();
    await expect(second.requests.get(request.requestHash, request.browserNonceHash, request.expiresAt)).resolves.toBeNull();
  });

  it("requires the initiating browser and a live session belonging to the consenting user", async () => {
    const store = await openStore();
    const pilot = await openPilot();
    const owner = await session(pilot);
    const other = await session(pilot);
    const request = await authorization(store);
    const input = { ...request, userId: owner.userId, sessionHash: owner.sessionHash, codeHash: hash(), codeExpiresAt: later(request.now) };
    await expect(store.requests.approve({ ...input, browserNonceHash: hash() })).resolves.toBeNull();
    await expect(store.requests.approve({ ...input, sessionHash: other.sessionHash })).resolves.toBeNull();
    await expect(store.requests.approve({ ...input, userId: other.userId })).resolves.toBeNull();
    await expect(store.requests.approve({ ...input, now: request.expiresAt, codeExpiresAt: later(request.expiresAt) })).resolves.toBeNull();
    await raw.query("UPDATE pilot_sessions SET expires_at = $2 WHERE session_hash = $1", [owner.sessionHash, request.now]);
    await expect(store.requests.approve(input)).resolves.toBeNull();
    await raw.query("UPDATE pilot_sessions SET expires_at = $2 WHERE session_hash = $1", [owner.sessionHash, later(request.now)]);
    await pilot.sessions.revoke(owner.userId, owner.sessionHash);
    await expect(store.requests.approve(input)).resolves.toBeNull();
    await expect(store.requests.get(request.requestHash, request.browserNonceHash, request.now)).resolves.toBeTruthy();
  });

  it("spends consent exactly once across processes, including competing approval and denial", async () => {
    const first = await openStore();
    const second = await openStore();
    const pilot = await openPilot();
    const owner = await session(pilot);
    const request = await authorization(first);
    const input = { ...request, userId: owner.userId, sessionHash: owner.sessionHash, codeHash: hash(), codeExpiresAt: later(request.now) };
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => index % 2
      ? first.requests.approve({ ...input, codeHash: hash() }) : second.requests.deny(input)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await raw.query("SELECT count(*)::int AS count FROM customer_oauth_codes WHERE request_hash = $1", [request.requestHash])).rows[0].count).toBeLessThanOrEqual(1);
    await expect(second.requests.get(request.requestHash, request.browserNonceHash, request.now)).resolves.toBeNull();
  });

  it("rolls consent spending back if the code insert fails", async () => {
    const store = await openStore();
    const existing = await code(store);
    const request = await authorization(store);
    const input = { ...existing.consent, requestHash: request.requestHash, browserNonceHash: request.browserNonceHash };
    await expect(store.requests.approve(input)).rejects.toThrow();
    await expect(store.requests.approve({ ...input, codeHash: hash() })).resolves.toMatchObject({ requestHash: request.requestHash });
  });

  it("validates every code binding before spending, and persists issued access through restart", async () => {
    const first = await openStore();
    const { exchange, owner } = await code(first);
    for (const patch of [{ clientId: "wrong-client" }, { redirectUri: `${redirectUri}/` }, { resource: "https://other.example/mcp" }, { codeChallenge: challenge() }]) {
      await expect(first.tokens.exchangeCode({ ...exchange, ...patch })).resolves.toBeNull();
    }
    const grant = await first.tokens.exchangeCode(exchange);
    expect(grant).toMatchObject({ id: exchange.grantId, userId: owner.userId, clientId: exchange.clientId, resource });
    await first.close();
    const second = await openStore();
    await expect(second.tokens.lookupAccess(exchange.accessTokenHash, resource, exchange.now)).resolves.toEqual(grant);
    await expect(second.tokens.lookupAccess(exchange.accessTokenHash, `${resource}/`, exchange.now)).resolves.toBeNull();
    await expect(second.tokens.lookupAccess(exchange.accessTokenHash, resource, exchange.accessExpiresAt)).resolves.toBeNull();
    await expect(second.grants.list(owner.userId, exchange.now)).resolves.toEqual([grant]);
    await expect(second.grants.list("another-user", exchange.now)).resolves.toEqual([]);
  });

  it("issues only one grant under concurrent code exchange and revokes it on a valid replay", async () => {
    const first = await openStore();
    const second = await openStore();
    const { exchange } = await code(first);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? first : second).tokens.exchangeCode({
      ...exchange, grantId: randomUUID(), accessTokenHash: hash(), refreshTokenHash: hash(),
    })));
    const issued = results.filter(Boolean);
    expect(issued).toHaveLength(1);
    const { rows } = await raw.query("SELECT revoked_at FROM customer_oauth_grants WHERE id = $1", [issued[0]!.id]);
    expect(rows[0].revoked_at).toBeInstanceOf(Date);
    const count = await raw.query("SELECT count(*)::int AS count FROM customer_oauth_grants WHERE client_id = $1", [exchange.clientId]);
    expect(count.rows[0].count).toBe(1);
  });

  it("rejects expired codes, but retains spent codes to detect replay after their expiry", async () => {
    const store = await openStore();
    const expired = await code(store);
    await expect(store.tokens.exchangeCode({ ...expired.exchange, now: expired.consent.codeExpiresAt })).resolves.toBeNull();
    const used = await code(store);
    expect(await store.tokens.exchangeCode(used.exchange)).toBeTruthy();
    await expect(store.tokens.exchangeCode({ ...used.exchange, now: used.consent.codeExpiresAt })).resolves.toBeNull();
    await expect(store.tokens.lookupAccess(used.exchange.accessTokenHash, resource, used.consent.codeExpiresAt)).resolves.toBeNull();
  });

  it("rolls exchange back on insertion failure so no partial tokens or spent code escape", async () => {
    const store = await openStore();
    const existing = await code(store);
    expect(await store.tokens.exchangeCode(existing.exchange)).toBeTruthy();
    const fresh = await code(store);
    await expect(store.tokens.exchangeCode({ ...fresh.exchange, accessTokenHash: existing.exchange.accessTokenHash })).rejects.toThrow();
    expect((await raw.query("SELECT count(*)::int AS count FROM customer_oauth_grants WHERE id = $1", [fresh.exchange.grantId])).rows[0].count).toBe(0);
    await expect(store.tokens.exchangeCode(fresh.exchange)).resolves.toMatchObject({ id: fresh.exchange.grantId });
  });

  it("rotates refresh tokens across restarts and retains every spent hash to revoke the family on reuse", async () => {
    const first = await openStore();
    const { exchange } = await code(first);
    const grant = await first.tokens.exchangeCode(exchange);
    const firstRotation = rotation(exchange);
    expect(await first.tokens.refresh(firstRotation)).toEqual(grant);
    await first.close();
    const second = await openStore();
    const secondRotation = { ...rotation(exchange), refreshTokenHash: firstRotation.newRefreshTokenHash };
    expect(await second.tokens.refresh(secondRotation)).toEqual(grant);
    expect((await raw.query("SELECT count(*)::int AS count FROM customer_oauth_refresh_tokens WHERE grant_id = $1", [exchange.grantId])).rows[0].count).toBe(3);
    expect((await raw.query("SELECT count(*)::int AS count FROM customer_oauth_refresh_tokens WHERE grant_id = $1 AND consumed_at IS NOT NULL", [exchange.grantId])).rows[0].count).toBe(2);
    await expect(second.tokens.refresh(rotation(exchange))).resolves.toBeNull();
    for (const tokenHash of [exchange.accessTokenHash, firstRotation.accessTokenHash, secondRotation.accessTokenHash]) {
      await expect(second.tokens.lookupAccess(tokenHash, resource, exchange.now)).resolves.toBeNull();
    }
    await expect(second.tokens.refresh({ ...rotation(exchange), refreshTokenHash: secondRotation.newRefreshTokenHash })).resolves.toBeNull();
  });

  it("rejects refresh binding changes and escalation, and makes narrowed scopes permanent", async () => {
    const store = await openStore();
    const { exchange } = await code(store);
    await store.tokens.exchangeCode(exchange);
    const next = rotation(exchange);
    for (const patch of [{ clientId: "another-client" }, { resource: "https://other.example/mcp" }, { scopes: ["admin"] }]) {
      await expect(store.tokens.refresh({ ...next, ...patch })).resolves.toBeNull();
    }
    await expect(store.tokens.refresh({ ...next, scopes: ["bookings:read"] })).resolves.toMatchObject({ scopes: ["bookings:read"], expiresAt: exchange.refreshExpiresAt });
    await expect(store.tokens.lookupAccess(exchange.accessTokenHash, resource, exchange.now)).resolves.toMatchObject({ scopes: ["bookings:read"] });
    const last = { ...rotation(exchange), refreshTokenHash: next.newRefreshTokenHash };
    await expect(store.tokens.refresh({ ...last, scopes: ["bookings:read", "bookings:write"] })).resolves.toBeNull();
    await expect(store.tokens.refresh(last)).resolves.toMatchObject({ scopes: ["bookings:read"] });
  });

  it("serializes concurrent refresh and revokes the winning token when a sibling reuses its predecessor", async () => {
    const first = await openStore();
    const second = await openStore();
    const { exchange } = await code(first);
    await first.tokens.exchangeCode(exchange);
    const rotations = Array.from({ length: 12 }, () => rotation(exchange));
    const results = await Promise.all(rotations.map((input, index) => (index % 2 ? first : second).tokens.refresh(input)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = rotations[results.findIndex(Boolean)]!;
    await expect(second.tokens.lookupAccess(winner.accessTokenHash, resource, exchange.now)).resolves.toBeNull();
    expect((await raw.query("SELECT count(*)::int AS count FROM customer_oauth_refresh_tokens WHERE grant_id = $1", [exchange.grantId])).rows[0].count).toBe(2);
  });

  it("serializes reuse of an older generation against rotation of the current generation", async () => {
    const first = await openStore();
    const second = await openStore();
    const { exchange } = await code(first);
    await first.tokens.exchangeCode(exchange);
    const next = rotation(exchange);
    await first.tokens.refresh(next);
    const current = { ...rotation(exchange), refreshTokenHash: next.newRefreshTokenHash };
    await Promise.all([first.tokens.refresh(current), second.tokens.refresh(rotation(exchange))]);
    await expect(first.tokens.lookupAccess(current.accessTokenHash, resource, exchange.now)).resolves.toBeNull();
    await expect(first.tokens.lookupAccess(next.accessTokenHash, resource, exchange.now)).resolves.toBeNull();
  });

  it("rolls refresh consumption back if issuing its successor fails", async () => {
    const store = await openStore();
    const { exchange } = await code(store);
    await store.tokens.exchangeCode(exchange);
    const next = rotation(exchange);
    await expect(store.tokens.refresh({ ...next, accessTokenHash: exchange.accessTokenHash })).rejects.toThrow();
    await expect(store.tokens.refresh(next)).resolves.toMatchObject({ id: exchange.grantId });
  });

  it("enforces the fixed family expiry and clamps the last access token to it", async () => {
    const store = await openStore();
    const { exchange } = await code(store);
    const short = { ...exchange, refreshExpiresAt: later(exchange.now, 10_000) };
    await store.tokens.exchangeCode(short);
    const next = { ...rotation(exchange), now: later(exchange.now, 9_000) };
    const grant = await store.tokens.refresh(next);
    expect(grant?.expiresAt).toEqual(short.refreshExpiresAt);
    await expect(store.tokens.lookupAccess(next.accessTokenHash, resource, later(exchange.now, 9_999))).resolves.toBeTruthy();
    await expect(store.tokens.lookupAccess(next.accessTokenHash, resource, short.refreshExpiresAt)).resolves.toBeNull();
    await expect(store.tokens.refresh({ ...rotation(exchange), refreshTokenHash: next.newRefreshTokenHash, now: short.refreshExpiresAt })).resolves.toBeNull();
    await expect(store.grants.list(grant!.userId, short.refreshExpiresAt)).resolves.toEqual([]);
  });

  it("isolates user revocation and requires a live session for the grant owner", async () => {
    const store = await openStore();
    const { exchange, owner, pilot } = await code(store);
    const other = await session(pilot);
    await store.tokens.exchangeCode(exchange);
    await expect(store.grants.revoke({ userId: other.userId, sessionHash: other.sessionHash, grantId: exchange.grantId, now: exchange.now })).resolves.toBe(false);
    await expect(store.grants.revoke({ userId: owner.userId, sessionHash: other.sessionHash, grantId: exchange.grantId, now: exchange.now })).resolves.toBe(false);
    await expect(store.tokens.lookupAccess(exchange.accessTokenHash, resource, exchange.now)).resolves.toBeTruthy();
    await expect(store.grants.revoke({ userId: owner.userId, sessionHash: owner.sessionHash, grantId: exchange.grantId, now: exchange.now })).resolves.toBe(true);
    await expect(store.tokens.lookupAccess(exchange.accessTokenHash, resource, exchange.now)).resolves.toBeNull();
    await expect(store.tokens.refresh(rotation(exchange))).resolves.toBeNull();
    await expect(store.grants.list(owner.userId, exchange.now)).resolves.toEqual([]);
  });

  it("binds idempotent public-client token revocation to the issuing client for both token types", async () => {
    const store = await openStore();
    for (const type of ["accessTokenHash", "refreshTokenHash"] as const) {
      const { exchange } = await code(store);
      await store.tokens.exchangeCode(exchange);
      await store.tokens.revoke({ tokenHash: exchange[type], clientId: "wrong-client", now: exchange.now });
      await expect(store.tokens.lookupAccess(exchange.accessTokenHash, resource, exchange.now)).resolves.toBeTruthy();
      await store.tokens.revoke({ tokenHash: exchange[type], clientId: exchange.clientId, now: exchange.now });
      await store.tokens.revoke({ tokenHash: exchange[type], clientId: exchange.clientId, now: exchange.now });
      await expect(store.tokens.lookupAccess(exchange.accessTokenHash, resource, exchange.now)).resolves.toBeNull();
      await expect(store.tokens.refresh(rotation(exchange))).resolves.toBeNull();
    }
    await expect(store.tokens.revoke({ tokenHash: hash(), clientId: "unknown-client", now: new Date() })).resolves.toBeUndefined();
  });

  it("refuses consent after a concurrent logout commits", async () => {
    const store = await openStore();
    const pilot = await openPilot();
    const owner = await session(pilot);
    const request = await authorization(store);
    const client = await raw.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE pilot_sessions SET revoked_at = now() WHERE session_hash = $1", [owner.sessionHash]);
      const pending = store.requests.approve({ ...request, userId: owner.userId, sessionHash: owner.sessionHash,
        codeHash: hash(), codeExpiresAt: later(request.now) });
      await client.query("COMMIT");
      await expect(pending).resolves.toBeNull();
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("respects deleted users for consent, exchange, access, refresh, and grant enumeration", async () => {
    const store = await openStore();
    const unspent = await code(store);
    const issued = await code(store);
    await store.tokens.exchangeCode(issued.exchange);
    const pendingRequest = await authorization(store);
    await raw.query("UPDATE users SET deleted_at = now() WHERE id IN ($1, $2)", [unspent.owner.userId, issued.owner.userId]);
    await expect(store.requests.approve({ ...pendingRequest, userId: unspent.owner.userId, sessionHash: unspent.owner.sessionHash,
      codeHash: hash(), codeExpiresAt: later(pendingRequest.now) })).resolves.toBeNull();
    await expect(store.tokens.exchangeCode(unspent.exchange)).resolves.toBeNull();
    await expect(store.tokens.lookupAccess(issued.exchange.accessTokenHash, resource, issued.exchange.now)).resolves.toBeNull();
    await expect(store.tokens.refresh(rotation(issued.exchange))).resolves.toBeNull();
    await expect(store.grants.list(issued.owner.userId, issued.exchange.now)).resolves.toEqual([]);
  });

  it("waits for a concurrent user deletion before issuing credentials", async () => {
    const store = await openStore();
    const { exchange, owner } = await code(store);
    const client = await raw.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE users SET deleted_at = now() WHERE id = $1", [owner.userId]);
      const pending = store.tokens.exchangeCode(exchange);
      await client.query("COMMIT");
      await expect(pending).resolves.toBeNull();
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("never persists raw browser, code, access, or refresh secrets and rejects plaintext hash fields", async () => {
    const store = await openStore();
    const { exchange } = await code(store);
    const accessSecret = `access-${randomUUID()}`;
    const refreshSecret = `refresh-${randomUUID()}`;
    await store.tokens.exchangeCode({ ...exchange, accessTokenHash: hash(accessSecret), refreshTokenHash: hash(refreshSecret) });
    const rows = await raw.query(`SELECT row_to_json(t)::text AS stored FROM customer_oauth_access_tokens t
      UNION ALL SELECT row_to_json(t)::text AS stored FROM customer_oauth_refresh_tokens t`);
    const serialized = JSON.stringify(rows.rows);
    expect(serialized).not.toContain(accessSecret);
    expect(serialized).not.toContain(refreshSecret);
    await expect(store.tokens.lookupAccess(accessSecret, resource, exchange.now)).rejects.toThrow("SHA-256");
    await expect(store.tokens.refresh({ ...rotation(exchange), refreshTokenHash: refreshSecret })).rejects.toThrow("SHA-256");
    await expect(store.tokens.exchangeCode({ ...exchange, codeHash: "plaintext-code" })).rejects.toThrow("SHA-256");
    await expect(store.requests.get(hash(), "plaintext-browser-secret", exchange.now)).rejects.toThrow("SHA-256");
  });
});
