import { createFetchHttpClient, type HttpClient, type HttpResponse } from "@porter/shared";

export const SQUARE_BUYER_SCOPES = Object.freeze([
  "APPOINTMENTS_BUSINESS_SETTINGS_READ",
  "APPOINTMENTS_READ",
  "APPOINTMENTS_WRITE",
  "CUSTOMERS_READ",
  "CUSTOMERS_WRITE",
  "ITEMS_READ",
  "MERCHANT_PROFILE_READ",
] as const);

export type SquareEnvironment = "sandbox" | "production";
export type SquareOAuthFailure = "invalid_configuration" | "invalid_request" | "invalid_response" |
  "unauthorized" | "scope_mismatch" | "merchant_mismatch" | "unavailable" | "cancelled";

const MESSAGES: Record<SquareOAuthFailure, string> = {
  invalid_configuration: "Square authorization is not configured correctly.",
  invalid_request: "Restart the Square connection from your Porter dashboard.",
  invalid_response: "Square returned an authorization response that could not be verified.",
  unauthorized: "Square access is no longer valid. Reconnect your account.",
  scope_mismatch: "Square access does not match the permissions required by Porter.",
  merchant_mismatch: "The connected Square account does not match this business.",
  unavailable: "Square authorization is unavailable. Try again in a moment.",
  cancelled: "The Square authorization request was cancelled.",
};

/** Never retains provider bodies, credentials, or exception causes. */
export class SquareOAuthError extends Error {
  constructor(readonly code: SquareOAuthFailure) {
    super(MESSAGES[code]);
    this.name = "SquareOAuthError";
  }
}

export interface SquareOAuthTokenStatus {
  readonly applicationId: string;
  readonly merchantId: string;
  readonly expiresAt: string;
  readonly scopes: readonly string[];
}

/** Server-only result: encrypt tokens before persistence; never serialize to a browser or logs. */
export interface SquareOAuthTokens extends SquareOAuthTokenStatus {
  readonly accessToken: string;
  readonly refreshToken: string;
}

export interface SquareOAuthOptions {
  readonly environment: SquareEnvironment;
  readonly applicationId: string;
  readonly applicationSecret: string;
  readonly redirectUri: string;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  /** Trusted test transport. It must not follow redirects or retry requests. */
  readonly http?: HttpClient;
}

const ORIGINS = {
  sandbox: "https://connect.squareupsandbox.com",
  production: "https://connect.squareup.com",
} as const;
const API_VERSION = "2025-01-23";

/**
 * Confidential-client code flow. The caller owns single-use state, owner/session
 * binding, encrypted persistence, and refresh/disconnect concurrency control.
 * https://developer.squareup.com/docs/oauth-api/overview
 */
export class SquareOAuthClient {
  readonly #environment: SquareEnvironment;
  readonly #applicationId: string;
  readonly #applicationSecret: string;
  readonly #redirectUri: string;
  readonly #http: HttpClient;
  readonly #timeoutMs: number;
  readonly #now: () => Date;

  constructor(options: SquareOAuthOptions) {
    const timeoutMs = options.timeoutMs ?? 12_000;
    if ((options.environment !== "sandbox" && options.environment !== "production") || !isOpaque(options.applicationId) ||
      !isOpaque(options.applicationSecret) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 ||
      options.applicationId.startsWith("sandbox-") !== (options.environment === "sandbox")) {
      throw new SquareOAuthError("invalid_configuration");
    }
    validateCallback(options.redirectUri, options.environment);
    this.#environment = options.environment;
    this.#applicationId = options.applicationId;
    this.#applicationSecret = options.applicationSecret;
    this.#redirectUri = options.redirectUri;
    this.#timeoutMs = timeoutMs;
    this.#now = options.now ?? (() => new Date());
    this.#http = options.http ?? createFetchHttpClient({
      timeoutMs,
      maxRetries: 0,
      // Credentials must never follow a provider redirect to another origin.
      fetchImpl: (input, init) => fetch(input, { ...init, redirect: "error" }),
    });
  }

  authorizationUrl(state: string): string {
    // State is an opaque random value; business IDs and return URLs belong in
    // server-side state storage, never in an unsigned redirect parameter.
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(state)) throw new SquareOAuthError("invalid_request");
    const url = new URL("/oauth2/authorize", ORIGINS[this.#environment]);
    url.search = new URLSearchParams({
      client_id: this.#applicationId,
      scope: SQUARE_BUYER_SCOPES.join(" "),
      session: this.#environment === "production" ? "false" : "true",
      state,
      redirect_uri: this.#redirectUri,
    }).toString();
    return url.href;
  }

  async exchangeCode(code: string, signal?: AbortSignal): Promise<SquareOAuthTokens> {
    if (!isOpaque(code) || code.length > 191) throw new SquareOAuthError("invalid_request");
    return this.#obtain({ grant_type: "authorization_code", code }, undefined, signal);
  }

  async refreshTokens(refreshToken: string, expectedMerchantId: string, signal?: AbortSignal): Promise<SquareOAuthTokens> {
    if (!isOpaque(refreshToken) || !isOpaque(expectedMerchantId)) throw new SquareOAuthError("invalid_request");
    // Explicit downscoping prevents renewal from acquiring permissions added
    // to an older merchant grant outside this pilot's permission contract.
    return this.#obtain({ grant_type: "refresh_token", refresh_token: refreshToken, scopes: SQUARE_BUYER_SCOPES }, expectedMerchantId, signal);
  }

  async getTokenStatus(accessToken: string, expectedMerchantId?: string, signal?: AbortSignal): Promise<SquareOAuthTokenStatus> {
    if (!isOpaque(accessToken) || (expectedMerchantId !== undefined && !isOpaque(expectedMerchantId))) {
      throw new SquareOAuthError("invalid_request");
    }
    const body = await this.#send("/oauth2/token/status", undefined, `Bearer ${accessToken}`, signal);
    if (body.client_id !== this.#applicationId || !isOpaque(body.merchant_id)) throw new SquareOAuthError("invalid_response");
    if (expectedMerchantId !== undefined && body.merchant_id !== expectedMerchantId) throw new SquareOAuthError("merchant_mismatch");
    const scopes = body.scopes;
    if (!Array.isArray(scopes) || scopes.length !== SQUARE_BUYER_SCOPES.length ||
      new Set(scopes).size !== SQUARE_BUYER_SCOPES.length || !SQUARE_BUYER_SCOPES.every((scope) => scopes.includes(scope))) {
      throw new SquareOAuthError("scope_mismatch");
    }
    return {
      applicationId: this.#applicationId,
      merchantId: body.merchant_id,
      expiresAt: this.#expiry(body.expires_at),
      scopes: [...SQUARE_BUYER_SCOPES],
    };
  }

  /** Revokes the complete app/merchant grant, including its refresh tokens. */
  async revokeAuthorization(accessToken: string, signal?: AbortSignal): Promise<void> {
    if (!isOpaque(accessToken)) throw new SquareOAuthError("invalid_request");
    const body = await this.#send("/oauth2/revoke", {
      client_id: this.#applicationId,
      access_token: accessToken,
      revoke_only_access_token: false,
    }, `Client ${this.#applicationSecret}`, signal);
    if (body.success !== true) throw new SquareOAuthError("invalid_response");
  }

  async #obtain(grant: Record<string, unknown>, expectedMerchantId?: string, signal?: AbortSignal): Promise<SquareOAuthTokens> {
    const body = await this.#send("/oauth2/token", {
      client_id: this.#applicationId,
      client_secret: this.#applicationSecret,
      redirect_uri: this.#redirectUri,
      ...grant,
    }, undefined, signal);
    if (!isOpaque(body.access_token) || !isOpaque(body.refresh_token) || !isOpaque(body.merchant_id) ||
      body.token_type !== "bearer") throw new SquareOAuthError("invalid_response");
    if (expectedMerchantId !== undefined && body.merchant_id !== expectedMerchantId) throw new SquareOAuthError("merchant_mismatch");
    const expiresAt = this.#expiry(body.expires_at);
    const status = await this.getTokenStatus(body.access_token, body.merchant_id, signal);
    if (status.expiresAt !== expiresAt) throw new SquareOAuthError("invalid_response");
    return { ...status, accessToken: body.access_token, refreshToken: body.refresh_token };
  }

  #expiry(value: unknown): string {
    // A non-expiring personal token is not a merchant OAuth connection.
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
      throw new SquareOAuthError("invalid_response");
    }
    const expiresAt = Date.parse(value);
    const now = this.#now().getTime();
    if (!Number.isFinite(expiresAt) || !Number.isFinite(now) || expiresAt <= now) throw new SquareOAuthError("unauthorized");
    return new Date(expiresAt).toISOString();
  }

  async #send(path: string, body: unknown, authorization?: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (signal?.aborted) throw new SquareOAuthError("cancelled");
    const controller = new AbortController();
    let interruption: "cancelled" | "unavailable" | undefined;
    let fail: (error: SquareOAuthError) => void = () => undefined;
    const interrupted = new Promise<never>((_resolve, reject) => { fail = reject; });
    const cancel = () => { interruption = "cancelled"; controller.abort(); fail(new SquareOAuthError("cancelled")); };
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => { interruption = "unavailable"; controller.abort(); fail(new SquareOAuthError("unavailable")); }, this.#timeoutMs);
    let response: HttpResponse;
    try {
      response = await Promise.race([
        this.#http.send({
          method: "POST",
          url: `${ORIGINS[this.#environment]}${path}`,
          headers: { "square-version": API_VERSION, ...(authorization === undefined ? {} : { authorization }) },
          ...(body === undefined ? {} : { body }),
          signal: controller.signal,
        }),
        interrupted,
      ]);
    } catch {
      // Even a transport exception's cause may contain credentials or a URL.
      throw new SquareOAuthError(interruption ?? "unavailable");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      // Inspect only known codes; never copy the provider description into an error.
      const errorBody = response.body && typeof response.body === "object" ? response.body as Record<string, unknown> : {};
      if (errorBody.error === "invalid_client") throw new SquareOAuthError("invalid_configuration");
      if (errorBody.error === "invalid_grant" || response.status === 401 || response.status === 403) throw new SquareOAuthError("unauthorized");
      throw new SquareOAuthError("invalid_request");
    }
    if (response.status !== 200) throw new SquareOAuthError("unavailable");
    if (!response.body || typeof response.body !== "object" || Array.isArray(response.body)) throw new SquareOAuthError("invalid_response");
    const payload = response.body as Record<string, unknown>;
    if (payload.errors !== undefined && (!Array.isArray(payload.errors) || payload.errors.length > 0)) {
      throw new SquareOAuthError("invalid_response");
    }
    return payload;
  }
}

function isOpaque(value: unknown): value is string {
  // No fixed token length or prefix: Square token formats can change.
  return typeof value === "string" && value.length > 0 && !/[\s\x00-\x1f\x7f]/.test(value);
}

function validateCallback(value: string, environment: SquareEnvironment): void {
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (value !== url.href || url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(environment === "sandbox" && loopback && url.protocol === "http:")) ||
      (environment === "production" && loopback)) throw new Error();
  } catch {
    throw new SquareOAuthError("invalid_configuration");
  }
}
