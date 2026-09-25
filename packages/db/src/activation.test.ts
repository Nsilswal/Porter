import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createPilotStore } from "./pilot.js";
import { migratePostgres } from "./migrations.js";
import type { PilotStore } from "./pilot-types.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const encryptionKey = randomBytes(32);
const schemaName = `porter_activate_${randomUUID().replaceAll("-", "")}`;
const stores: PilotStore[] = [];
let scopedUrl: string;
let admin: Pool;
let raw: Pool;
const hash = (value = randomUUID()) => createHash("sha256").update(value).digest("hex");
const future = () => new Date(Date.now() + 86_400_000);

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
  await raw?.end();
  if (admin) {
    await admin.query(`DROP SCHEMA ${schemaName} CASCADE`);
    await admin.end();
  }
});

async function fixture(options: { selectLocation?: boolean; connect?: boolean } = {}) {
  const store = await openStore();
  const owner = await store.identities.getOrCreate(`${randomUUID()}@example.test`);
  const tokenHash = hash();
  const browserNonceHash = hash();
  await store.loginTokens.issue({ tokenHash, browserNonceHash, userId: owner.userId, expiresAt: future() });
  const session = (await store.loginTokens.consume({ tokenHash, browserNonceHash, sessionHash: hash(), sessionExpiresAt: future(), now: new Date() }))!;
  let business = await store.businesses.create({ id: randomUUID(), ownerId: owner.userId, name: "Salon", websiteUrl: "https://salon.example.test/", profile: { imported: { name: "Imported Salon" } } });
  business = (await store.businesses.update(owner.userId, business.id, options.selectLocation === false ? { name: "Salon" } : { selectedLocationId: "LOCATION" }))!;
  const credentials = { businessId: business.id, environment: "sandbox" as const, merchantId: randomUUID(), accessToken: "access-test", refreshToken: "refresh-test", expiresAt: future(), scopes: [] };
  const connection = options.connect === false ? null : await store.connections.connect(owner.userId, credentials, null, session.sessionHash);
  const input = { ownerId: owner.userId, sessionHash: session.sessionHash, businessId: business.id, environment: "sandbox" as const,
    connectionVersion: connection?.version ?? 1, expectedUpdatedAt: business.updatedAt, name: "Reviewed Salon", now: new Date(),
    profile: { ...business.profile, enabledServiceIds: ["SERVICE"], policyReviewed: true, noPaymentObligations: true } };
  return { store, owner, session, business, credentials, connection, input };
}

describe.runIf(Boolean(databaseUrl))("transactional business activation", () => {
  it("persists the reviewed name/profile while preserving business ownership, URL and selected location", async () => {
    const f = await fixture();
    const result = await f.store.businesses.activate(f.input);
    expect(result).toMatchObject({ id: f.business.id, ownerId: f.owner.userId, websiteUrl: f.business.websiteUrl, selectedLocationId: "LOCATION",
      name: "Reviewed Salon", status: "active", profile: f.input.profile });
    expect(result!.updatedAt.getTime()).toBeGreaterThan(f.business.updatedAt.getTime());
    await expect(f.store.businesses.get(f.owner.userId, f.business.id)).resolves.toEqual(result);
  });

  it("allows exactly one committed activation for a reviewed business snapshot under contention", async () => {
    const f = await fixture();
    const second = await openStore();
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? f.store : second).businesses.activate(f.input)));
    expect(results.filter(Boolean)).toHaveLength(1);
    await expect(second.businesses.activate(f.input)).resolves.toBeNull();
  });

  it("rejects a business edited or paused after the review snapshot", async () => {
    for (const changes of [{ name: "New name" }, { status: "paused" as const }, { profile: { description: "Changed" } }]) {
      const f = await fixture();
      const updated = await f.store.businesses.update(f.owner.userId, f.business.id, changes);
      await expect(f.store.businesses.activate(f.input)).resolves.toBeNull();
      await expect(f.store.businesses.get(f.owner.userId, f.business.id)).resolves.toEqual(updated);
    }
  });

  it("advances the CAS timestamp even when successive writes share a millisecond or the clock moves backwards", async () => {
    const f = await fixture();
    const futureTimestamp = new Date("2100-01-01T00:00:00.000Z");
    await raw.query("UPDATE pilot_businesses SET updated_at = $1 WHERE id = $2", [futureTimestamp, f.business.id]);
    const first = (await f.store.businesses.update(f.owner.userId, f.business.id, { name: "First" }))!;
    const second = (await f.store.businesses.update(f.owner.userId, f.business.id, { name: "Second" }))!;
    expect(first.updatedAt.getTime()).toBe(futureTimestamp.getTime() + 1);
    expect(second.updatedAt.getTime()).toBe(futureTimestamp.getTime() + 2);
    await expect(f.store.businesses.activate({ ...f.input, expectedUpdatedAt: first.updatedAt })).resolves.toBeNull();
    const activated = await f.store.businesses.activate({ ...f.input, expectedUpdatedAt: second.updatedAt });
    expect(activated!.updatedAt.getTime()).toBe(futureTimestamp.getTime() + 3);
  });

  it("requires a selected location and a connected grant for the reviewed environment", async () => {
    const missingLocation = await fixture({ selectLocation: false });
    await expect(missingLocation.store.businesses.activate(missingLocation.input)).resolves.toBeNull();
    const missingConnection = await fixture({ connect: false });
    await expect(missingConnection.store.businesses.activate(missingConnection.input)).resolves.toBeNull();
    const wrongEnvironment = await fixture();
    await expect(wrongEnvironment.store.businesses.activate({ ...wrongEnvironment.input, environment: "production" })).resolves.toBeNull();
  });

  it("rejects a refreshed, expired, reconnect-required or disconnecting connection", async () => {
    const refreshed = await fixture();
    await refreshed.store.connections.replaceCredentials({ ...refreshed.credentials, accessToken: "changed-token" }, refreshed.input.connectionVersion);
    await expect(refreshed.store.businesses.activate(refreshed.input)).resolves.toBeNull();
    const expired = await fixture();
    const changed = (await expired.store.connections.replaceCredentials({ ...expired.credentials, expiresAt: new Date(0) }, expired.input.connectionVersion))!;
    await expect(expired.store.businesses.activate({ ...expired.input, connectionVersion: changed.version })).resolves.toBeNull();
    const reconnect = await fixture();
    await reconnect.store.connections.markReconnect(reconnect.business.id, "sandbox", reconnect.input.connectionVersion);
    await expect(reconnect.store.businesses.activate({ ...reconnect.input, connectionVersion: reconnect.input.connectionVersion + 1 })).resolves.toBeNull();
    const disconnected = await fixture();
    await disconnected.store.connections.beginDisconnect(disconnected.owner.userId, disconnected.business.id, "sandbox");
    const paused = (await disconnected.store.businesses.get(disconnected.owner.userId, disconnected.business.id))!;
    await expect(disconnected.store.businesses.activate({ ...disconnected.input, connectionVersion: disconnected.input.connectionVersion + 1, expectedUpdatedAt: paused.updatedAt })).resolves.toBeNull();
  });

  it("requires the current owner and a live matching session", async () => {
    const f = await fixture();
    const other = await fixture();
    await expect(f.store.businesses.activate({ ...f.input, ownerId: other.owner.userId, sessionHash: other.session.sessionHash })).resolves.toBeNull();
    await expect(f.store.businesses.activate({ ...f.input, sessionHash: other.session.sessionHash })).resolves.toBeNull();
    await f.store.sessions.revoke(f.owner.userId, f.session.sessionHash);
    await expect(f.store.businesses.activate(f.input)).resolves.toBeNull();
    const deleted = await fixture();
    await raw.query("UPDATE users SET deleted_at = now() WHERE id = $1", [deleted.owner.userId]);
    await expect(deleted.store.businesses.activate(deleted.input)).resolves.toBeNull();
    const expired = await fixture();
    await raw.query("UPDATE pilot_sessions SET expires_at = now() - interval '1 second' WHERE session_hash = $1", [expired.session.sessionHash]);
    await expect(expired.store.businesses.activate({ ...expired.input, now: new Date() })).resolves.toBeNull();
  });

  it("serializes activation with concurrent logout", async () => {
    const f = await fixture();
    const client = await raw.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE pilot_sessions SET revoked_at = now() WHERE session_hash = $1", [f.session.sessionHash]);
      const pending = f.store.businesses.activate(f.input);
      await client.query("COMMIT");
      await expect(pending).resolves.toBeNull();
      await expect(f.store.businesses.get(f.owner.userId, f.business.id)).resolves.toMatchObject({ status: "draft" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("serializes activation with a concurrent pause and keeps the reviewed state unchanged", async () => {
    const f = await fixture();
    const client = await raw.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE pilot_businesses SET status = 'paused', updated_at = updated_at + interval '1 millisecond' WHERE id = $1", [f.business.id]);
      const pending = f.store.businesses.activate(f.input);
      await client.query("COMMIT");
      await expect(pending).resolves.toBeNull();
      await expect(f.store.businesses.get(f.owner.userId, f.business.id)).resolves.toMatchObject({ status: "paused", name: f.business.name, profile: f.business.profile });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("always ends paused when activation races with a real disconnect from another instance", async () => {
    const f = await fixture();
    const second = await openStore();
    const results = await Promise.all([
      f.store.businesses.activate(f.input),
      second.connections.beginDisconnect(f.owner.userId, f.business.id, "sandbox"),
    ]);
    expect(results[1]).toMatchObject({ status: "disconnecting" });
    await expect(f.store.businesses.get(f.owner.userId, f.business.id)).resolves.toMatchObject({ status: "paused" });
    await expect(second.connections.readCredentials(f.business.id, "sandbox")).resolves.toBeNull();
  });

  it("requires a validated nonempty service selection and both policy attestations", async () => {
    const f = await fixture();
    for (const changes of [{ policyReviewed: false }, { noPaymentObligations: false }, { enabledServiceIds: [] },
      { enabledServiceIds: ["SERVICE", "SERVICE"] }, { enabledServiceIds: ["../other"] }]) {
      await expect(f.store.businesses.activate({ ...f.input, profile: { ...f.input.profile, ...changes } })).rejects.toThrow("validated service and policy review");
    }
    await expect(f.store.businesses.get(f.owner.userId, f.business.id)).resolves.toMatchObject({ status: "draft" });
  });
});
