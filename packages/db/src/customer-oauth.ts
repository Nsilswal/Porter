import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { openDatabase, type DatabaseOptions } from "./database-connection.js";
import type { CustomerOAuthStore, OAuthAuthorizationRequest } from "./customer-oauth-types.js";
import * as schema from "./schema.js";

export type CustomerOAuthStoreOptions = DatabaseOptions;
type Executor = Pick<NodePgDatabase<typeof schema>, "select">;
const clients = schema.customerOAuthClients;
const requests = schema.customerOAuthRequests;
const codes = schema.customerOAuthCodes;
const grants = schema.customerOAuthGrants;
const accessTokens = schema.customerOAuthAccessTokens;
const refreshTokens = schema.customerOAuthRefreshTokens;

function hash(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Expected a SHA-256 token hash");
}

function date(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("Expected a valid timestamp");
}

function future(value: Date, now: Date): void {
  date(value); date(now);
  if (value <= now) throw new Error("Expiry must be in the future");
}

function nonempty(value: string, max = 2048): void {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Invalid OAuth value");
}

function challenge(value: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("Expected an S256 code challenge");
}

function scopes(value: readonly string[]): void {
  if (!Array.isArray(value) || !value.length || value.length > 32 || new Set(value).size !== value.length
    || value.some((scope) => typeof scope !== "string" || !/^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/.test(scope))) {
    throw new Error("Invalid OAuth scopes");
  }
}

function redirectUri(value: string): void {
  nonempty(value);
  const url = new URL(value);
  if (url.username || url.password || url.hash || value.includes("#")
    || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))) {
    throw new Error("Invalid OAuth redirect URI");
  }
}

function requestView(row: typeof requests.$inferSelect): OAuthAuthorizationRequest {
  return { requestHash: row.requestHash, clientId: row.clientId, redirectUri: row.redirectUri, resource: row.resource,
    scopes: row.scopes, codeChallenge: row.codeChallenge, state: row.state, expiresAt: row.expiresAt };
}

/** Lock order: user, session (consent only), request, code, grant, refresh token. */
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

export async function createCustomerOAuthStore(options: CustomerOAuthStoreOptions): Promise<CustomerOAuthStore> {
  const { db, health, close } = await openDatabase(options);
  const store: CustomerOAuthStore = {
    health,
    close,
    clients: {
      async register(input) {
        nonempty(input.id, 256); nonempty(input.name, 200); date(input.now);
        if (!Array.isArray(input.redirectUris) || input.redirectUris.length < 1 || input.redirectUris.length > 16
          || new Set(input.redirectUris).size !== input.redirectUris.length) throw new Error("Invalid registered redirects");
        input.redirectUris.forEach(redirectUri);
        const [row] = await db.insert(clients).values({ id: input.id, name: input.name,
          redirectUris: [...input.redirectUris], createdAt: input.now }).returning();
        return row!;
      },
      async get(id) {
        const [row] = await db.select().from(clients).where(eq(clients.id, id));
        return row ?? null;
      },
    },
    requests: {
      async issue(input) {
        hash(input.requestHash); hash(input.browserNonceHash); challenge(input.codeChallenge);
        future(input.expiresAt, input.now); scopes(input.scopes); nonempty(input.resource); redirectUri(input.redirectUri);
        if (input.state !== null && (typeof input.state !== "string" || input.state.length > 4096)) throw new Error("Invalid OAuth state");
        await db.transaction(async (tx) => {
          const [client] = await tx.select().from(clients).where(eq(clients.id, input.clientId)).for("share");
          if (!client?.redirectUris.includes(input.redirectUri)) throw new Error("Unregistered OAuth redirect URI");
          await tx.insert(requests).values({ requestHash: input.requestHash, browserNonceHash: input.browserNonceHash,
            clientId: input.clientId, redirectUri: input.redirectUri, resource: input.resource, scopes: [...input.scopes],
            codeChallenge: input.codeChallenge, state: input.state, expiresAt: input.expiresAt, createdAt: input.now });
        });
      },
      async get(requestHash, browserNonceHash, now) {
        hash(requestHash); hash(browserNonceHash); date(now);
        const [row] = await db.select().from(requests).where(and(eq(requests.requestHash, requestHash),
          eq(requests.browserNonceHash, browserNonceHash), isNull(requests.consumedAt), gt(requests.expiresAt, now)));
        return row ? requestView(row) : null;
      },
      async approve(input) {
        hash(input.requestHash); hash(input.browserNonceHash); hash(input.sessionHash); hash(input.codeHash);
        future(input.codeExpiresAt, input.now);
        return db.transaction(async (tx) => {
          if (!await liveUser(tx, input.userId) || !await liveSession(tx, input.userId, input.sessionHash, input.now)) return null;
          const [request] = await tx.update(requests).set({ consumedAt: input.now }).where(and(
            eq(requests.requestHash, input.requestHash), eq(requests.browserNonceHash, input.browserNonceHash),
            isNull(requests.consumedAt), gt(requests.expiresAt, input.now),
          )).returning();
          if (!request) return null;
          await tx.insert(codes).values({ codeHash: input.codeHash, requestHash: request.requestHash, userId: input.userId,
            sessionHash: input.sessionHash, clientId: request.clientId, redirectUri: request.redirectUri, resource: request.resource,
            scopes: request.scopes, codeChallenge: request.codeChallenge, expiresAt: input.codeExpiresAt, createdAt: input.now });
          return requestView(request);
        });
      },
      async deny(input) {
        hash(input.requestHash); hash(input.browserNonceHash); hash(input.sessionHash); date(input.now);
        return db.transaction(async (tx) => {
          if (!await liveUser(tx, input.userId) || !await liveSession(tx, input.userId, input.sessionHash, input.now)) return null;
          const [row] = await tx.update(requests).set({ consumedAt: input.now }).where(and(
            eq(requests.requestHash, input.requestHash), eq(requests.browserNonceHash, input.browserNonceHash),
            isNull(requests.consumedAt), gt(requests.expiresAt, input.now),
          )).returning();
          return row ? requestView(row) : null;
        });
      },
    },
    tokens: {
      async exchangeCode(input) {
        hash(input.codeHash); hash(input.accessTokenHash); hash(input.refreshTokenHash); challenge(input.codeChallenge);
        nonempty(input.grantId, 256); future(input.accessExpiresAt, input.now); future(input.refreshExpiresAt, input.now);
        if (input.accessTokenHash === input.refreshTokenHash) throw new Error("Access and refresh tokens must differ");
        return db.transaction(async (tx) => {
          // Read only to discover ownership; re-read under the code lock after the user lock.
          const [owner] = await tx.select({ userId: codes.userId }).from(codes).where(eq(codes.codeHash, input.codeHash));
          if (!owner || !await liveUser(tx, owner.userId)) return null;
          const [code] = await tx.select().from(codes).where(eq(codes.codeHash, input.codeHash)).for("update");
          if (!code || code.clientId !== input.clientId || code.redirectUri !== input.redirectUri
            || code.resource !== input.resource || code.codeChallenge !== input.codeChallenge) return null;
          if (code.consumedAt) {
            // Retain consumed codes so replay can invalidate already-issued credentials, even after code expiry.
            await tx.update(grants).set({ revokedAt: input.now }).where(and(eq(grants.id, code.grantId!), isNull(grants.revokedAt)));
            return null;
          }
          if (code.expiresAt <= input.now) return null;
          const [grant] = await tx.insert(grants).values({ id: input.grantId, userId: code.userId, clientId: code.clientId,
            resource: code.resource, scopes: code.scopes, expiresAt: input.refreshExpiresAt, createdAt: input.now }).returning();
          await tx.insert(accessTokens).values({ tokenHash: input.accessTokenHash, grantId: input.grantId,
            expiresAt: new Date(Math.min(input.accessExpiresAt.getTime(), input.refreshExpiresAt.getTime())), createdAt: input.now });
          await tx.insert(refreshTokens).values({ tokenHash: input.refreshTokenHash, grantId: input.grantId, createdAt: input.now });
          await tx.update(codes).set({ consumedAt: input.now, grantId: input.grantId }).where(eq(codes.codeHash, input.codeHash));
          return grant!;
        });
      },
      async refresh(input) {
        hash(input.refreshTokenHash); hash(input.accessTokenHash); hash(input.newRefreshTokenHash);
        future(input.accessExpiresAt, input.now);
        if (input.scopes !== undefined) scopes(input.scopes);
        if (input.refreshTokenHash === input.newRefreshTokenHash || input.accessTokenHash === input.newRefreshTokenHash
          || input.accessTokenHash === input.refreshTokenHash) throw new Error("Rotated tokens must differ");
        return db.transaction(async (tx) => {
          const [owner] = await tx.select({ grantId: grants.id, userId: grants.userId }).from(refreshTokens)
            .innerJoin(grants, eq(grants.id, refreshTokens.grantId)).where(eq(refreshTokens.tokenHash, input.refreshTokenHash));
          if (!owner || !await liveUser(tx, owner.userId)) return null;
          // Every family mutation takes this lock before touching a refresh row. Distinct generations serialize too.
          const [grant] = await tx.select().from(grants).where(eq(grants.id, owner.grantId)).for("update");
          if (!grant || grant.clientId !== input.clientId || grant.resource !== input.resource || grant.revokedAt
            || grant.expiresAt <= input.now) return null;
          const [token] = await tx.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, input.refreshTokenHash)).for("update");
          if (!token) return null;
          if (token.consumedAt) {
            await tx.update(grants).set({ revokedAt: input.now }).where(eq(grants.id, grant.id));
            return null;
          }
          if (input.scopes?.some((scope) => !grant.scopes.includes(scope))) return null;
          const nextScopes = input.scopes ? [...input.scopes] : grant.scopes;
          await tx.update(refreshTokens).set({ consumedAt: input.now }).where(eq(refreshTokens.tokenHash, input.refreshTokenHash));
          await tx.insert(accessTokens).values({ tokenHash: input.accessTokenHash, grantId: grant.id,
            expiresAt: new Date(Math.min(input.accessExpiresAt.getTime(), grant.expiresAt.getTime())), createdAt: input.now });
          await tx.insert(refreshTokens).values({ tokenHash: input.newRefreshTokenHash, grantId: grant.id, createdAt: input.now });
          if (input.scopes) await tx.update(grants).set({ scopes: nextScopes }).where(eq(grants.id, grant.id));
          return { ...grant, scopes: nextScopes };
        });
      },
      async lookupAccess(accessTokenHash, resource, now) {
        hash(accessTokenHash); date(now);
        const [row] = await db.select({ grant: grants }).from(accessTokens).innerJoin(grants, eq(grants.id, accessTokens.grantId))
          .innerJoin(schema.users, eq(schema.users.id, grants.userId)).where(and(
            eq(accessTokens.tokenHash, accessTokenHash), eq(grants.resource, resource), isNull(schema.users.deletedAt),
            isNull(grants.revokedAt), gt(grants.expiresAt, now), gt(accessTokens.expiresAt, now),
          ));
        return row?.grant ?? null;
      },
      async revoke(input) {
        hash(input.tokenHash); date(input.now);
        await db.transaction(async (tx) => {
          const [access] = await tx.select({ grant: grants }).from(accessTokens).innerJoin(grants, eq(grants.id, accessTokens.grantId))
            .where(and(eq(accessTokens.tokenHash, input.tokenHash), eq(grants.clientId, input.clientId)));
          const [refresh] = access ? [] : await tx.select({ grant: grants }).from(refreshTokens)
            .innerJoin(grants, eq(grants.id, refreshTokens.grantId))
            .where(and(eq(refreshTokens.tokenHash, input.tokenHash), eq(grants.clientId, input.clientId)));
          const grant = access?.grant ?? refresh?.grant;
          if (!grant || !await liveUser(tx, grant.userId)) return;
          await tx.update(grants).set({ revokedAt: input.now }).where(and(eq(grants.id, grant.id),
            eq(grants.clientId, input.clientId), isNull(grants.revokedAt)));
        });
      },
    },
    grants: {
      async list(userId, now) {
        date(now);
        const rows = await db.select({ grant: grants }).from(grants).innerJoin(schema.users, eq(schema.users.id, grants.userId))
          .where(and(eq(grants.userId, userId), isNull(schema.users.deletedAt), isNull(grants.revokedAt), gt(grants.expiresAt, now)))
          .orderBy(asc(grants.createdAt));
        return rows.map((row) => row.grant);
      },
      async revoke(input) {
        hash(input.sessionHash); date(input.now);
        return db.transaction(async (tx) => {
          if (!await liveUser(tx, input.userId) || !await liveSession(tx, input.userId, input.sessionHash, input.now)) return false;
          return (await tx.update(grants).set({ revokedAt: input.now }).where(and(eq(grants.id, input.grantId),
            eq(grants.userId, input.userId), isNull(grants.revokedAt))).returning({ id: grants.id })).length === 1;
        });
      },
    },
  };
  return store;
}
