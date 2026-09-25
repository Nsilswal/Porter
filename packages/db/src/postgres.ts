import { randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, lte, or } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { Store } from "@porter/core";
import * as schema from "./schema.js";
import { assertMigrationsApplied } from "./migrations.js";
import { unwrapKey, wrapKey } from "./encryption.js";

export interface PostgresStore extends Store {
  health(): Promise<void>;
  close(): Promise<void>;
}

export interface PostgresStoreOptions {
  readonly connectionString: string;
  /** Independent from the confirmation-signing secret. Persist securely across deploys. */
  readonly encryptionKey: Buffer;
  readonly maxConnections?: number;
}

type Executor = Pick<NodePgDatabase<typeof schema>, "insert" | "select" | "update" | "delete">;

async function ensureUser(db: Executor, userId: string): Promise<void> {
  await db.insert(schema.users).values({ id: userId }).onConflictDoNothing();
}

function idempotencyWhere(userId: string, tool: string, key: string) {
  return and(eq(schema.idempotencyKeys.userId, userId), eq(schema.idempotencyKeys.tool, tool), eq(schema.idempotencyKeys.key, key));
}

const canaryContext = "porter:store-encryption:v1";
const canaryPlaintext = Buffer.from("porter deployment encryption key");

/** Opens an already-migrated database. Startup fails before accepting traffic on a wrong key. */
export async function createPostgresStore(options: PostgresStoreOptions): Promise<PostgresStore> {
  if (!Buffer.isBuffer(options.encryptionKey) || options.encryptionKey.length !== 32) {
    throw new Error("Database encryption key must be exactly 32 bytes");
  }
  if (options.maxConnections !== undefined && (!Number.isSafeInteger(options.maxConnections) || options.maxConnections < 1)) {
    throw new Error("Database pool size must be a positive integer");
  }
  const masterKey = Buffer.from(options.encryptionKey);
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 15_000,
  });
  // An idle connection can fail during a database restart. pg discards it;
  // requests/health still receive errors, while this listener prevents a crash.
  pool.on("error", () => undefined);
  const db = drizzle(pool, { schema });
  let closing: Promise<void> | undefined;
  async function close(): Promise<void> {
    closing ??= pool.end().finally(() => masterKey.fill(0));
    await closing;
  }
  async function health(): Promise<void> {
    if (closing) throw new Error("Database store is closed");
    await assertMigrationsApplied(pool);
  }
  try {
    await health();
    await db.insert(schema.storeMetadata).values({
      key: "encryption_canary",
      value: wrapKey(canaryPlaintext, masterKey, canaryContext),
    }).onConflictDoNothing();
    const [canary] = await db.select().from(schema.storeMetadata).where(eq(schema.storeMetadata.key, "encryption_canary"));
    if (!canary) throw new Error("Missing database encryption canary");
    const plaintext = unwrapKey(canary.value, masterKey, canaryContext);
    if (plaintext.length !== canaryPlaintext.length || !timingSafeEqual(plaintext, canaryPlaintext)) {
      throw new Error("Database encryption canary is invalid");
    }
  } catch (error) {
    await close();
    throw error;
  }

  return {
    health,
    close,
    bookingMutations: {
      async acquire(userId, bookingId, tool, key) {
        const rows = await db.insert(schema.bookingMutations).values({ userId, bookingId, tool, key })
          .onConflictDoNothing({ target: [schema.bookingMutations.userId, schema.bookingMutations.bookingId] })
          .returning({ bookingId: schema.bookingMutations.bookingId });
        return rows.length === 1;
      },
      async release(userId, bookingId, tool, key) {
        await db.delete(schema.bookingMutations).where(and(
          eq(schema.bookingMutations.userId, userId),
          eq(schema.bookingMutations.bookingId, bookingId),
          eq(schema.bookingMutations.tool, tool),
          eq(schema.bookingMutations.key, key),
        ));
      },
    },
    bookings: {
      async put(booking) {
        await db.transaction(async (tx) => {
          await ensureUser(tx, booking.userId);
          const { createdAt: _createdAt, ...updates } = booking;
          const rows = await tx.insert(schema.bookings).values(booking).onConflictDoUpdate({
            target: schema.bookings.id,
            set: updates,
            setWhere: and(
              eq(schema.bookings.userId, booking.userId),
              eq(schema.bookings.adapterId, booking.adapterId),
              eq(schema.bookings.providerBookingRef, booking.providerBookingRef),
            ),
          }).returning({ id: schema.bookings.id });
          if (!rows.length) throw new Error("A booking's owner and provider reference cannot change");
        });
      },
      async get(userId, bookingId) {
        const [row] = await db.select().from(schema.bookings).where(and(eq(schema.bookings.userId, userId), eq(schema.bookings.id, bookingId)));
        return row ?? null;
      },
      async list(userId, status) {
        return db.select().from(schema.bookings).where(and(eq(schema.bookings.userId, userId), status ? eq(schema.bookings.status, status) : undefined)).orderBy(asc(schema.bookings.startsAt), asc(schema.bookings.id));
      },
      async deleteAllForUser(userId) {
        return (await db.delete(schema.bookings).where(eq(schema.bookings.userId, userId)).returning({ id: schema.bookings.id })).length;
      },
    },
    idempotency: {
      async reserve(record) {
        // A safe pre-write failure can release the competing reservation between
        // INSERT and SELECT. Retry that race; never infer safety from expiresAt.
        for (let attempt = 0; attempt < 5; attempt++) {
          const inserted = await db.insert(schema.idempotencyKeys).values(record).onConflictDoNothing().returning({ key: schema.idempotencyKeys.key });
          if (inserted.length) return null;
          const [existing] = await db.select().from(schema.idempotencyKeys).where(idempotencyWhere(record.userId, record.tool, record.key));
          if (existing) return existing;
        }
        throw new Error("Idempotency reservation changed repeatedly; retry the request");
      },
      async complete(userId, tool, key, responseCipher) {
        const rows = await db.update(schema.idempotencyKeys).set({ state: "completed", responseCipher }).where(and(
          idempotencyWhere(userId, tool, key),
          or(eq(schema.idempotencyKeys.state, "in_flight"), eq(schema.idempotencyKeys.state, "uncertain"), eq(schema.idempotencyKeys.responseCipher, responseCipher)),
        )).returning({ key: schema.idempotencyKeys.key });
        if (!rows.length) throw new Error("Cannot complete an absent key or replace a completed idempotency response");
      },
      async markUncertain(userId, tool, key, operation) {
        const rows = await db.update(schema.idempotencyKeys).set({ state: "uncertain", operation }).where(and(
          idempotencyWhere(userId, tool, key),
          or(eq(schema.idempotencyKeys.state, "in_flight"), and(eq(schema.idempotencyKeys.state, "uncertain"), eq(schema.idempotencyKeys.operation, operation))),
        )).returning({ key: schema.idempotencyKeys.key });
        if (!rows.length) throw new Error("Cannot mark this idempotency key uncertain");
      },
      async release(userId, tool, key) {
        await db.delete(schema.idempotencyKeys).where(and(idempotencyWhere(userId, tool, key), eq(schema.idempotencyKeys.state, "in_flight")));
      },
      async get(userId, tool, key) {
        const [row] = await db.select().from(schema.idempotencyKeys).where(idempotencyWhere(userId, tool, key));
        return row ?? null;
      },
      async deleteAllForUser(userId) {
        return (await db.delete(schema.idempotencyKeys).where(eq(schema.idempotencyKeys.userId, userId)).returning({ key: schema.idempotencyKeys.key })).length;
      },
    },
    confirmations: {
      async consume(jti, expiresAt) {
        return (await db.insert(schema.confirmationTokens).values({ jti, expiresAt }).onConflictDoNothing().returning({ jti: schema.confirmationTokens.jti })).length === 1;
      },
      async deleteExpired(now) {
        return (await db.delete(schema.confirmationTokens).where(lte(schema.confirmationTokens.expiresAt, now)).returning({ jti: schema.confirmationTokens.jti })).length;
      },
    },
    keys: {
      async getOrCreate(userId) {
        const context = `porter:user-key:${JSON.stringify(userId)}`;
        return db.transaction(async (tx) => {
          await ensureUser(tx, userId);
          const newKey = randomBytes(32);
          const wrapped = wrapKey(newKey, masterKey, context);
          newKey.fill(0);
          await tx.insert(schema.userKeys).values({ userId, key: wrapped }).onConflictDoNothing();
          const [row] = await tx.select().from(schema.userKeys).where(eq(schema.userKeys.userId, userId));
          if (!row) throw new Error("User encryption key was deleted during creation");
          const key = unwrapKey(row.key, masterKey, context);
          if (key.length !== 32) throw new Error("Invalid stored user encryption key");
          return key;
        });
      },
      async destroy(userId) {
        await db.delete(schema.userKeys).where(eq(schema.userKeys.userId, userId));
      },
    },
    audit: {
      async append(record) {
        const { seq: _seq, ...values } = record;
        await db.insert(schema.auditLog).values(values);
      },
      async list(actorId, limit = 100) {
        if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Audit limit must be a nonnegative integer");
        const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.actorId, actorId)).orderBy(desc(schema.auditLog.seq)).limit(limit);
        return rows.reverse().map(({ immutable: _immutable, ...record }) => record);
      },
    },
    payments: {
      async put(record) {
        const { createdAt: _createdAt, ...updates } = record;
        const rows = await db.insert(schema.payments).values(record).onConflictDoUpdate({
          target: schema.payments.id,
          set: updates,
          setWhere: and(
            eq(schema.payments.userId, record.userId),
            eq(schema.payments.bookingId, record.bookingId),
            eq(schema.payments.gatewayId, record.gatewayId),
            eq(schema.payments.gatewayPaymentRef, record.gatewayPaymentRef),
          ),
        }).returning({ id: schema.payments.id });
        if (!rows.length) throw new Error("A payment's owner, booking and gateway reference cannot change");
      },
      async listForBooking(userId, bookingId) {
        return db.select().from(schema.payments).where(and(eq(schema.payments.userId, userId), eq(schema.payments.bookingId, bookingId))).orderBy(asc(schema.payments.createdAt), asc(schema.payments.id));
      },
      async listForUser(userId) {
        return db.select().from(schema.payments).where(eq(schema.payments.userId, userId)).orderBy(asc(schema.payments.createdAt), asc(schema.payments.id));
      },
      async deleteAllForUser(userId) {
        return (await db.delete(schema.payments).where(eq(schema.payments.userId, userId)).returning({ id: schema.payments.id })).length;
      },
    },
    paymentProfiles: {
      async get(userId) {
        const [row] = await db.select({ customerRef: schema.paymentProfiles.customerRef, paymentMethodRef: schema.paymentProfiles.paymentMethodRef, label: schema.paymentProfiles.label }).from(schema.paymentProfiles).where(eq(schema.paymentProfiles.userId, userId));
        return row ?? null;
      },
      async put(userId, profile) {
        await db.transaction(async (tx) => {
          await ensureUser(tx, userId);
          await tx.insert(schema.paymentProfiles).values({ userId, ...profile }).onConflictDoUpdate({ target: schema.paymentProfiles.userId, set: profile });
        });
      },
      async deleteAllForUser(userId) {
        return (await db.delete(schema.paymentProfiles).where(eq(schema.paymentProfiles.userId, userId)).returning({ userId: schema.paymentProfiles.userId })).length;
      },
    },
  };
}
