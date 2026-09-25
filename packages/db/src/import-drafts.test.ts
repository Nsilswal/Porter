import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createPilotStore } from "./pilot.js";
import { migratePostgres } from "./migrations.js";
import type { PilotStore } from "./pilot-types.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const encryptionKey = randomBytes(32);
const schemaName = `porter_import_${randomUUID().replaceAll("-", "")}`;
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

async function owner(store: PilotStore) {
  const identity = await store.identities.getOrCreate(`${randomUUID()}@example.test`);
  const tokenHash = hash();
  const browserNonceHash = hash();
  await store.loginTokens.issue({ tokenHash, browserNonceHash, userId: identity.userId, expiresAt: future() });
  const session = (await store.loginTokens.consume({ tokenHash, browserNonceHash, sessionHash: hash(), sessionExpiresAt: future(), now: new Date() }))!;
  return { ownerId: identity.userId, sessionHash: session.sessionHash };
}

function draft() {
  return { tokenHash: hash(), browserNonceHash: hash(), sourceUrl: "https://salon.example.test/", expiresAt: future(),
    preview: { submittedUrl: "https://salon.example.test/", sourceUrl: "https://www.salon.example.test/", name: "Imported Salon",
      services: [{ name: "Haircut", sourceUrl: "https://www.salon.example.test/", priceText: "$65" }], warnings: ["Review imported details"] } };
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

describe.runIf(Boolean(databaseUrl))("durable anonymous import drafts", () => {
  it("persists a browser-bound preview across restart without storing raw credentials", async () => {
    const first = await openStore();
    const token = randomUUID();
    const browserNonce = randomUUID();
    const input = { ...draft(), tokenHash: hash(token), browserNonceHash: hash(browserNonce) };
    await first.imports.put(input);
    await expect(first.imports.get(input.tokenHash, hash(), new Date())).resolves.toBeNull();
    await expect(first.imports.get(hash(), input.browserNonceHash, new Date())).resolves.toBeNull();
    await expect(first.imports.get(input.tokenHash, input.browserNonceHash, new Date())).resolves.toEqual(input.preview);
    await first.close();
    const second = await openStore();
    await expect(second.imports.get(input.tokenHash, input.browserNonceHash, new Date())).resolves.toEqual(input.preview);
    const { rows } = await raw.query("SELECT row_to_json(d)::text AS stored FROM import_drafts d WHERE token_hash = $1", [input.tokenHash]);
    expect(rows[0].stored).not.toContain(token);
    expect(rows[0].stored).not.toContain(browserNonce);
    expect((await raw.query("SELECT count(*)::int AS count FROM pilot_businesses")).rows[0].count).toBe(0);
  });

  it("rejects raw token material, invalid source URLs, oversized UTF-8 previews and nonobjects", async () => {
    const store = await openStore();
    const input = draft();
    await expect(store.imports.put({ ...input, tokenHash: "raw-token" })).rejects.toThrow("SHA-256");
    await expect(store.imports.put({ ...input, browserNonceHash: "raw-browser-cookie" })).rejects.toThrow("SHA-256");
    for (const sourceUrl of ["javascript:alert(1)", "file:///tmp/private", "https://user:password@example.test/", "not-a-url"]) {
      await expect(store.imports.put({ ...input, sourceUrl })).rejects.toThrow();
    }
    await expect(store.imports.put({ ...input, preview: { description: "😀".repeat(20_000) } })).rejects.toThrow("64 KiB");
    await expect(store.imports.put({ ...input, preview: [] as unknown as Record<string, unknown> })).rejects.toThrow("JSON object");
    await expect(store.imports.put({ ...input, preview: { toJSON: () => "unexpected" } })).rejects.toThrow("JSON object");
    await expect(store.imports.get(input.tokenHash, input.browserNonceHash, new Date())).resolves.toBeNull();
  });

  it("retains the original snapshot and rejects overwriting an existing draft token", async () => {
    const store = await openStore();
    const input = draft();
    const original = structuredClone(input.preview);
    await store.imports.put(input);
    input.preview.name = "Changed after save";
    await expect(store.imports.put({ ...input, sourceUrl: "https://other.example.test/" })).rejects.toThrow();
    await expect(store.imports.get(input.tokenHash, input.browserNonceHash, new Date())).resolves.toEqual(original);
  });

  it("hides expired drafts and refuses to claim them", async () => {
    const store = await openStore();
    const input = draft();
    const identity = await owner(store);
    await store.imports.put(input);
    const now = input.expiresAt;
    await expect(store.imports.get(input.tokenHash, input.browserNonceHash, now)).resolves.toBeNull();
    await expect(store.imports.claim({ ...input, ...identity, businessId: randomUUID(), name: "Salon", now })).resolves.toBeNull();
    expect((await store.businesses.list(identity.ownerId))).toEqual([]);
  });

  it("claims one business with the saved URL and retained import provenance", async () => {
    const store = await openStore();
    const input = draft();
    const identity = await owner(store);
    await store.imports.put(input);
    const businessId = randomUUID();
    const claimed = await store.imports.claim({ ...input, ...identity, businessId, name: "Owner-reviewed salon name", now: new Date() });
    expect(claimed).toMatchObject({ id: businessId, ownerId: identity.ownerId, name: "Owner-reviewed salon name", websiteUrl: input.sourceUrl,
      profile: { imported: input.preview }, status: "draft", selectedLocationId: null });
    await expect(store.imports.get(input.tokenHash, input.browserNonceHash, new Date())).resolves.toBeNull();
    const other = await owner(store);
    await expect(store.imports.claim({ ...input, ...other, businessId: randomUUID(), name: "Other owner", now: new Date() })).resolves.toBeNull();
    await expect(store.imports.claim({ ...input, ...identity, browserNonceHash: hash(), businessId: randomUUID(), name: "Wrong browser", now: new Date() })).resolves.toBeNull();
    await expect(store.imports.claim({ ...input, ...identity, businessId: randomUUID(), name: "Retry cannot replace name", now: new Date() })).resolves.toEqual(claimed);
  });

  it("replays concurrent same-owner claims across instances with one business", async () => {
    const first = await openStore();
    const second = await openStore();
    const input = draft();
    const identity = await owner(first);
    await first.imports.put(input);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? first : second).imports.claim({
      ...input, ...identity, businessId: randomUUID(), name: `Salon ${i}`, now: new Date(),
    })));
    expect(results.every(Boolean)).toBe(true);
    expect(new Set(results.map((business) => business!.id)).size).toBe(1);
    expect(await first.businesses.list(identity.ownerId)).toHaveLength(1);
  });

  it("allows only one owner to win a simultaneous draft claim", async () => {
    const first = await openStore();
    const second = await openStore();
    const input = draft();
    const a = await owner(first);
    const b = await owner(second);
    await first.imports.put(input);
    const results = await Promise.all([
      first.imports.claim({ ...input, ...a, businessId: randomUUID(), name: "Owner A", now: new Date() }),
      second.imports.claim({ ...input, ...b, businessId: randomUUID(), name: "Owner B", now: new Date() }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await first.businesses.list(a.ownerId)).length + (await second.businesses.list(b.ownerId)).length).toBe(1);
  });

  it("requires the current owner's live session even when replaying a claimed draft", async () => {
    const store = await openStore();
    const input = draft();
    const identity = await owner(store);
    const other = await owner(store);
    await store.imports.put(input);
    const claim = { ...input, ...identity, businessId: randomUUID(), name: "Salon", now: new Date() };
    await expect(store.imports.claim({ ...claim, sessionHash: other.sessionHash })).resolves.toBeNull();
    await expect(store.imports.claim(claim)).resolves.toBeTruthy();
    await store.sessions.revoke(identity.ownerId, identity.sessionHash);
    await expect(store.imports.claim(claim)).resolves.toBeNull();
  });

  it("blocks expired sessions and deleted owners without spending the draft", async () => {
    const store = await openStore();
    const expired = await owner(store);
    const input = draft();
    await store.imports.put(input);
    await raw.query("UPDATE pilot_sessions SET expires_at = now() - interval '1 second' WHERE session_hash = $1", [expired.sessionHash]);
    await expect(store.imports.claim({ ...input, ...expired, businessId: randomUUID(), name: "Salon", now: new Date() })).resolves.toBeNull();
    const deleted = await owner(store);
    await raw.query("UPDATE users SET deleted_at = now() WHERE id = $1", [deleted.ownerId]);
    await expect(store.imports.claim({ ...input, ...deleted, businessId: randomUUID(), name: "Salon", now: new Date() })).resolves.toBeNull();
    await expect(store.imports.get(input.tokenHash, input.browserNonceHash, new Date())).resolves.toEqual(input.preview);
  });

  it("serializes a claim with concurrent logout", async () => {
    const store = await openStore();
    const identity = await owner(store);
    const input = draft();
    await store.imports.put(input);
    const client = await raw.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE pilot_sessions SET revoked_at = now() WHERE session_hash = $1", [identity.sessionHash]);
      const pending = store.imports.claim({ ...input, ...identity, businessId: randomUUID(), name: "Salon", now: new Date() });
      await client.query("COMMIT");
      await expect(pending).resolves.toBeNull();
      await expect(store.imports.get(input.tokenHash, input.browserNonceHash, new Date())).resolves.toEqual(input.preview);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("rolls back claiming when business creation fails", async () => {
    const store = await openStore();
    const identity = await owner(store);
    const existing = await store.businesses.create({ id: randomUUID(), ownerId: identity.ownerId, name: "Existing", websiteUrl: "https://existing.example.test/" });
    const input = draft();
    await store.imports.put(input);
    const claim = { ...input, ...identity, businessId: existing.id, name: "New Salon", now: new Date() };
    await expect(store.imports.claim(claim)).rejects.toThrow();
    await expect(store.imports.get(input.tokenHash, input.browserNonceHash, new Date())).resolves.toEqual(input.preview);
    await expect(store.imports.claim({ ...claim, businessId: randomUUID() })).resolves.toMatchObject({ name: "New Salon" });
    expect(await store.businesses.list(identity.ownerId)).toHaveLength(2);
  });
});
