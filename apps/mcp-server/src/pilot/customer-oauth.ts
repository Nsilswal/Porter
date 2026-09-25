import { createHash, randomUUID } from "node:crypto";
import type { CustomerOAuthStore, OAuthGrant, PilotSession, PilotStore } from "@porter/db";
import { opaqueToken, tokenHash, validToken } from "./security.js";

export const BOOKING_SCOPES = ["bookings:read", "bookings:write"] as const;
const REQUEST_LIFETIME = 20 * 60_000;
const CODE_LIFETIME = 2 * 60_000;
const ACCESS_LIFETIME = 15 * 60_000;
const GRANT_LIFETIME = 30 * 24 * 60 * 60_000;
const RATE_WINDOW = 15 * 60_000;

export class CustomerOAuthError extends Error {
  constructor(readonly status: number, readonly error: string, readonly error_description: string) {
    super(error_description);
    this.name = "CustomerOAuthError";
  }
}

export interface RegisteredPublicClient {
  readonly client_id: string;
  readonly client_name: string;
  readonly redirect_uris: string[];
  readonly client_id_issued_at: number;
  readonly token_endpoint_auth_method: "none";
  readonly grant_types: ["authorization_code", "refresh_token"];
  readonly response_types: ["code"];
  readonly scope: string;
}

export interface CustomerConsentView {
  readonly requestToken: string;
  readonly clientId: string;
  readonly clientName: string;
  /** A self-registered display name never establishes that a client belongs to Meta. */
  readonly clientVerified: false;
  readonly redirectUri: string;
  readonly redirectOrigin: string;
  readonly resource: string;
  readonly scopes: string[];
  readonly expiresAt: Date;
}

export interface CustomerTokenResponse {
  readonly access_token: string;
  readonly token_type: "Bearer";
  readonly expires_in: number;
  readonly refresh_token: string;
  readonly scope: string;
}

export interface CustomerConnectionView {
  readonly id: string;
  readonly clientName: string;
  readonly clientVerified: false;
  readonly redirectOrigins: string[];
  readonly scopes: string[];
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface CustomerOAuthOptions {
  readonly store: CustomerOAuthStore;
  readonly pilotStore: Pick<PilotStore, "rateLimits" | "sessions">;
  readonly origin: string;
  /** Local HTTP issuer/loopback redirects are permitted only in sandbox. */
  readonly sandbox?: boolean;
  readonly now?: () => Date;
}

/**
 * Durable public-client OAuth for customers, separate from merchant Square OAuth.
 * Implements the MCP 2025-11-25 authorization profile through RFC 7591 registration,
 * RFC 7636 S256, RFC 8707 resource binding and RFC 9700 refresh rotation.
 * Client ID metadata documents are intentionally not advertised or fetched.
 * https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
 *
 * HTTP must enforce bounded bodies, no-store responses, and same-origin POST/CSRF
 * for consent. Only decide() can grant authorization, using a verified live session.
 */
export class CustomerOAuth {
  readonly origin: string;
  readonly resource: string;
  readonly #store: CustomerOAuthStore;
  readonly #pilotStore: CustomerOAuthOptions["pilotStore"];
  readonly #sandbox: boolean;
  readonly #now: () => Date;

  constructor(options: CustomerOAuthOptions) {
    const origin = new URL(options.origin);
    if (origin.origin !== options.origin || origin.username || origin.password
      || (origin.protocol !== "https:" && !(options.sandbox && origin.protocol === "http:" && isLoopback(origin.hostname)))) {
      throw new Error("Customer OAuth requires a canonical HTTPS origin, or a sandbox loopback origin");
    }
    this.origin = origin.origin;
    this.resource = `${this.origin}/mcp`;
    this.#store = options.store;
    this.#pilotStore = options.pilotStore;
    this.#sandbox = options.sandbox ?? false;
    this.#now = options.now ?? (() => new Date());
  }

  protectedResourceMetadata(): Record<string, unknown> {
    return { resource: this.resource, authorization_servers: [this.origin], scopes_supported: [...BOOKING_SCOPES], bearer_methods_supported: ["header"] };
  }

  authorizationServerMetadata(): Record<string, unknown> {
    return {
      issuer: this.origin, authorization_endpoint: `${this.origin}/oauth/authorize`, token_endpoint: `${this.origin}/oauth/token`,
      registration_endpoint: `${this.origin}/oauth/register`, revocation_endpoint: `${this.origin}/oauth/revoke`,
      scopes_supported: [...BOOKING_SCOPES], response_types_supported: ["code"], response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"], revocation_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
    };
  }

  challengeHeader(scopes: readonly string[] = BOOKING_SCOPES, error?: "invalid_token" | "insufficient_scope"): string {
    if (scopes.some((scope) => !supportedScope(scope))) throw new Error("Unknown booking scope");
    return `Bearer resource_metadata="${this.origin}/.well-known/oauth-protected-resource", scope="${scopes.join(" ")}"${error ? `, error="${error}"` : ""}`;
  }

  async register(input: unknown): Promise<RegisteredPublicClient> {
    const now = this.#now();
    await this.#rate("register", 30, now, 60 * 60_000);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw invalidMetadata();
    const data = input as Record<string, unknown>;
    const name = data.client_name === undefined ? "MCP client" : data.client_name;
    if (typeof name !== "string" || !name.trim() || name.length > 160 || /[\u0000-\u001f\u007f]/.test(name)
      || (data.token_endpoint_auth_method !== undefined && data.token_endpoint_auth_method !== "none")
      || (data.grant_types !== undefined && !supportedArray(data.grant_types, ["authorization_code", "refresh_token"], "authorization_code"))
      || (data.response_types !== undefined && !supportedArray(data.response_types, ["code"], "code"))
      || data.client_secret !== undefined || data.client_id !== undefined) throw invalidMetadata();
    if (data.scope !== undefined) {
      if (typeof data.scope !== "string") throw invalidMetadata();
      parseScopes(data.scope);
    }
    const redirects = data.redirect_uris;
    if (!Array.isArray(redirects) || redirects.length === 0 || redirects.length > 10
      || new Set(redirects).size !== redirects.length || redirects.some((uri) => !validRedirect(uri, this.#sandbox))) {
      throw new CustomerOAuthError(400, "invalid_redirect_uri", "Register one to ten distinct HTTPS callback URLs without credentials or fragments.");
    }
    const client = await database(this.#store.clients.register({ id: randomUUID(), name: name.trim(), redirectUris: redirects as string[], now }));
    return { client_id: client.id, client_name: client.name, redirect_uris: [...client.redirectUris], client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], scope: BOOKING_SCOPES.join(" ") };
  }

  async startAuthorization(params: URLSearchParams, browserNonce: string): Promise<{ requestToken: string; expiresAt: Date }> {
    validateParams(params);
    if (!validToken(browserNonce)) throw invalidRequest();
    const now = this.#now();
    await this.#rate("authorize", 300, now);
    await this.#rate(`authorize:browser:${browserNonce}`, 20, now);
    if (params.get("response_type") !== "code") throw new CustomerOAuthError(400, "unsupported_response_type", "Use the authorization code flow.");
    if (params.has("response_mode") && params.get("response_mode") !== "query") throw invalidRequest();
    const clientId = required(params, "client_id", 128);
    const redirectUri = required(params, "redirect_uri", 2048);
    const client = await database(this.#store.clients.get(clientId));
    // All request errors stay on Porter. Never redirect to an unvalidated URL.
    if (!client || !client.redirectUris.includes(redirectUri) || !validRedirect(redirectUri, this.#sandbox)) throw invalidRequest();
    this.#resource(params);
    const challenge = required(params, "code_challenge", 43);
    if (params.get("code_challenge_method") !== "S256" || !validToken(challenge)) throw invalidRequest();
    const scopes = parseScopes(params.get("scope"));
    const state = params.get("state");
    if (state !== null && (state.length > 1024 || /[^\x20-\x7e]/.test(state))) throw invalidRequest();
    const requestToken = opaqueToken();
    const expiresAt = after(now, REQUEST_LIFETIME);
    await database(this.#store.requests.issue({ requestHash: tokenHash(requestToken), browserNonceHash: tokenHash(browserNonce),
      clientId, redirectUri, resource: this.resource, scopes, codeChallenge: challenge, state, expiresAt, now }));
    return { requestToken, expiresAt };
  }

  async authorization(requestToken: string, browserNonce: string): Promise<CustomerConsentView | null> {
    if (!validToken(requestToken) || !validToken(browserNonce)) return null;
    const request = await database(this.#store.requests.get(tokenHash(requestToken), tokenHash(browserNonce), this.#now()));
    if (!request || request.resource !== this.resource) return null;
    const client = await database(this.#store.clients.get(request.clientId));
    if (!client || !client.redirectUris.includes(request.redirectUri) || !validRedirect(request.redirectUri, this.#sandbox)) return null;
    return { requestToken, clientId: client.id, clientName: client.name, clientVerified: false, redirectUri: request.redirectUri,
      redirectOrigin: new URL(request.redirectUri).origin, resource: request.resource, scopes: [...request.scopes], expiresAt: request.expiresAt };
  }

  async decide(session: PilotSession, requestToken: string, browserNonce: string, approved: boolean): Promise<{ redirectUrl: string }> {
    if (typeof approved !== "boolean" || !validToken(requestToken) || !validToken(browserNonce)) throw invalidRequest();
    // The view check also revalidates issuer/redirect policy if deployment configuration changed.
    if (!await this.authorization(requestToken, browserNonce)) throw invalidRequest();
    const now = this.#now();
    const binding = { requestHash: tokenHash(requestToken), browserNonceHash: tokenHash(browserNonce), userId: session.userId, sessionHash: session.sessionHash, now };
    const code = approved ? opaqueToken() : null;
    const request = await database(code
      ? this.#store.requests.approve({ ...binding, codeHash: tokenHash(code), codeExpiresAt: after(now, CODE_LIFETIME) })
      : this.#store.requests.deny(binding));
    if (!request) throw new CustomerOAuthError(400, "invalid_request", "This authorization request or sign-in session has expired or was already used.");
    const redirect = new URL(request.redirectUri);
    if (code) redirect.searchParams.set("code", code);
    else redirect.searchParams.set("error", "access_denied");
    if (request.state !== null) redirect.searchParams.set("state", request.state);
    redirect.searchParams.set("iss", this.origin);
    return { redirectUrl: redirect.href };
  }

  async token(params: URLSearchParams): Promise<CustomerTokenResponse> {
    validateParams(params);
    if (params.has("client_secret") || params.has("client_assertion")) throw invalidClient();
    const now = this.#now();
    await this.#rate("token", 1000, now);
    const clientId = required(params, "client_id", 128);
    if (!await database(this.#store.clients.get(clientId))) throw invalidClient();
    await this.#rate(`token:client:${clientId}`, 300, now);
    this.#resource(params);
    const access = opaqueToken();
    const refresh = opaqueToken();
    const expiresAt = after(now, ACCESS_LIFETIME);
    let grant: OAuthGrant | null;
    if (params.get("grant_type") === "authorization_code") {
      const code = required(params, "code", 128);
      const verifier = required(params, "code_verifier", 128);
      const redirectUri = required(params, "redirect_uri", 2048);
      if (!validToken(code) || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw invalidGrant();
      if (params.has("scope")) throw invalidRequest();
      grant = await database(this.#store.tokens.exchangeCode({ codeHash: tokenHash(code), clientId, redirectUri, resource: this.resource,
        codeChallenge: createHash("sha256").update(verifier, "ascii").digest("base64url"), grantId: randomUUID(),
        accessTokenHash: tokenHash(access), accessExpiresAt: expiresAt, refreshTokenHash: tokenHash(refresh), refreshExpiresAt: after(now, GRANT_LIFETIME), now }));
    } else if (params.get("grant_type") === "refresh_token") {
      const previous = required(params, "refresh_token", 128);
      if (!validToken(previous)) throw invalidGrant();
      const scopes = params.has("scope") ? parseScopes(params.get("scope")) : undefined;
      grant = await database(this.#store.tokens.refresh({ refreshTokenHash: tokenHash(previous), clientId, resource: this.resource,
        accessTokenHash: tokenHash(access), accessExpiresAt: expiresAt, newRefreshTokenHash: tokenHash(refresh), scopes, now }));
    } else {
      throw new CustomerOAuthError(400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
    }
    if (!grant) throw invalidGrant();
    return { access_token: access, token_type: "Bearer", expires_in: Math.max(0, Math.floor((Math.min(expiresAt.getTime(), grant.expiresAt.getTime()) - now.getTime()) / 1000)),
      refresh_token: refresh, scope: grant.scopes.join(" ") };
  }

  async authenticate(header: string | undefined): Promise<{ userId: string; scopes: readonly string[]; method: "oauth" } | null> {
    const match = header?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i);
    if (!match) return null;
    const grant = await database(this.#store.tokens.lookupAccess(tokenHash(match[1]!), this.resource, this.#now()));
    if (!grant || grant.scopes.some((scope) => !supportedScope(scope))) return null;
    return { userId: grant.userId, scopes: [...grant.scopes], method: "oauth" };
  }

  async revoke(params: URLSearchParams): Promise<void> {
    validateParams(params);
    if (params.has("client_secret") || params.has("client_assertion")) throw invalidClient();
    const now = this.#now();
    await this.#rate("revoke", 1000, now);
    const clientId = required(params, "client_id", 128);
    if (!await database(this.#store.clients.get(clientId))) throw invalidClient();
    const token = required(params, "token", 2048);
    // RFC 7009: unknown token and unknown token_type_hint have the same success response.
    if (validToken(token)) await database(this.#store.tokens.revoke({ tokenHash: tokenHash(token), clientId, now }));
  }

  async connections(session: PilotSession): Promise<CustomerConnectionView[]> {
    const now = this.#now();
    await this.#liveSession(session, now);
    const grants = await database(this.#store.grants.list(session.userId, now));
    const views = await Promise.all(grants.map(async (grant) => {
      const client = await database(this.#store.clients.get(grant.clientId));
      return { id: grant.id, clientName: client?.name ?? "MCP client", clientVerified: false as const,
        redirectOrigins: [...new Set(client?.redirectUris.map((uri) => new URL(uri).origin) ?? [])],
        scopes: [...grant.scopes], createdAt: grant.createdAt, expiresAt: grant.expiresAt };
    }));
    await this.#liveSession(session, this.#now());
    return views;
  }

  async revokeConnection(session: PilotSession, grantId: string): Promise<boolean> {
    const now = this.#now();
    await this.#liveSession(session, now);
    if (!grantId || grantId.length > 128) throw invalidRequest();
    return database(this.#store.grants.revoke({ userId: session.userId, sessionHash: session.sessionHash, grantId, now }));
  }

  #resource(params: URLSearchParams): void {
    if (params.get("resource") !== this.resource) throw new CustomerOAuthError(400, "invalid_target", "Request access to this Porter's MCP resource.");
  }

  async #liveSession(session: PilotSession, now: Date): Promise<void> {
    const live = await database(this.#pilotStore.sessions.lookup(session.sessionHash, now));
    if (!live || live.userId !== session.userId) throw new CustomerOAuthError(401, "login_required", "Sign in to manage your connections.");
  }

  async #rate(key: string, limit: number, now: Date, windowMs = RATE_WINDOW): Promise<void> {
    if (!await database(this.#pilotStore.rateLimits.take({ keyHash: tokenHash(`customer-oauth:${key}`), limit, windowMs, now }))) {
      throw new CustomerOAuthError(429, "temporarily_unavailable", "Too many requests. Please try again later.");
    }
  }
}

function after(now: Date, milliseconds: number): Date { return new Date(now.getTime() + milliseconds); }
function isLoopback(hostname: string): boolean { return ["localhost", "127.0.0.1", "[::1]"].includes(hostname); }
function supportedScope(scope: string): boolean { return (BOOKING_SCOPES as readonly string[]).includes(scope); }
function supportedArray(value: unknown, allowed: readonly string[], requiredValue: string): boolean {
  return Array.isArray(value) && value.includes(requiredValue) && value.length <= allowed.length
    && new Set(value).size === value.length && value.every((entry) => typeof entry === "string" && allowed.includes(entry));
}
function validRedirect(value: unknown, sandbox: boolean): value is string {
  if (typeof value !== "string" || value.length > 2048 || !/^https?:\/\/[^/]/.test(value)
    || /[\s\\\u0000-\u001f\u007f]/.test(value) || value.includes("#")) return false;
  try {
    const url = new URL(value);
    // Reject response parameter collisions so the callback has only our state/code/issuer.
    return !url.username && !url.password && !["code", "state", "iss", "error", "error_description"].some((key) => url.searchParams.has(key))
      && (url.protocol === "https:" || (sandbox && url.protocol === "http:" && isLoopback(url.hostname)));
  } catch { return false; }
}
function parseScopes(value: string | null): string[] {
  if (value === null) return [...BOOKING_SCOPES];
  const scopes = value.split(" ");
  if (scopes.length === 0 || scopes.length > BOOKING_SCOPES.length || new Set(scopes).size !== scopes.length || scopes.some((scope) => !supportedScope(scope))) {
    throw new CustomerOAuthError(400, "invalid_scope", "Request bookings:read and/or bookings:write.");
  }
  return scopes;
}
function validateParams(params: URLSearchParams): void {
  if (params.toString().length > 16_384) throw invalidRequest();
  for (const key of new Set(params.keys())) if (params.getAll(key).length !== 1) throw invalidRequest();
}
function required(params: URLSearchParams, key: string, max: number): string {
  const value = params.get(key);
  if (!value || value.length > max) throw invalidRequest();
  return value;
}
async function database<T>(operation: Promise<T>): Promise<T> {
  try { return await operation; } catch {
    // No database error, query, token hash, or connection string crosses the OAuth boundary.
    throw new CustomerOAuthError(503, "temporarily_unavailable", "Authorization is temporarily unavailable. Please try again later.");
  }
}
function invalidRequest(): CustomerOAuthError { return new CustomerOAuthError(400, "invalid_request", "The authorization request is missing, invalid, or expired."); }
function invalidMetadata(): CustomerOAuthError { return new CustomerOAuthError(400, "invalid_client_metadata", "Register a public authorization-code client with a short display name."); }
function invalidGrant(): CustomerOAuthError { return new CustomerOAuthError(400, "invalid_grant", "The authorization grant is invalid, expired, or already used."); }
function invalidClient(): CustomerOAuthError { return new CustomerOAuthError(400, "invalid_client", "This public client is not registered or supplied unsupported credentials."); }
