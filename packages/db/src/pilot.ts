import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { openDatabase, type DatabaseOptions } from "./database-connection.js";
import { unwrapKey, wrapKey } from "./encryption.js";
import type { MerchantConnection, NewMerchantCredentials, PilotStore, SquareEnvironment } from "./pilot-types.js";
import * as schema from "./schema.js";

export type PilotStoreOptions = DatabaseOptions;
type Executor = Pick<NodePgDatabase<typeof schema>, "select">;

function hash(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Expected a SHA-256 token hash");
}

function date(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Expected a valid timestamp");
}

function nonempty(value: string): void {
  if (typeof value !== "string" || !value.trim()) throw new Error("Expected a nonempty value");
}

function connectionWhere(businessId: string, environment: SquareEnvironment) {
  return and(eq(schema.merchantConnections.businessId, businessId), eq(schema.merchantConnections.environment, environment));
}

function connectionView(row: typeof schema.merchantConnections.$inferSelect): MerchantConnection {
  const { credentialCipher: _cipher, ...view } = row;
  return view;
}

function connectorView(row: typeof schema.connectorCredentials.$inferSelect) {
  const { tokenHash: _hash, ...view } = row;
  return view;
}

/** Hold a share lock until the security-sensitive transaction completes. */
async function liveUser(db: Executor, userId: string): Promise<boolean> {
  return (await db.select({ id: schema.users.id }).from(schema.users)
    .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt))).for("share")).length === 1;
}

async function liveSession(db: Executor, userId: string, sessionHash: string, now: Date): Promise<boolean> {
  return (await db.select({ hash: schema.pilotSessions.sessionHash }).from(schema.pilotSessions).where(and(
    eq(schema.pilotSessions.userId, userId), eq(schema.pilotSessions.sessionHash, sessionHash),
    isNull(schema.pilotSessions.revokedAt), gt(schema.pilotSessions.expiresAt, now),
  )).for("share")).length === 1;
}

export async function createPilotStore(options: PilotStoreOptions): Promise<PilotStore> {
  const { db, masterKey, health, close } = await openDatabase(options);
  function encryptCredentials(input: NewMerchantCredentials): string {
    nonempty(input.accessToken);
    nonempty(input.refreshToken);
    nonempty(input.merchantId);
    date(input.expiresAt);
    if (!Array.isArray(input.scopes) || input.scopes.some((scope) => typeof scope !== "string" || !scope)) throw new Error("Invalid merchant scopes");
    const plaintext = Buffer.from(JSON.stringify({ accessToken: input.accessToken, refreshToken: input.refreshToken }));
    try {
      return wrapKey(plaintext, masterKey,
        `porter:merchant-credentials:${JSON.stringify([input.businessId, input.environment, input.merchantId])}`);
    } finally {
      plaintext.fill(0);
    }
  }

  function decryptCredentials(row: typeof schema.merchantConnections.$inferSelect) {
    if (!row.credentialCipher) throw new Error("Merchant credentials are unavailable");
    const plaintext = unwrapKey(row.credentialCipher, masterKey,
      `porter:merchant-credentials:${JSON.stringify([row.businessId, row.environment, row.merchantId])}`);
    try {
      const tokens = JSON.parse(plaintext.toString("utf8")) as { accessToken: string; refreshToken: string };
      nonempty(tokens.accessToken); nonempty(tokens.refreshToken);
      return { ...connectionView(row), accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
    } finally {
      plaintext.fill(0);
    }
  }

  return {
    health,
    close,
    rateLimits: {
      async take(input) {
        hash(input.keyHash); date(input.now);
        if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 2147483647) throw new Error("Invalid rate limit");
        if (!Number.isSafeInteger(input.windowMs) || input.windowMs < 1 || input.windowMs > 31 * 86400000) throw new Error("Invalid rate-limit window");
        const windowStart = new Date(Math.floor(input.now.getTime() / input.windowMs) * input.windowMs);
        const rows = await db.insert(schema.pilotRateLimits).values({ keyHash: input.keyHash, windowStart, count: 1,
          expiresAt: new Date(windowStart.getTime() + input.windowMs),
        }).onConflictDoUpdate({ target: [schema.pilotRateLimits.keyHash, schema.pilotRateLimits.windowStart],
          set: { count: sql`${schema.pilotRateLimits.count} + 1` }, setWhere: lt(schema.pilotRateLimits.count, input.limit),
        }).returning({ count: schema.pilotRateLimits.count });
        return rows.length === 1;
      },
    },
    identities: {
      async getOrCreate(email) {
        const normalized = email.trim().toLowerCase();
        if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error("Invalid email address");
        return db.transaction(async (tx) => {
          // Locks only this normalized email; concurrent first sign-ins create one user.
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${normalized}, 391217))`);
          const [existing] = await tx.select().from(schema.emailIdentities).where(eq(schema.emailIdentities.email, normalized));
          if (existing) {
            if (!await liveUser(tx, existing.userId)) throw new Error("Identity is unavailable");
            return existing;
          }
          const userId = randomUUID();
          await tx.insert(schema.users).values({ id: userId });
          const [row] = await tx.insert(schema.emailIdentities).values({ userId, email: normalized }).returning();
          return row!;
        });
      },
      async get(userId) {
        const [row] = await db.select({ identity: schema.emailIdentities }).from(schema.emailIdentities)
          .innerJoin(schema.users, eq(schema.users.id, schema.emailIdentities.userId))
          .where(and(eq(schema.emailIdentities.userId, userId), isNull(schema.users.deletedAt)));
        return row?.identity ?? null;
      },
    },
    loginTokens: {
      async issue(input) {
        hash(input.tokenHash); hash(input.browserNonceHash); date(input.expiresAt);
        await db.transaction(async (tx) => {
          if (!await liveUser(tx, input.userId)) throw new Error("Identity is unavailable");
          await tx.insert(schema.emailLoginTokens).values(input);
        });
      },
      async consume(input) {
        hash(input.tokenHash); hash(input.browserNonceHash); hash(input.sessionHash); date(input.now); date(input.sessionExpiresAt);
        if (input.sessionExpiresAt <= input.now) throw new Error("Session expiry must be in the future");
        return db.transaction(async (tx) => {
          const [token] = await tx.select().from(schema.emailLoginTokens).where(eq(schema.emailLoginTokens.tokenHash, input.tokenHash));
          if (!token || !await liveUser(tx, token.userId)) return null;
          const rows = await tx.update(schema.emailLoginTokens).set({ consumedAt: input.now }).where(and(
            eq(schema.emailLoginTokens.tokenHash, input.tokenHash), eq(schema.emailLoginTokens.browserNonceHash, input.browserNonceHash),
            isNull(schema.emailLoginTokens.consumedAt), gt(schema.emailLoginTokens.expiresAt, input.now),
          )).returning({ userId: schema.emailLoginTokens.userId });
          if (!rows.length) return null;
          const [session] = await tx.insert(schema.pilotSessions).values({
            sessionHash: input.sessionHash, userId: token.userId, expiresAt: input.sessionExpiresAt,
          }).returning();
          return session!;
        });
      },
    },
    sessions: {
      async lookup(sessionHash, now) {
        hash(sessionHash); date(now);
        const [row] = await db.select({ session: schema.pilotSessions }).from(schema.pilotSessions)
          .innerJoin(schema.users, eq(schema.users.id, schema.pilotSessions.userId)).where(and(
            eq(schema.pilotSessions.sessionHash, sessionHash), isNull(schema.pilotSessions.revokedAt),
            gt(schema.pilotSessions.expiresAt, now), isNull(schema.users.deletedAt),
          ));
        return row?.session ?? null;
      },
      async revoke(userId, sessionHash) {
        hash(sessionHash);
        return (await db.update(schema.pilotSessions).set({ revokedAt: new Date() }).where(and(
          eq(schema.pilotSessions.userId, userId), eq(schema.pilotSessions.sessionHash, sessionHash), isNull(schema.pilotSessions.revokedAt),
        )).returning({ hash: schema.pilotSessions.sessionHash })).length === 1;
      },
    },
    connectors: {
      async issue(input) {
        hash(input.tokenHash); nonempty(input.id); nonempty(input.label);
        return db.transaction(async (tx) => {
          if (!await liveUser(tx, input.userId)) throw new Error("Identity is unavailable");
          const [row] = await tx.insert(schema.connectorCredentials).values(input).returning();
          return connectorView(row!);
        });
      },
      async list(userId) {
        const rows = await db.select().from(schema.connectorCredentials).where(eq(schema.connectorCredentials.userId, userId)).orderBy(asc(schema.connectorCredentials.createdAt));
        return rows.map(connectorView);
      },
      async lookup(tokenHash) {
        hash(tokenHash);
        const [row] = await db.select({ credential: schema.connectorCredentials }).from(schema.connectorCredentials)
          .innerJoin(schema.users, eq(schema.users.id, schema.connectorCredentials.userId)).where(and(
            eq(schema.connectorCredentials.tokenHash, tokenHash), isNull(schema.connectorCredentials.revokedAt), isNull(schema.users.deletedAt),
          ));
        return row ? connectorView(row.credential) : null;
      },
      async revoke(userId, id) {
        return (await db.update(schema.connectorCredentials).set({ revokedAt: new Date() }).where(and(
          eq(schema.connectorCredentials.userId, userId), eq(schema.connectorCredentials.id, id), isNull(schema.connectorCredentials.revokedAt),
        )).returning({ id: schema.connectorCredentials.id })).length === 1;
      },
    },
    businesses: {
      async create(input) {
        nonempty(input.id); nonempty(input.name);
        const url = new URL(input.websiteUrl);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid business website URL");
        return db.transaction(async (tx) => {
          if (!await liveUser(tx, input.ownerId)) throw new Error("Identity is unavailable");
          const [row] = await tx.insert(schema.pilotBusinesses).values(input).returning();
          return row!;
        });
      },
      async get(ownerId, businessId) {
        const [row] = await db.select().from(schema.pilotBusinesses).where(and(eq(schema.pilotBusinesses.ownerId, ownerId), eq(schema.pilotBusinesses.id, businessId)));
        return row ?? null;
      },
      async getById(businessId) {
        const [row] = await db.select({ business: schema.pilotBusinesses }).from(schema.pilotBusinesses)
          .innerJoin(schema.users, eq(schema.users.id, schema.pilotBusinesses.ownerId))
          .where(and(eq(schema.pilotBusinesses.id, businessId), isNull(schema.users.deletedAt)));
        return row?.business ?? null;
      },
      async list(ownerId) {
        return db.select().from(schema.pilotBusinesses).where(eq(schema.pilotBusinesses.ownerId, ownerId)).orderBy(asc(schema.pilotBusinesses.createdAt));
      },
      async update(ownerId, businessId, input) {
        if (input.selectedLocationId !== undefined) nonempty(input.selectedLocationId);
        if (input.name !== undefined) nonempty(input.name);
        return db.transaction(async (tx) => {
          if (!await liveUser(tx, ownerId)) return null;
          const [row] = await tx.update(schema.pilotBusinesses).set({ ...input, updatedAt: new Date() }).where(and(
            eq(schema.pilotBusinesses.ownerId, ownerId), eq(schema.pilotBusinesses.id, businessId),
            input.selectedLocationId === undefined ? undefined : or(isNull(schema.pilotBusinesses.selectedLocationId), eq(schema.pilotBusinesses.selectedLocationId, input.selectedLocationId)),
          )).returning();
          return row ?? null;
        });
      },
      async listActive() {
        return (await db.select({ business: schema.pilotBusinesses }).from(schema.pilotBusinesses)
          .innerJoin(schema.users, eq(schema.users.id, schema.pilotBusinesses.ownerId))
          .where(and(eq(schema.pilotBusinesses.status, "active"), isNull(schema.users.deletedAt))).orderBy(asc(schema.pilotBusinesses.id)))
          .map((row) => row.business);
      },
    },
    oauthStates: {
      async issue(input) {
        hash(input.stateHash); hash(input.sessionHash); date(input.expiresAt);
        await db.transaction(async (tx) => {
          const now = new Date();
          if (!await liveUser(tx, input.userId) || !await liveSession(tx, input.userId, input.sessionHash, now)) throw new Error("Session is unavailable");
          if (input.expiresAt <= now) throw new Error("OAuth state expiry must be in the future");
          await tx.insert(schema.squareOAuthStates).values(input);
        });
      },
      async consume(input) {
        hash(input.stateHash); hash(input.sessionHash); date(input.now);
        return db.transaction(async (tx) => {
          if (!await liveUser(tx, input.userId) || !await liveSession(tx, input.userId, input.sessionHash, input.now)) return null;
          const [row] = await tx.update(schema.squareOAuthStates).set({ consumedAt: input.now }).where(and(
            eq(schema.squareOAuthStates.stateHash, input.stateHash), eq(schema.squareOAuthStates.userId, input.userId),
            eq(schema.squareOAuthStates.sessionHash, input.sessionHash), eq(schema.squareOAuthStates.environment, input.environment),
            isNull(schema.squareOAuthStates.consumedAt), gt(schema.squareOAuthStates.expiresAt, input.now),
          )).returning();
          if (!row) return null;
          const { createdAt: _created, consumedAt: _consumed, ...state } = row;
          return state;
        });
      },
    },
    connections: {
      async get(ownerId, businessId, environment) {
        const [row] = await db.select({ connection: schema.merchantConnections }).from(schema.merchantConnections)
          .innerJoin(schema.pilotBusinesses, eq(schema.pilotBusinesses.id, schema.merchantConnections.businessId))
          .where(and(connectionWhere(businessId, environment), eq(schema.pilotBusinesses.ownerId, ownerId)));
        return row ? connectionView(row.connection) : null;
      },
      async connect(ownerId, input, expectedVersion, sessionHash) {
        hash(sessionHash);
        const credentialCipher = encryptCredentials(input);
        return db.transaction(async (tx) => {
          if (!await liveUser(tx, ownerId)) throw new Error("Identity is unavailable");
          if (!await liveSession(tx, ownerId, sessionHash, new Date())) throw new Error("Session is unavailable");
          const [business] = await tx.select().from(schema.pilotBusinesses).where(and(
            eq(schema.pilotBusinesses.ownerId, ownerId), eq(schema.pilotBusinesses.id, input.businessId),
          )).for("update");
          if (!business) throw new Error("Business is unavailable");
          const [current] = await tx.select().from(schema.merchantConnections).where(connectionWhere(input.businessId, input.environment)).for("update");
          if (current?.status === "disconnecting") throw new Error("Square disconnection must finish before reconnecting");
          if ((current?.version ?? null) !== expectedVersion) throw new Error("Square connection changed; start authorization again");
          if (current && current.merchantId !== input.merchantId) throw new Error("A business cannot switch its Square merchant");
          const now = new Date();
          const values = { credentialCipher, expiresAt: input.expiresAt, scopes: input.scopes, status: "connected" as const,
            updatedAt: now, refreshedAt: now };
          const [row] = current
            ? await tx.update(schema.merchantConnections).set({ ...values, version: current.version + 1 })
              .where(connectionWhere(input.businessId, input.environment)).returning()
            : await tx.insert(schema.merchantConnections).values({ ...values,
              businessId: input.businessId, environment: input.environment, merchantId: input.merchantId,
            }).returning();
          if (!row) throw new Error("Unable to connect Square merchant");
          return connectionView(row);
        });
      },
      async readCredentials(businessId, environment) {
        const [row] = await db.select({ connection: schema.merchantConnections }).from(schema.merchantConnections)
          .innerJoin(schema.pilotBusinesses, eq(schema.pilotBusinesses.id, schema.merchantConnections.businessId))
          .innerJoin(schema.users, eq(schema.users.id, schema.pilotBusinesses.ownerId))
          .where(and(connectionWhere(businessId, environment), eq(schema.merchantConnections.status, "connected"), isNull(schema.users.deletedAt)));
        if (!row?.connection.credentialCipher) return null;
        return decryptCredentials(row.connection);
      },
      async replaceCredentials(input, expectedVersion) {
        const credentialCipher = encryptCredentials(input);
        const [row] = await db.update(schema.merchantConnections).set({
          credentialCipher, expiresAt: input.expiresAt, scopes: input.scopes,
          updatedAt: new Date(), refreshedAt: new Date(), version: sql`${schema.merchantConnections.version} + 1`,
        }).where(and(connectionWhere(input.businessId, input.environment), eq(schema.merchantConnections.merchantId, input.merchantId),
          eq(schema.merchantConnections.version, expectedVersion), eq(schema.merchantConnections.status, "connected"))).returning();
        return row ? connectionView(row) : null;
      },
      async markReconnect(businessId, environment, expectedVersion) {
        return (await db.update(schema.merchantConnections).set({
          status: "reconnect_required", updatedAt: new Date(), version: sql`${schema.merchantConnections.version} + 1`,
        }).where(and(connectionWhere(businessId, environment), eq(schema.merchantConnections.version, expectedVersion),
          eq(schema.merchantConnections.status, "connected"))).returning({ id: schema.merchantConnections.businessId })).length === 1;
      },
      async beginDisconnect(ownerId, businessId, environment) {
        return db.transaction(async (tx) => {
          if (!await liveUser(tx, ownerId)) return null;
          const [business] = await tx.select().from(schema.pilotBusinesses).where(and(
            eq(schema.pilotBusinesses.ownerId, ownerId), eq(schema.pilotBusinesses.id, businessId),
          )).for("update");
          if (!business) return null;
          const [connection] = await tx.select().from(schema.merchantConnections).where(connectionWhere(businessId, environment)).for("update");
          if (!connection || connection.status === "disconnected" || connection.status === "disconnecting") return null;
          await tx.update(schema.pilotBusinesses).set({ status: "paused", updatedAt: new Date() }).where(eq(schema.pilotBusinesses.id, businessId));
          const [row] = await tx.update(schema.merchantConnections).set({ status: "disconnecting",
            updatedAt: new Date(), version: connection.version + 1,
          }).where(connectionWhere(businessId, environment)).returning();
          return decryptCredentials(row!);
        });
      },
      async finishDisconnect(ownerId, businessId, environment, expectedVersion) {
        return db.transaction(async (tx) => {
          const [business] = await tx.select().from(schema.pilotBusinesses).where(and(
            eq(schema.pilotBusinesses.ownerId, ownerId), eq(schema.pilotBusinesses.id, businessId),
          )).for("update");
          if (!business) return false;
          return (await tx.update(schema.merchantConnections).set({ status: "disconnected", credentialCipher: null,
            updatedAt: new Date(), version: sql`${schema.merchantConnections.version} + 1`,
          }).where(and(connectionWhere(businessId, environment), eq(schema.merchantConnections.status, "disconnecting"),
            eq(schema.merchantConnections.version, expectedVersion))).returning({ id: schema.merchantConnections.businessId })).length === 1;
        });
      },
      async listPendingRevocations() {
        return (await db.select().from(schema.merchantConnections).where(eq(schema.merchantConnections.status, "disconnecting")))
          .map(connectionView);
      },
    },
  };
}
