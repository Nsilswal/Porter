import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createPilotStore } from "./pilot.js";
import { createPostgresStore } from "./postgres.js";
import { migratePostgres } from "./migrations.js";
import type { NewMerchantCredentials, PilotStore, SquareOAuthState } from "./pilot-types.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const encryptionKey = randomBytes(32);
const schemaName = `porter_pilot_${randomUUID().replaceAll("-", "")}`;
let scopedUrl: string;
let admin: Pool;
let raw: Pool;
const stores: PilotStore[] = [];
const hash = (value = randomUUID()) => createHash("sha256").update(value).digest("hex");
const future = () => new Date(Date.now() + 3_600_000);

async function openStore() {
  const store = await createPilotStore({ connectionString: scopedUrl, encryptionKey, maxConnections: 3 });
  stores.push(store);
  return store;
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
  await Promise.all(stores.map((store) => store.close()));
  await raw?.end();
  if (admin) {
    await admin.query(`DROP SCHEMA ${schemaName} CASCADE`);
    await admin.end();
  }
});

async function identity(store: PilotStore) {
  return store.identities.getOrCreate(`${randomUUID()}@example.test`);
}

async function login(store: PilotStore, userId: string) {
  const tokenHash = hash();
  const browserNonceHash = hash();
  await store.loginTokens.issue({ tokenHash, browserNonceHash, userId, expiresAt: future() });
  const input = { tokenHash, browserNonceHash, sessionHash: hash(), sessionExpiresAt: future(), now: new Date() };
  return (await store.loginTokens.consume(input))!;
}

async function business(store: PilotStore, ownerId?: string) {
  return store.businesses.create({ id: randomUUID(), ownerId: ownerId ?? (await identity(store)).userId,
    name: "Test Salon", websiteUrl: "https://salon.example.test", profile: { description: "Reviewed by owner" } });
}

function credentials(businessId: string): NewMerchantCredentials {
  return { businessId, environment: "sandbox", merchantId: randomUUID(), accessToken: `access-${randomUUID()}`,
    refreshToken: `refresh-${randomUUID()}`, expiresAt: future(), scopes: ["APPOINTMENTS_READ"] };
}

async function connect(store: PilotStore, ownerId: string, input: NewMerchantCredentials, version: number | null) {
  const session = await login(store, ownerId);
  return store.connections.connect(ownerId, input, version, session.sessionHash);
}

async function oauthState(store: PilotStore) {
  const owner = await identity(store);
  const session = await login(store, owner.userId);
  const salon = await business(store, owner.userId);
  const state: SquareOAuthState = { stateHash: hash(), userId: owner.userId, sessionHash: session.sessionHash,
    businessId: salon.id, environment: "sandbox", expiresAt: future(), connectionVersion: null };
  await store.oauthStates.issue(state);
  return { state, salon, input: { stateHash: state.stateHash, userId: owner.userId, sessionHash: session.sessionHash,
    environment: "sandbox" as const, now: new Date() } };
}

describe.runIf(Boolean(databaseUrl))("PostgreSQL pilot identity and merchant isolation", () => {
  it("creates one normalized identity and user under cross-store contention", async () => {
    const first = await openStore();
    const second = await openStore();
    const email = `${randomUUID()}@example.test`;
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? first : second).identities.getOrCreate(i % 2 ? email : `  ${email.toUpperCase()}  `)));
    expect(new Set(results.map((row) => row.userId)).size).toBe(1);
    expect(results.every((row) => row.email === email)).toBe(true);
    const result = await raw.query("SELECT count(*)::int AS count FROM users WHERE id = $1", [results[0]!.userId]);
    expect(result.rows[0].count).toBe(1);
    await expect(first.identities.getOrCreate("not-an-email")).rejects.toThrow("Invalid email");
  });

  it("binds email sign-in to its browser and atomically spends the token only once", async () => {
    const first = await openStore();
    const second = await openStore();
    const owner = await identity(first);
    const tokenHash = hash();
    const browserNonceHash = hash();
    await first.loginTokens.issue({ tokenHash, browserNonceHash, userId: owner.userId, expiresAt: future() });
    const input = { tokenHash, browserNonceHash, sessionHash: hash(), sessionExpiresAt: future(), now: new Date() };
    await expect(first.loginTokens.consume({ ...input, browserNonceHash: hash() })).resolves.toBeNull();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? first : second).loginTokens.consume({ ...input, sessionHash: hash() })));
    expect(results.filter(Boolean)).toHaveLength(1);
    const session = results.find(Boolean)!;
    expect(session.userId).toBe(owner.userId);
    await expect(second.sessions.lookup(session.sessionHash, new Date())).resolves.toEqual(session);
    const result = await raw.query("SELECT count(*)::int AS count FROM pilot_sessions WHERE user_id = $1", [owner.userId]);
    expect(result.rows[0].count).toBe(1);
  });

  it("rolls token consumption back if session insertion fails", async () => {
    const store = await openStore();
    const owner = await identity(store);
    const existing = await login(store, owner.userId);
    const tokenHash = hash();
    const browserNonceHash = hash();
    await store.loginTokens.issue({ tokenHash, browserNonceHash, userId: owner.userId, expiresAt: future() });
    const input = { tokenHash, browserNonceHash, sessionHash: existing.sessionHash, sessionExpiresAt: future(), now: new Date() };
    await expect(store.loginTokens.consume(input)).rejects.toThrow();
    await expect(store.loginTokens.consume({ ...input, sessionHash: hash() })).resolves.toMatchObject({ userId: owner.userId });
  });

  it("rejects expired login tokens, expired sessions, deleted users, and cross-user revocation", async () => {
    const store = await openStore();
    const owner = await identity(store);
    const tokenHash = hash();
    const browserNonceHash = hash();
    await store.loginTokens.issue({ tokenHash, browserNonceHash, userId: owner.userId, expiresAt: new Date(0) });
    await expect(store.loginTokens.consume({ tokenHash, browserNonceHash, sessionHash: hash(), sessionExpiresAt: future(), now: new Date() })).resolves.toBeNull();
    const session = await login(store, owner.userId);
    await expect(store.sessions.lookup(session.sessionHash, session.expiresAt)).resolves.toBeNull();
    await expect(store.sessions.revoke("another-user", session.sessionHash)).resolves.toBe(false);
    await expect(store.sessions.lookup(session.sessionHash, new Date())).resolves.toBeTruthy();
    await store.sessions.revoke(owner.userId, session.sessionHash);
    await expect(store.sessions.lookup(session.sessionHash, new Date())).resolves.toBeNull();
    const active = await login(store, owner.userId);
    await raw.query("UPDATE users SET deleted_at = now() WHERE id = $1", [owner.userId]);
    await expect(store.sessions.lookup(active.sessionHash, new Date())).resolves.toBeNull();
    await expect(store.identities.get(owner.userId)).resolves.toBeNull();
    await expect(store.identities.getOrCreate(owner.email)).rejects.toThrow("Identity is unavailable");
    await expect(store.loginTokens.issue({ tokenHash: hash(), browserNonceHash: hash(), userId: owner.userId, expiresAt: future() })).rejects.toThrow("Identity is unavailable");
  });

  it("stores only connector hashes, scopes keys to customers, and persists revocation", async () => {
    const first = await openStore();
    const owner = await identity(first);
    const token = `porter-${randomUUID()}`;
    const credential = await first.connectors.issue({ id: randomUUID(), userId: owner.userId, tokenHash: hash(token), label: "Personal Muse" });
    expect(credential).not.toHaveProperty("tokenHash");
    await expect(first.connectors.list("another-user")).resolves.toEqual([]);
    await expect(first.connectors.lookup(hash(token))).resolves.toEqual(credential);
    const result = await raw.query("SELECT row_to_json(c)::text AS stored FROM connector_credentials c WHERE id = $1", [credential.id]);
    expect(result.rows[0].stored).not.toContain(token);
    await expect(first.connectors.revoke("another-user", credential.id)).resolves.toBe(false);
    const second = await openStore();
    await expect(second.connectors.revoke(owner.userId, credential.id)).resolves.toBe(true);
    await expect(first.connectors.lookup(hash(token))).resolves.toBeNull();
    expect((await first.connectors.list(owner.userId))[0]!.revokedAt).toBeInstanceOf(Date);
  });

  it("rejects plaintext bearer material in all hashed token fields", async () => {
    const store = await openStore();
    const owner = await identity(store);
    await expect(store.loginTokens.issue({ tokenHash: "raw-secret", browserNonceHash: hash(), userId: owner.userId, expiresAt: future() })).rejects.toThrow("SHA-256");
    await expect(store.connectors.issue({ id: randomUUID(), userId: owner.userId, tokenHash: "raw-secret", label: "Muse" })).rejects.toThrow("SHA-256");
    await expect(store.sessions.lookup("raw-secret", new Date())).rejects.toThrow("SHA-256");
  });

  it("isolates business ownership and makes the first selected location permanent under contention", async () => {
    const first = await openStore();
    const second = await openStore();
    const salon = await business(first);
    await expect(first.businesses.get("another-owner", salon.id)).resolves.toBeNull();
    await expect(first.businesses.update("another-owner", salon.id, { name: "Hijacked" })).resolves.toBeNull();
    const results = await Promise.all([
      first.businesses.update(salon.ownerId, salon.id, { selectedLocationId: "location-a" }),
      second.businesses.update(salon.ownerId, salon.id, { selectedLocationId: "location-b" }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const selected = results.find(Boolean)!.selectedLocationId!;
    await expect(first.businesses.update(salon.ownerId, salon.id, { selectedLocationId: selected, status: "active" })).resolves.toMatchObject({ status: "active" });
    expect((await first.businesses.listActive()).some((row) => row.id === salon.id)).toBe(true);
    await first.businesses.update(salon.ownerId, salon.id, { status: "paused" });
    expect((await first.businesses.listActive()).some((row) => row.id === salon.id)).toBe(false);
    await expect(first.businesses.getById(salon.id)).resolves.toMatchObject({ status: "paused" });
  });

  it("binds OAuth state to owner/session/environment and consumes exactly once across stores", async () => {
    const first = await openStore();
    const second = await openStore();
    const { state, input } = await oauthState(first);
    await expect(first.oauthStates.consume({ ...input, userId: "another-owner" })).resolves.toBeNull();
    await expect(first.oauthStates.consume({ ...input, sessionHash: hash() })).resolves.toBeNull();
    await expect(first.oauthStates.consume({ ...input, environment: "production" })).resolves.toBeNull();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? first : second).oauthStates.consume(input)));
    expect(results.filter(Boolean)).toEqual([state]);
  });

  it("rejects OAuth issue/consume for revoked sessions, expired state and wrong business owner", async () => {
    const store = await openStore();
    const { state, input } = await oauthState(store);
    const other = await business(store);
    await expect(store.oauthStates.issue({ ...state, stateHash: hash(), businessId: other.id })).rejects.toThrow();
    await expect(store.oauthStates.consume({ ...input, now: state.expiresAt })).resolves.toBeNull();
    await store.sessions.revoke(state.userId, state.sessionHash);
    await expect(store.oauthStates.consume(input)).resolves.toBeNull();
    await expect(store.oauthStates.issue({ ...state, stateHash: hash() })).rejects.toThrow("Session is unavailable");
  });

  it("serializes OAuth consumption with concurrent session revocation", async () => {
    const store = await openStore();
    const { state, input } = await oauthState(store);
    const client = await raw.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE pilot_sessions SET revoked_at = now() WHERE session_hash = $1", [state.sessionHash]);
      const pending = store.oauthStates.consume(input);
      await client.query("COMMIT");
      await expect(pending).resolves.toBeNull();
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("rejects OAuth state when its user is deleted or session expires", async () => {
    const store = await openStore();
    const expired = await oauthState(store);
    await raw.query("UPDATE pilot_sessions SET expires_at = now() - interval '1 second' WHERE session_hash = $1", [expired.state.sessionHash]);
    await expect(store.oauthStates.consume({ ...expired.input, now: new Date() })).resolves.toBeNull();
    await expect(store.oauthStates.issue({ ...expired.state, stateHash: hash() })).rejects.toThrow("Session is unavailable");
    const deleted = await oauthState(store);
    await raw.query("UPDATE users SET deleted_at = now() WHERE id = $1", [deleted.state.userId]);
    await expect(store.oauthStates.consume(deleted.input)).resolves.toBeNull();
    await expect(store.oauthStates.issue({ ...deleted.state, stateHash: hash() })).rejects.toThrow("Session is unavailable");
  });

  it("refuses a delayed OAuth callback after logout without installing credentials", async () => {
    const store = await openStore();
    const { state, input, salon } = await oauthState(store);
    await expect(store.oauthStates.consume(input)).resolves.toEqual(state);
    await store.sessions.revoke(state.userId, state.sessionHash);
    await expect(store.connections.connect(salon.ownerId, credentials(salon.id), state.connectionVersion, state.sessionHash)).rejects.toThrow("Session is unavailable");
    await expect(store.connections.get(salon.ownerId, salon.id, "sandbox")).resolves.toBeNull();
  });

  it("serializes credential installation with a concurrent logout", async () => {
    const store = await openStore();
    const { state, salon } = await oauthState(store);
    const client = await raw.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE pilot_sessions SET revoked_at = now() WHERE session_hash = $1", [state.sessionHash]);
      const pending = store.connections.connect(salon.ownerId, credentials(salon.id), null, state.sessionHash);
      await client.query("COMMIT");
      await expect(pending).rejects.toThrow("Session is unavailable");
      await expect(store.connections.get(salon.ownerId, salon.id, "sandbox")).resolves.toBeNull();
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("encrypts merchant tokens, hides them in ordinary views, and survives restart", async () => {
    const first = await openStore();
    const salon = await business(first);
    const input = credentials(salon.id);
    const connected = await connect(first, salon.ownerId, input, null);
    expect(connected).not.toHaveProperty("accessToken");
    expect(connected).not.toHaveProperty("credentialCipher");
    const stored = await raw.query("SELECT row_to_json(c)::text AS stored FROM merchant_connections c WHERE business_id = $1", [salon.id]);
    expect(stored.rows[0].stored).not.toContain(input.accessToken);
    expect(stored.rows[0].stored).not.toContain(input.refreshToken);
    await first.close();
    const second = await openStore();
    await expect(second.connections.readCredentials(salon.id, "sandbox")).resolves.toMatchObject(input);
    await expect(second.connections.readCredentials(salon.id, "production")).resolves.toBeNull();
    await expect(second.connections.get("another-owner", salon.id, "sandbox")).resolves.toBeNull();
    await expect(connect(second, "another-owner", input, connected.version)).rejects.toThrow();
  });

  it("shares the existing deployment-key canary and rejects wrong keys at startup", async () => {
    const pilot = await openStore();
    const core = await createPostgresStore({ connectionString: scopedUrl, encryptionKey });
    await core.health();
    await core.close();
    await pilot.health();
    await expect(createPilotStore({ connectionString: scopedUrl, encryptionKey: randomBytes(32) })).rejects.toThrow("decrypt");
    await expect(createPilotStore({ connectionString: scopedUrl, encryptionKey: randomBytes(16) })).rejects.toThrow("32 bytes");
  });

  it("authenticates ciphertext against business, environment and merchant identity", async () => {
    const store = await openStore();
    const first = await business(store);
    const second = await business(store);
    await connect(store, first.ownerId, credentials(first.id), null);
    await connect(store, second.ownerId, credentials(second.id), null);
    await raw.query("UPDATE merchant_connections SET credential_cipher = (SELECT credential_cipher FROM merchant_connections WHERE business_id = $1) WHERE business_id = $2", [first.id, second.id]);
    await expect(store.connections.readCredentials(second.id, "sandbox")).rejects.toThrow("decrypt");
    await raw.query("UPDATE merchant_connections SET environment = 'production' WHERE business_id = $1", [first.id]);
    await expect(store.connections.readCredentials(first.id, "production")).rejects.toThrow("decrypt");
  });

  it("reserves each Square merchant for one business even under concurrent first connects", async () => {
    const first = await openStore();
    const second = await openStore();
    const a = await business(first);
    const b = await business(second);
    const input = credentials(a.id);
    const results = await Promise.allSettled([
      connect(first, a.ownerId, input, null),
      connect(second, b.ownerId, { ...input, businessId: b.id }, null),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("rejects merchant switches and stale OAuth callback generations", async () => {
    const store = await openStore();
    const salon = await business(store);
    const input = credentials(salon.id);
    const initial = await connect(store, salon.ownerId, input, null);
    await expect(connect(store, salon.ownerId, { ...input, merchantId: "different-merchant" }, initial.version)).rejects.toThrow("cannot switch");
    const next = await connect(store, salon.ownerId, { ...input, accessToken: "new-access-token" }, initial.version);
    expect(next.version).toBe(initial.version + 1);
    await expect(connect(store, salon.ownerId, input, initial.version)).rejects.toThrow("changed");
    await expect(connect(store, salon.ownerId, input, null)).rejects.toThrow("changed");
  });

  it("allows only one token refresh CAS and blocks reconnect/refresh races", async () => {
    const first = await openStore();
    const second = await openStore();
    const salon = await business(first);
    const input = credentials(salon.id);
    const initial = await connect(first, salon.ownerId, input, null);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? first : second).connections.replaceCredentials({ ...input, accessToken: `rotated-${i}` }, initial.version)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const next = results.find(Boolean)!;
    await expect(first.connections.markReconnect(salon.id, "sandbox", initial.version)).resolves.toBe(false);
    await expect(first.connections.markReconnect(salon.id, "sandbox", next.version)).resolves.toBe(true);
    await expect(first.connections.readCredentials(salon.id, "sandbox")).resolves.toBeNull();
    await expect(first.connections.replaceCredentials(input, next.version + 1)).resolves.toBeNull();
  });

  it("retains uncertain revocation claims through restart and prevents stale refresh/callback resurrection", async () => {
    const first = await openStore();
    const salon = await business(first);
    const input = credentials(salon.id);
    const initial = await connect(first, salon.ownerId, input, null);
    await first.businesses.update(salon.ownerId, salon.id, { status: "active" });
    await expect(first.connections.beginDisconnect("another-owner", salon.id, "sandbox")).resolves.toBeNull();
    const pending = (await first.connections.beginDisconnect(salon.ownerId, salon.id, "sandbox"))!;
    expect(pending.status).toBe("disconnecting");
    expect(pending.version).toBe(initial.version + 1);
    await expect(first.connections.readCredentials(salon.id, "sandbox")).resolves.toBeNull();
    await expect(first.connections.replaceCredentials(input, initial.version)).resolves.toBeNull();
    await expect(first.connections.replaceCredentials(input, pending.version)).resolves.toBeNull();
    await expect(connect(first, salon.ownerId, input, pending.version)).rejects.toThrow("disconnection must finish");
    await expect(first.businesses.get(salon.ownerId, salon.id)).resolves.toMatchObject({ status: "paused" });
    await first.close();
    const second = await openStore();
    await expect(second.connections.beginDisconnect(salon.ownerId, salon.id, "sandbox")).resolves.toBeNull();
    expect(await second.connections.listPendingRevocations()).toContainEqual(expect.objectContaining({ businessId: salon.id, status: "disconnecting" }));
    await expect(second.connections.finishDisconnect("another-owner", salon.id, "sandbox", pending.version)).resolves.toBe(false);
    await expect(second.connections.finishDisconnect(salon.ownerId, salon.id, "sandbox", initial.version)).resolves.toBe(false);
    await expect(second.connections.finishDisconnect(salon.ownerId, salon.id, "sandbox", pending.version)).resolves.toBe(true);
    const { rows } = await raw.query("SELECT status, credential_cipher FROM merchant_connections WHERE business_id = $1", [salon.id]);
    expect(rows[0]).toEqual({ status: "disconnected", credential_cipher: null });
    await expect(connect(second, salon.ownerId, input, initial.version)).rejects.toThrow("changed");
    await expect(second.connections.beginDisconnect(salon.ownerId, salon.id, "sandbox")).resolves.toBeNull();
    await expect(connect(second, salon.ownerId, input, pending.version + 1)).resolves.toMatchObject({ status: "connected" });
  });

  it("gives revocation credentials to exactly one claimant across server instances", async () => {
    const first = await openStore();
    const second = await openStore();
    const salon = await business(first);
    const input = credentials(salon.id);
    const initial = await connect(first, salon.ownerId, input, null);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
      (i % 2 ? first : second).connections.beginDisconnect(salon.ownerId, salon.id, "sandbox")));
    expect(results.filter(Boolean)).toHaveLength(1);
    const pending = results.find(Boolean)!;
    expect(pending.version).toBe(initial.version + 1);
    await expect(second.connections.beginDisconnect(salon.ownerId, salon.id, "sandbox")).resolves.toBeNull();
    await expect(connect(second, salon.ownerId, input, pending.version)).rejects.toThrow("disconnection must finish");
    // Until the sole remote attempt definitely succeeds, another callback cannot install a grant.
    await expect(first.connections.finishDisconnect(salon.ownerId, salon.id, "sandbox", pending.version)).resolves.toBe(true);
    const fresh = await connect(second, salon.ownerId, { ...input, accessToken: "fresh-grant" }, pending.version + 1);
    await expect(first.connections.finishDisconnect(salon.ownerId, salon.id, "sandbox", pending.version)).resolves.toBe(false);
    await expect(first.connections.readCredentials(salon.id, "sandbox")).resolves.toMatchObject({ accessToken: "fresh-grant", version: fresh.version });
  });

  it("blocks credential and public-business lookup after owner soft deletion", async () => {
    const store = await openStore();
    const salon = await business(store);
    const input = credentials(salon.id);
    const connector = { id: randomUUID(), userId: salon.ownerId, tokenHash: hash(), label: "Muse" };
    await store.connectors.issue(connector);
    await connect(store, salon.ownerId, input, null);
    await store.businesses.update(salon.ownerId, salon.id, { status: "active" });
    await raw.query("UPDATE users SET deleted_at = now() WHERE id = $1", [salon.ownerId]);
    await expect(store.connections.readCredentials(salon.id, "sandbox")).resolves.toBeNull();
    await expect(store.connectors.lookup(connector.tokenHash)).resolves.toBeNull();
    await expect(store.businesses.getById(salon.id)).resolves.toBeNull();
    expect((await store.businesses.listActive()).some((row) => row.id === salon.id)).toBe(false);
  });

  it("keeps expired access tokens available for server-only refresh", async () => {
    const store = await openStore();
    const salon = await business(store);
    const input = { ...credentials(salon.id), expiresAt: new Date(0) };
    await connect(store, salon.ownerId, input, null);
    await expect(store.connections.readCredentials(salon.id, "sandbox")).resolves.toMatchObject({ accessToken: input.accessToken, expiresAt: new Date(0) });
  });

  it("enforces the exact shared fixed-window request limit under concurrency", async () => {
    const first = await openStore();
    const second = await openStore();
    const input = { keyHash: hash(), limit: 7, windowMs: 60_000, now: new Date("2030-01-01T12:00:30Z") };
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? first : second).rateLimits.take(input)));
    expect(results.filter(Boolean)).toHaveLength(7);
    await expect(first.rateLimits.take(input)).resolves.toBe(false);
    await expect(first.rateLimits.take({ ...input, now: new Date("2030-01-01T12:01:00Z") })).resolves.toBe(true);
    await expect(first.rateLimits.take({ ...input, keyHash: hash() })).resolves.toBe(true);
  });
});
