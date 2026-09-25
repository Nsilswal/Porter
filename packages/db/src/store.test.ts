import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getTableColumns, getTableName } from "drizzle-orm";
import { decryptWithKey, encryptWithKey, type AuditRecord, type IdempotencyOperation, type IdempotencyRecord, type PaymentRecord, type Store, type StoredBooking } from "@porter/core";
import { createMemoryStore } from "./memory.js";
import { createPostgresStore, type PostgresStore } from "./postgres.js";
import { migratePostgres } from "./migrations.js";
import * as schema from "./schema.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const encryptionKey = randomBytes(32);
let scopedUrl: string;
let admin: Pool;
const schemaName = `porter_test_${randomUUID().replaceAll("-", "")}`;
const operation: IdempotencyOperation = { adapterId: "square", providerId: "salon", providerOperation: "create", idempotencyKey: "provider-key" };

beforeAll(async () => {
  if (!databaseUrl) return;
  admin = new Pool({ connectionString: databaseUrl, max: 2 });
  await admin.query(`CREATE SCHEMA ${schemaName}`);
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schemaName}`);
  scopedUrl = url.toString();
  await Promise.all([migratePostgres(scopedUrl), migratePostgres(scopedUrl)]);
});

afterAll(async () => {
  if (!admin) return;
  await admin.query(`DROP SCHEMA ${schemaName} CASCADE`);
  await admin.end();
});

function booking(userId: string = randomUUID(), id: string = randomUUID()): StoredBooking {
  return {
    id, userId, adapterId: "square", providerBookingRef: randomUUID(), status: "confirmed",
    startsAt: new Date("2027-01-05T14:00:00Z"), endsAt: new Date("2027-01-05T14:30:00Z"),
    providerId: "salon", locationId: "location", serviceId: "haircut", providerName: "Example Salon", serviceName: "Haircut",
    priceMinor: 8000, currency: "USD", depositMinor: null, paidMinor: 0,
    createdAt: new Date("2026-09-24T12:00:00Z"), updatedAt: new Date("2026-09-24T12:00:00Z"),
  };
}

function reservation(userId: string = randomUUID(), tool = "create_booking", key: string = randomUUID()): Omit<IdempotencyRecord, "responseCipher" | "state" | "operation"> & { state: "in_flight" } {
  // Deliberately expired relative to wall time: these must remain reservations.
  return { userId, tool, key, argsHash: "request-hash", state: "in_flight", createdAt: new Date("2000-01-01"), expiresAt: new Date("2000-01-02") };
}

function payment(row: StoredBooking): PaymentRecord {
  return {
    id: randomUUID(), userId: row.userId, bookingId: row.id, gatewayId: "stripe", gatewayPaymentRef: randomUUID(),
    amountMinor: 8000, currency: "USD", kind: "total", status: "succeeded", createdAt: row.createdAt,
  };
}

for (const mode of ["memory", "postgres"] as const) {
  describe.runIf(mode === "memory" || Boolean(databaseUrl))(`${mode} storage contract`, () => {
    let store: Store;
    beforeEach(async () => {
      store = mode === "memory" ? createMemoryStore() : await createPostgresStore({ connectionString: scopedUrl, encryptionKey });
    });
    afterEach(async () => {
      if (mode === "postgres") await (store as PostgresStore | undefined)?.close();
    });

    it("preserves booking ownership and provider identity when updating", async () => {
      const row = booking();
      await store.bookings.put(row);
      await expect(store.bookings.get("someone-else", row.id)).resolves.toBeNull();
      await expect(store.bookings.put({ ...row, userId: "someone-else" })).rejects.toThrow();
      await expect(store.bookings.put({ ...row, adapterId: "other" })).rejects.toThrow();
      await expect(store.bookings.put({ ...row, id: randomUUID() })).rejects.toThrow();
      await store.bookings.put({ ...row, status: "cancelled", createdAt: new Date("2026-09-25") });
      await expect(store.bookings.get(row.userId, row.id)).resolves.toEqual({ ...row, status: "cancelled" });
      await expect(store.bookings.list(row.userId, "confirmed")).resolves.toEqual([]);
      await expect(store.bookings.list(row.userId, "cancelled")).resolves.toHaveLength(1);
    });

    it("reserves once under contention and never discards an expired reservation", async () => {
      const record = reservation();
      const results = await Promise.all(Array.from({ length: 20 }, () => store.idempotency.reserve(record)));
      expect(results.filter((result) => result === null)).toHaveLength(1);
      expect(results.filter((result) => result?.state === "in_flight")).toHaveLength(19);
      await expect(store.idempotency.reserve(record)).resolves.toMatchObject({ argsHash: record.argsHash });
      await store.idempotency.complete(record.userId, record.tool, record.key, "encrypted-result");
      await store.idempotency.release(record.userId, record.tool, record.key);
      await expect(store.idempotency.reserve(record)).resolves.toMatchObject({ state: "completed", responseCipher: "encrypted-result" });
    });

    it("keeps uncertain operations and refuses invalid transitions", async () => {
      const record = reservation();
      await expect(store.idempotency.complete(record.userId, record.tool, record.key, "cipher")).rejects.toThrow();
      await expect(store.idempotency.markUncertain(record.userId, record.tool, record.key, operation)).rejects.toThrow();
      await store.idempotency.reserve(record);
      await store.idempotency.markUncertain(record.userId, record.tool, record.key, operation);
      await store.idempotency.markUncertain(record.userId, record.tool, record.key, operation);
      await expect(store.idempotency.markUncertain(record.userId, record.tool, record.key, { ...operation, providerId: "other" })).rejects.toThrow();
      await store.idempotency.release(record.userId, record.tool, record.key);
      await expect(store.idempotency.reserve(record)).resolves.toMatchObject({ state: "uncertain", operation });
      await store.idempotency.complete(record.userId, record.tool, record.key, "cipher");
      await store.idempotency.complete(record.userId, record.tool, record.key, "cipher");
      await expect(store.idempotency.complete(record.userId, record.tool, record.key, "different-cipher")).rejects.toThrow();
      await expect(store.idempotency.markUncertain(record.userId, record.tool, record.key, operation)).rejects.toThrow();
    });

    it("releases only a safe pre-write reservation and separates composite keys", async () => {
      const userId = randomUUID();
      const first = reservation(`${userId}|other`, "tool", "key");
      const second = reservation(userId, "other|tool", "key");
      await expect(store.idempotency.reserve(first)).resolves.toBeNull();
      await expect(store.idempotency.reserve(second)).resolves.toBeNull();
      await store.idempotency.release(first.userId, first.tool, first.key);
      await expect(store.idempotency.get(first.userId, first.tool, first.key)).resolves.toBeNull();
      await expect(store.idempotency.get(second.userId, second.tool, second.key)).resolves.not.toBeNull();
      await expect(store.idempotency.deleteAllForUser(userId)).resolves.toBe(1);
    });

    it("consumes a confirmation once under concurrent requests", async () => {
      const jti = randomUUID();
      const expiry = new Date("2100-01-01");
      const results = await Promise.all(Array.from({ length: 20 }, () => store.confirmations.consume(jti, expiry)));
      expect(results.filter(Boolean)).toHaveLength(1);
      await store.confirmations.deleteExpired(new Date("2099-01-01"));
      await expect(store.confirmations.consume(jti, expiry)).resolves.toBe(false);
      await store.confirmations.deleteExpired(expiry);
      await expect(store.confirmations.consume(jti, expiry)).resolves.toBe(true);
    });

    it("returns the same user key across concurrent calls and destroys old ciphertext access", async () => {
      const userId = randomUUID();
      const keys = await Promise.all(Array.from({ length: 20 }, () => store.keys.getOrCreate(userId)));
      expect(new Set(keys.map((key) => key.toString("hex"))).size).toBe(1);
      const ciphertext = encryptWithKey(keys[0]!, "private booking result");
      await store.keys.destroy(userId);
      const replacement = await store.keys.getOrCreate(userId);
      expect(() => decryptWithKey(replacement, ciphertext)).toThrow();
    });

    it("keeps payments scoped to their original owner and booking", async () => {
      const row = booking();
      await store.bookings.put(row);
      const record = payment(row);
      await expect(store.payments.put({ ...record, userId: "other" })).rejects.toThrow();
      await store.payments.put(record);
      await expect(store.payments.listForBooking("other", row.id)).resolves.toEqual([]);
      await expect(store.payments.put({ ...record, userId: "other" })).rejects.toThrow();
      await expect(store.payments.put({ ...record, bookingId: "other" })).rejects.toThrow();
      await store.payments.put({ ...record, status: "refunded" });
      await expect(store.payments.listForUser(row.userId)).resolves.toEqual([{ ...record, status: "refunded" }]);
      await expect(store.payments.deleteAllForUser(row.userId)).resolves.toBe(1);
      await expect(store.bookings.deleteAllForUser(row.userId)).resolves.toBe(1);
    });

    it("cascades payment removal when the booking is deleted directly", async () => {
      const row = booking();
      await store.bookings.put(row);
      await store.payments.put(payment(row));
      await store.bookings.deleteAllForUser(row.userId);
      await expect(store.payments.listForUser(row.userId)).resolves.toEqual([]);
    });

    it("serializes distinct operations on the same booking and releases only the exact owner", async () => {
      const row = booking();
      await store.bookings.put(row);
      const claims = await Promise.all(Array.from({ length: 20 }, (_, i) => store.bookingMutations.acquire(row.userId, row.id, "pay_or_deposit", `request-${i}`)));
      expect(claims.filter(Boolean)).toHaveLength(1);
      const ownerKey = `request-${claims.indexOf(true)}`;
      await store.bookingMutations.release(row.userId, row.id, "cancel_booking", ownerKey);
      await store.bookingMutations.release(row.userId, row.id, "pay_or_deposit", "wrong-key");
      await store.bookingMutations.release("another-user", row.id, "pay_or_deposit", ownerKey);
      await expect(store.bookingMutations.acquire(row.userId, row.id, "reschedule_booking", "other")).resolves.toBe(false);
      await expect(store.bookingMutations.acquire("another-user", row.id, "cancel_booking", "other")).rejects.toThrow();
      await store.bookingMutations.release(row.userId, row.id, "pay_or_deposit", ownerKey);
      await expect(store.bookingMutations.acquire(row.userId, row.id, "cancel_booking", "next")).resolves.toBe(true);
      await expect(store.bookingMutations.acquire(row.userId, row.id, "cancel_booking", "next")).resolves.toBe(false);
    });

    it("allows independent bookings and removes their guards on booking deletion", async () => {
      const first = booking();
      const second = booking(first.userId);
      await store.bookings.put(first);
      await store.bookings.put(second);
      await expect(store.bookingMutations.acquire(first.userId, first.id, "cancel_booking", "same-key")).resolves.toBe(true);
      await expect(store.bookingMutations.acquire(second.userId, second.id, "cancel_booking", "same-key")).resolves.toBe(true);
      await store.bookings.deleteAllForUser(first.userId);
      await store.bookings.put(first);
      await expect(store.bookingMutations.acquire(first.userId, first.id, "cancel_booking", "new-key")).resolves.toBe(true);
    });

    it("stores scoped payment profiles and append-only audit entries", async () => {
      const userId = randomUUID();
      const profile = { customerRef: "customer", paymentMethodRef: "method", label: "Visa ending 4242" };
      await store.paymentProfiles.put(userId, profile);
      await expect(store.paymentProfiles.get(userId)).resolves.toEqual(profile);
      await expect(store.paymentProfiles.get("other")).resolves.toBeNull();
      const record: AuditRecord = {
        at: new Date(), actorId: userId, tool: "create_booking", action: "commit", adapterId: "square", providerId: "salon",
        argsHash: "hash", idempotencyKey: "key", confirmationJti: null, outcome: "ok", errorCode: null, latencyMs: 20, disclosedFields: ["givenName"],
      };
      await store.audit.append({ ...record, seq: 999 });
      await store.audit.append({ ...record, argsHash: "new-hash" });
      const entries = await store.audit.list(userId, 1);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ argsHash: "new-hash" });
      await expect(store.audit.list("other")).resolves.toEqual([]);
      await expect(store.audit.list(userId, 0)).resolves.toEqual([]);
      await expect(store.audit.list(userId, -1)).rejects.toThrow();
      await expect(store.paymentProfiles.deleteAllForUser(userId)).resolves.toBe(1);
      await expect(store.audit.list(userId)).resolves.toHaveLength(2);
    });
  });
}

describe.runIf(Boolean(databaseUrl))("PostgreSQL durability and encryption", () => {
  const stores: PostgresStore[] = [];
  const pools: Pool[] = [];
  async function openStore() {
    const store = await createPostgresStore({ connectionString: scopedUrl, encryptionKey });
    stores.push(store);
    return store;
  }
  afterEach(async () => {
    await Promise.all(stores.splice(0).map((store) => store.close()));
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
  });

  it("keeps the migration's tables and columns aligned with the typed schema", async () => {
    const pool = new Pool({ connectionString: scopedUrl });
    pools.push(pool);
    const { rows } = await pool.query<{ table_name: string; column_name: string; is_nullable: string; data_type: string }>(
      "SELECT table_name, column_name, is_nullable, data_type FROM information_schema.columns WHERE table_schema = current_schema()",
    );
    for (const table of Object.values(schema)) {
      const expected = Object.values(getTableColumns(table)).map((column) => ({
        column_name: column.name,
        is_nullable: column.notNull ? "NO" : "YES",
        data_type: column.getSQLType() === "bigserial" ? "bigint" : column.getSQLType(),
      })).sort((a, b) => a.column_name.localeCompare(b.column_name));
      const actual = rows.filter((row) => row.table_name === getTableName(table)).map(({ table_name: _tableName, ...column }) => column)
        .sort((a, b) => a.column_name.localeCompare(b.column_name));
      expect(actual, getTableName(table)).toEqual(expected);
    }
  });

  it("reopens with bookings, encrypted replay results, keys, and consumed confirmations intact", async () => {
    const first = await openStore();
    const row = booking();
    const record = reservation(row.userId);
    const userKey = await first.keys.getOrCreate(row.userId);
    const ciphertext = encryptWithKey(userKey, JSON.stringify({ bookingId: row.id }));
    const jti = randomUUID();
    await first.bookings.put(row);
    await first.idempotency.reserve(record);
    await first.idempotency.complete(record.userId, record.tool, record.key, ciphertext);
    await first.confirmations.consume(jti, new Date("2100-01-01"));
    await first.close();
    const second = await openStore();
    await expect(second.bookings.get(row.userId, row.id)).resolves.toEqual(row);
    const replay = await second.idempotency.get(record.userId, record.tool, record.key);
    expect(decryptWithKey(await second.keys.getOrCreate(row.userId), replay!.responseCipher!)).toBe(JSON.stringify({ bookingId: row.id }));
    await expect(second.confirmations.consume(jti, new Date("2100-01-01"))).resolves.toBe(false);
    await second.health();
  });

  it("coordinates reservation and confirmation consumption across independent pools", async () => {
    const [first, second] = await Promise.all([openStore(), openStore()]);
    const record = reservation();
    const claims = await Promise.all([first.idempotency.reserve(record), second.idempotency.reserve(record)]);
    expect(claims.filter((row) => row === null)).toHaveLength(1);
    const jti = randomUUID();
    const results = await Promise.all([first.confirmations.consume(jti, new Date()), second.confirmations.consume(jti, new Date())]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("retains booking mutation guards across competing pools and process restarts", async () => {
    const [first, second] = await Promise.all([openStore(), openStore()]);
    const row = booking();
    await first.bookings.put(row);
    const claims = await Promise.all([
      first.bookingMutations.acquire(row.userId, row.id, "cancel_booking", "first"),
      second.bookingMutations.acquire(row.userId, row.id, "pay_or_deposit", "second"),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const [tool, key] = claims[0] ? ["cancel_booking", "first"] : ["pay_or_deposit", "second"];
    await first.close();
    await second.close();
    const restarted = await openStore();
    await expect(restarted.bookingMutations.acquire(row.userId, row.id, tool!, key!)).resolves.toBe(false);
    await restarted.bookingMutations.release(row.userId, row.id, tool!, key!);
    await expect(restarted.bookingMutations.acquire(row.userId, row.id, "reschedule_booking", "third")).resolves.toBe(true);
  });

  it("wraps user keys at rest, binds them to a user, and rejects a wrong deployment key on startup", async () => {
    const store = await openStore();
    const pool = new Pool({ connectionString: scopedUrl });
    pools.push(pool);
    const userId = randomUUID();
    const otherId = randomUUID();
    const key = await store.keys.getOrCreate(userId);
    await store.keys.getOrCreate(otherId);
    const { rows: [row] } = await pool.query<{ key: string }>("SELECT key FROM user_keys WHERE user_id = $1", [userId]);
    expect(row!.key).toMatch(/^v1\./);
    expect(row!.key).not.toContain(key.toString("base64url"));
    await pool.query("UPDATE user_keys SET key = $1 WHERE user_id = $2", [row!.key, otherId]);
    await expect(store.keys.getOrCreate(otherId)).rejects.toThrow("Unable to decrypt stored key");
    await expect(createPostgresStore({ connectionString: scopedUrl, encryptionKey: randomBytes(32) })).rejects.toThrow("Unable to decrypt stored key");
    await expect(createPostgresStore({ connectionString: scopedUrl, encryptionKey: randomBytes(16) })).rejects.toThrow("exactly 32 bytes");
  });

  it("requires explicit migration and rejects tampered migration history", async () => {
    const emptySchema = `${schemaName}_empty`;
    await admin.query(`CREATE SCHEMA ${emptySchema}`);
    const url = new URL(scopedUrl);
    url.searchParams.set("options", `-csearch_path=${emptySchema}`);
    const connectionString = url.toString();
    const pool = new Pool({ connectionString });
    try {
      await expect(createPostgresStore({ connectionString, encryptionKey })).rejects.toThrow();
      await migratePostgres(connectionString);
      await pool.query("UPDATE porter_migrations SET checksum = 'tampered'");
      await expect(createPostgresStore({ connectionString, encryptionKey })).rejects.toThrow("migrations do not match");
      await expect(migratePostgres(connectionString)).rejects.toThrow("history does not match");
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${emptySchema} CASCADE`);
    }
  });

  it("upgrades a version 1 database without changing existing booking data", async () => {
    const upgradeSchema = `${schemaName}_upgrade`;
    await admin.query(`CREATE SCHEMA ${upgradeSchema}`);
    const url = new URL(scopedUrl);
    url.searchParams.set("options", `-csearch_path=${upgradeSchema}`);
    const connectionString = url.toString();
    const pool = new Pool({ connectionString });
    let store: PostgresStore | undefined;
    try {
      await migratePostgres(connectionString);
      store = await createPostgresStore({ connectionString, encryptionKey });
      const row = booking();
      await store.bookings.put(row);
      await store.close();
      // Restore the exact v1 schema and ledger, preserving its existing data.
      await pool.query(`DROP TABLE customer_oauth_refresh_tokens, customer_oauth_access_tokens, customer_oauth_codes,
        customer_oauth_grants, customer_oauth_requests, customer_oauth_clients, import_drafts, pilot_rate_limits,
        merchant_connections, square_oauth_states, pilot_businesses, connector_credentials, pilot_sessions,
        email_login_tokens, email_identities, booking_mutations`);
      await pool.query("DELETE FROM porter_migrations WHERE version > 1");
      await expect(createPostgresStore({ connectionString, encryptionKey })).rejects.toThrow("migrations do not match");
      await migratePostgres(connectionString);
      store = await createPostgresStore({ connectionString, encryptionKey });
      await expect(store.bookings.get(row.userId, row.id)).resolves.toEqual(row);
      await expect(store.bookingMutations.acquire(row.userId, row.id, "cancel_booking", "upgraded")).resolves.toBe(true);
    } finally {
      await store?.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${upgradeSchema} CASCADE`);
    }
  });
});
