import { SquareOAuthError, type SquareOAuthClient, type SquareOAuthTokens } from "@porter/adapter-square-appointments";
import type { MerchantCredentials, NewMerchantCredentials, PilotSession, PilotStore, SquareEnvironment } from "@porter/db";
import { PorterError } from "@porter/shared";
import { opaqueToken, PilotHttpError, tokenHash, validToken } from "./security.js";

type OAuth = Pick<SquareOAuthClient, "authorizationUrl" | "exchangeCode" | "refreshTokens" | "revokeAuthorization">;

export interface MerchantConnectionsOptions {
  readonly store: PilotStore;
  readonly oauth: OAuth;
  readonly environment: SquareEnvironment;
  readonly now?: () => Date;
}

const STATE_LIFETIME_MS = 10 * 60_000;
const REFRESH_INTERVAL_MS = 7 * 86_400_000;
const EXPIRY_MARGIN_MS = 86_400_000;

/** Server-only OAuth orchestration. Its credential result must never enter an HTTP response. */
export class MerchantConnections {
  readonly #store: PilotStore;
  readonly #oauth: OAuth;
  readonly #environment: SquareEnvironment;
  readonly #now: () => Date;
  readonly #refreshes = new Map<string, Promise<MerchantCredentials>>();
  readonly #revocations = new Map<string, Promise<void>>();

  constructor(options: MerchantConnectionsOptions) {
    this.#store = options.store;
    this.#oauth = options.oauth;
    this.#environment = options.environment;
    this.#now = options.now ?? (() => new Date());
  }

  async start(session: PilotSession, businessId: string): Promise<string> {
    await this.#authorize(session, businessId);
    const current = await this.#store.connections.get(session.userId, businessId, this.#environment);
    if (current?.status === "disconnecting") throw connectionChanged();
    const state = opaqueToken();
    const authorizationUrl = this.#oauth.authorizationUrl(state);
    await this.#store.oauthStates.issue({
      stateHash: tokenHash(state), userId: session.userId, sessionHash: session.sessionHash,
      businessId, environment: this.#environment, connectionVersion: current?.version ?? null,
      expiresAt: new Date(this.#now().getTime() + STATE_LIFETIME_MS),
    });
    return authorizationUrl;
  }

  async callback(session: PilotSession, input: { state: string; code?: string; error?: string }): Promise<string> {
    await this.#liveSession(session);
    if (!validToken(input.state)) throw invalidState();
    // Consumption checks the owner, browser session and environment atomically.
    // Denial and malformed responses also spend valid state; a code is never retried.
    const state = await this.#store.oauthStates.consume({
      stateHash: tokenHash(input.state), userId: session.userId, sessionHash: session.sessionHash,
      environment: this.#environment, now: this.#now(),
    });
    if (!state) throw invalidState();
    await this.#authorize(session, state.businessId);
    if (input.error !== undefined) throw new PilotHttpError(400, "square_authorization_denied", "Square was not connected. You can restart the connection when ready.");
    if (!input.code) throw new PilotHttpError(400, "square_authorization_invalid", "Restart the Square connection from your dashboard.");
    const current = await this.#store.connections.get(session.userId, state.businessId, this.#environment);
    if (current?.status === "disconnecting" || (current?.version ?? null) !== state.connectionVersion) throw connectionChanged();

    let tokens: SquareOAuthTokens;
    try {
      tokens = await this.#oauth.exchangeCode(input.code);
    } catch {
      throw new PilotHttpError(502, "square_connection_failed", "Square could not be connected. Restart the connection from your dashboard.");
    }
    await this.#authorize(session, state.businessId);
    if (current && current.merchantId !== tokens.merchantId) {
      throw new PilotHttpError(409, "square_account_mismatch", "Reconnect the Square account originally linked to this business.");
    }
    try {
      // The transaction rechecks the live session and generation after exchange.
      await this.#store.connections.connect(session.userId, this.#credentialsInput(state.businessId, tokens), state.connectionVersion, session.sessionHash);
    } catch {
      throw connectionChanged();
    }
    return state.businessId;
  }

  async credentials(businessId: string, signal?: AbortSignal): Promise<MerchantCredentials> {
    if (signal?.aborted) throw unavailable();
    const current = await this.#store.connections.readCredentials(businessId, this.#environment);
    if (!current) throw unavailable();
    const now = this.#now().getTime();
    if (current.expiresAt.getTime() > now + EXPIRY_MARGIN_MS && current.refreshedAt.getTime() > now - REFRESH_INTERVAL_MS) return current;
    let pending = this.#refreshes.get(businessId);
    if (!pending) {
      pending = this.#refresh(current);
      this.#refreshes.set(businessId, pending);
      // Both handlers consume the cleanup promise, avoiding unhandled rejection.
      void pending.then(() => this.#refreshes.delete(businessId), () => this.#refreshes.delete(businessId));
    }
    // One caller's cancellation must not abort a refresh shared by other calls.
    return waitFor(pending, signal);
  }

  async disconnect(session: PilotSession, businessId: string): Promise<void> {
    await this.#authorize(session, businessId);
    await this.#revoke(session.userId, businessId);
  }

  async #refresh(current: MerchantCredentials): Promise<MerchantCredentials> {
    let tokens: SquareOAuthTokens;
    try {
      tokens = await this.#oauth.refreshTokens(current.refreshToken, current.merchantId);
    } catch (error) {
      if (error instanceof SquareOAuthError && ["unauthorized", "scope_mismatch", "merchant_mismatch"].includes(error.code)) {
        await this.#store.connections.markReconnect(current.businessId, this.#environment, current.version);
      }
      // A transient failure may use an unexpired grant. Always reread: a
      // concurrent disconnect or failed authorization must immediately block it.
      const latest = await this.#store.connections.readCredentials(current.businessId, this.#environment);
      if (latest && latest.expiresAt.getTime() > this.#now().getTime()) return latest;
      throw unavailable();
    }
    await this.#store.connections.replaceCredentials(this.#credentialsInput(current.businessId, tokens), current.version);
    // CAS may lose to a refresh, reauthorization or disconnect in another process.
    // Only the authoritative stored generation may be used after that race.
    const latest = await this.#store.connections.readCredentials(current.businessId, this.#environment);
    if (!latest || latest.expiresAt.getTime() <= this.#now().getTime()) throw unavailable();
    return latest;
  }

  #revoke(ownerId: string, businessId: string): Promise<void> {
    const existing = this.#revocations.get(businessId);
    if (existing) return existing;
    const pending = this.#performRevocation(ownerId, businessId);
    this.#revocations.set(businessId, pending);
    void pending.then(() => this.#revocations.delete(businessId), () => this.#revocations.delete(businessId));
    return pending;
  }

  async #performRevocation(ownerId: string, businessId: string): Promise<void> {
    const pending = await this.#store.connections.beginDisconnect(ownerId, businessId, this.#environment);
    if (!pending) {
      const current = await this.#store.connections.get(ownerId, businessId, this.#environment);
      if (current?.status === "disconnecting") throw disconnectNeedsReview();
      return;
    }
    try {
      await this.#oauth.revokeAuthorization(pending.accessToken);
    } catch {
      // A timeout may have revoked the grant already. Repeating full-grant
      // revocation could destroy a later authorization, so the durable claim
      // is never retried or taken over by another process.
      throw disconnectNeedsReview();
    }
    let finished: boolean;
    try {
      finished = await this.#store.connections.finishDisconnect(ownerId, businessId, this.#environment, pending.version);
    } catch {
      throw disconnectNeedsReview();
    }
    if (!finished) {
      const current = await this.#store.connections.get(ownerId, businessId, this.#environment);
      if (current?.status !== "disconnected") throw disconnectNeedsReview();
    }
  }

  #credentialsInput(businessId: string, tokens: SquareOAuthTokens): NewMerchantCredentials {
    return { businessId, environment: this.#environment, merchantId: tokens.merchantId,
      accessToken: tokens.accessToken, refreshToken: tokens.refreshToken,
      expiresAt: new Date(tokens.expiresAt), scopes: [...tokens.scopes] };
  }

  async #liveSession(session: PilotSession): Promise<void> {
    const current = await this.#store.sessions.lookup(session.sessionHash, this.#now());
    if (!current || current.userId !== session.userId) throw new PilotHttpError(401, "sign_in_required", "Sign in to Porter to continue.");
  }

  async #authorize(session: PilotSession, businessId: string): Promise<void> {
    await this.#liveSession(session);
    if (!await this.#store.businesses.get(session.userId, businessId)) throw new PilotHttpError(404, "business_not_found", "That business could not be found.");
  }
}

function unavailable(): PorterError {
  return new PorterError("PROVIDER_UNAVAILABLE", "This business's Square connection is unavailable. Please try again later.");
}

function invalidState(): PilotHttpError {
  return new PilotHttpError(400, "square_state_invalid", "This Square connection link expired or was already used. Restart from your dashboard.");
}

function connectionChanged(): PilotHttpError {
  return new PilotHttpError(409, "square_connection_changed", "The Square connection changed. Return to your dashboard before connecting again.");
}

function disconnectNeedsReview(): PilotHttpError {
  return new PilotHttpError(409, "square_disconnect_needs_review", "Booking is paused. Square disconnection needs review before this business can reconnect.");
}

/** Observe a shared operation without forwarding caller cancellation to its owner. */
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(unavailable());
  return new Promise((resolve, reject) => {
    const abort = () => reject(unavailable());
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
