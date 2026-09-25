import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { randomToken } from "@porter/shared";

/**
 * OAuth 2.1 for the MCP server, plus an API-key fallback.
 *
 * Built to the MCP authorization spec rather than to anything Muse-specific,
 * because Meta publishes no conformance profile. That means:
 *
 *   - RFC 9728 protected-resource metadata, advertised on a 401 challenge
 *   - RFC 8414 authorization-server metadata
 *   - PKCE with S256, required
 *   - dynamic client registration
 *
 * That is what Claude and ChatGPT require, and it is a strict superset of the
 * "OAuth with PKCE" option on Muse's submission form, so one implementation
 * serves all three.
 *
 * The API-key mode exists because Muse's *custom connector* flow is built
 * around keys and headers. That path needs no Meta review, so it is how Porter
 * reaches users before a directory listing exists.
 *
 * This is a self-contained authorization server suitable for local development
 * and review. Production swaps the client and token stores for Postgres.
 */

export interface RegisteredClient {
  readonly client_id: string;
  readonly client_name?: string;
  readonly redirect_uris: string[];
  readonly token_endpoint_auth_method: "none";
  readonly grant_types: string[];
  readonly response_types: string[];
  readonly created_at: number;
}

interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  userId: string;
  expiresAt: number;
}

interface AccessToken {
  userId: string;
  clientId: string;
  scope: string;
  expiresAt: number;
}

export interface AuthContext {
  readonly userId: string;
  readonly scopes: readonly string[];
  readonly method: "oauth" | "api_key";
}

export interface AuthServerOptions {
  /** Public base URL, e.g. https://porter.up.railway.app */
  readonly issuer: string;
  /** The MCP endpoint this token is valid for. RFC 8707 resource indicator. */
  readonly resource: string;
  /** Static API keys mapped to user ids, for the custom-connector path. */
  readonly apiKeys?: Readonly<Record<string, string>>;
  readonly oauthEnabled?: boolean;
  readonly accessTokenTtlMs?: number;
}

export const SCOPES = ["bookings:read", "bookings:write", "payments:write"] as const;
export type Scope = (typeof SCOPES)[number];

export class AuthServer {
  readonly #apiKeys = new Map<string, string>();
  readonly #clients = new Map<string, RegisteredClient>();
  readonly #codes = new Map<string, PendingAuthorization>();
  readonly #tokens = new Map<string, AccessToken>();
  readonly #refresh = new Map<string, { userId: string; clientId: string; scope: string }>();
  readonly #options: Required<Omit<AuthServerOptions, "apiKeys">>;

  constructor(options: AuthServerOptions) {
    this.#options = {
      issuer: options.issuer.replace(/\/$/, ""),
      resource: options.resource,
      oauthEnabled: options.oauthEnabled ?? true,
      accessTokenTtlMs: options.accessTokenTtlMs ?? 60 * 60_000,
    };
    for (const [key, userId] of Object.entries(options.apiKeys ?? {})) {
      this.#apiKeys.set(createHash("sha256").update(key).digest("hex"), userId);
    }
  }

  /** RFC 9728. Pointed at by the WWW-Authenticate header on a 401. */
  protectedResourceMetadata(): Record<string, unknown> {
    return {
      resource: this.#options.resource,
      authorization_servers: this.#options.oauthEnabled ? [this.#options.issuer] : [],
      scopes_supported: [...SCOPES],
      bearer_methods_supported: ["header"],
      resource_documentation: `${this.#options.issuer}/docs`,
    };
  }

  /** RFC 8414. */
  authorizationServerMetadata(): Record<string, unknown> {
    return {
      issuer: this.#options.issuer,
      authorization_endpoint: `${this.#options.issuer}/oauth/authorize`,
      token_endpoint: `${this.#options.issuer}/oauth/token`,
      registration_endpoint: `${this.#options.issuer}/oauth/register`,
      scopes_supported: [...SCOPES],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      // S256 only. "plain" is not offered.
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      resource_indicators_supported: true,
    };
  }

  registerClient(body: { redirect_uris?: unknown; client_name?: unknown }): RegisteredClient {
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
    if (uris.length === 0) throw new Error("redirect_uris is required");

    const client: RegisteredClient = {
      client_id: `porter_${randomUUID()}`,
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      created_at: Date.now(),
      ...(typeof body.client_name === "string" ? { client_name: body.client_name } : {}),
    };
    this.#clients.set(client.client_id, client);
    return client;
  }

  getClient(clientId: string): RegisteredClient | undefined {
    return this.#clients.get(clientId);
  }

  /**
   * Issue an authorization code.
   *
   * `userId` comes from however the deployment authenticates people. In local
   * development that is a form on the consent page; in production it is the
   * real sign-in. Porter never handles a Muse credential.
   */
  issueCode(input: { clientId: string; redirectUri: string; codeChallenge: string; codeChallengeMethod: string; scope: string; userId: string }): string {
    const client = this.#clients.get(input.clientId);
    if (!client) throw new Error("unknown client");
    if (!client.redirect_uris.includes(input.redirectUri)) throw new Error("redirect_uri mismatch");
    if (input.codeChallengeMethod !== "S256") throw new Error("code_challenge_method must be S256");
    if (!input.codeChallenge) throw new Error("code_challenge is required");

    const code = randomToken(32);
    this.#codes.set(code, {
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      scope: input.scope,
      userId: input.userId,
      expiresAt: Date.now() + 10 * 60_000, // 10 minutes, single use
    });
    return code;
  }

  exchangeCode(input: { code: string; codeVerifier: string; clientId: string; redirectUri: string }): {
    access_token: string;
    refresh_token: string;
    token_type: "Bearer";
    expires_in: number;
    scope: string;
  } {
    const pending = this.#codes.get(input.code);
    if (!pending) throw new Error("invalid_grant");
    this.#codes.delete(input.code); // single use, deleted before any other check

    if (pending.expiresAt < Date.now()) throw new Error("invalid_grant");
    if (pending.clientId !== input.clientId) throw new Error("invalid_grant");
    if (pending.redirectUri !== input.redirectUri) throw new Error("invalid_grant");

    const challenge = createHash("sha256").update(input.codeVerifier).digest("base64url");
    const a = Buffer.from(challenge);
    const b = Buffer.from(pending.codeChallenge);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("invalid_grant");

    return this.#issueTokens(pending.userId, pending.clientId, pending.scope);
  }

  refreshToken(input: { refreshToken: string; clientId: string }) {
    const row = this.#refresh.get(input.refreshToken);
    if (!row || row.clientId !== input.clientId) throw new Error("invalid_grant");
    this.#refresh.delete(input.refreshToken); // rotate
    return this.#issueTokens(row.userId, row.clientId, row.scope);
  }

  #issueTokens(userId: string, clientId: string, scope: string) {
    const accessToken = randomToken(32);
    const refreshTokenValue = randomToken(32);
    this.#tokens.set(accessToken, { userId, clientId, scope, expiresAt: Date.now() + this.#options.accessTokenTtlMs });
    this.#refresh.set(refreshTokenValue, { userId, clientId, scope });
    return {
      access_token: accessToken,
      refresh_token: refreshTokenValue,
      token_type: "Bearer" as const,
      expires_in: Math.floor(this.#options.accessTokenTtlMs / 1000),
      scope,
    };
  }

  /** Returns null when the credential is absent or invalid. */
  authenticate(authorizationHeader: string | undefined, apiKeyHeader?: string | string[]): AuthContext | null {
    if (authorizationHeader) {
      const match = /^Bearer ([^\s]+)$/i.exec(authorizationHeader);
      const value = match?.[1];
      if (value) {
        const token = this.#tokens.get(value);
        if (token && token.expiresAt > Date.now()) {
          return { userId: token.userId, scopes: token.scope.split(" ").filter(Boolean), method: "oauth" };
        }
        const userId = this.#apiKeys.get(createHash("sha256").update(value).digest("hex"));
        if (userId) return { userId, scopes: [...SCOPES], method: "api_key" };
      }
    }
    // Some custom connector UIs send a raw key as X-API-Key rather than
    // constructing an Authorization header.
    if (typeof apiKeyHeader === "string") {
      const userId = this.#apiKeys.get(createHash("sha256").update(apiKeyHeader).digest("hex"));
      if (userId) return { userId, scopes: [...SCOPES], method: "api_key" };
    }
    return null;
  }

  /** The 401 challenge that points a client at discovery. RFC 9728. */
  challengeHeader(): string {
    return `Bearer resource_metadata="${this.#options.issuer}/.well-known/oauth-protected-resource"`;
  }
}
