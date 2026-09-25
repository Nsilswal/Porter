import { describe, expect, it, vi } from "vitest";
import { SQUARE_BUYER_SCOPES, SquareOAuthError, type SquareOAuthTokens } from "@porter/adapter-square-appointments";
import type { MerchantCredentials, NewMerchantCredentials, PilotBusiness, PilotSession, PilotStore, SquareOAuthState } from "@porter/db";
import { MerchantConnections } from "./connections.js";
import { tokenHash } from "./security.js";

const NOW = new Date("2026-09-25T12:00:00Z");
const DAY = 86_400_000;
const SESSION: PilotSession = { userId: "owner-1", sessionHash: tokenHash("session-1"), createdAt: NOW,
  expiresAt: new Date(NOW.getTime() + DAY), revokedAt: null };
const BUSINESS: PilotBusiness = { id: "business-1", ownerId: SESSION.userId, websiteUrl: "https://salon.example/", name: "Salon",
  status: "draft", selectedLocationId: null, profile: {}, createdAt: NOW, updatedAt: NOW };
const TOKENS: SquareOAuthTokens = { accessToken: "private-access-new", refreshToken: "private-refresh-new", merchantId: "merchant-1",
  applicationId: "sandbox-app", expiresAt: new Date(NOW.getTime() + 30 * DAY).toISOString(), scopes: SQUARE_BUYER_SCOPES };
const CONNECTION: MerchantCredentials = { businessId: BUSINESS.id, environment: "sandbox", merchantId: "merchant-1", status: "connected", version: 1,
  accessToken: "private-access-original", refreshToken: "private-refresh-original", scopes: [...SQUARE_BUYER_SCOPES],
  expiresAt: new Date(NOW.getTime() + 20 * DAY), createdAt: NOW, updatedAt: NOW, refreshedAt: new Date(NOW.getTime() - 8 * DAY) };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(initial: MerchantCredentials | null = null) {
  let now = NOW;
  let current = initial ? structuredClone(initial) : null;
  let live = true;
  const sessions = new Map([[SESSION.sessionHash, SESSION]]);
  const states = new Map<string, SquareOAuthState>();
  const oauth = {
    authorizationUrl: vi.fn((state: string) => `https://connect.squareupsandbox.com/oauth2/authorize?state=${state}`),
    exchangeCode: vi.fn(async () => TOKENS), refreshTokens: vi.fn(async () => TOKENS), revokeAuthorization: vi.fn(async () => undefined),
  };
  const connections = {
    get: vi.fn(async (ownerId: string, businessId: string) => ownerId === SESSION.userId && businessId === BUSINESS.id ? structuredClone(current) : null),
    connect: vi.fn(async (ownerId: string, input: NewMerchantCredentials, version: number | null, sessionHash: string) => {
      if (!live || sessions.get(sessionHash)?.userId !== ownerId || (current?.version ?? null) !== version || current?.status === "disconnecting" ||
        (current && current.merchantId !== input.merchantId)) throw new Error("Storage conflict");
      current = { ...input, version: (version ?? 0) + 1, status: "connected", createdAt: now, updatedAt: now, refreshedAt: now };
      return structuredClone(current);
    }),
    readCredentials: vi.fn(async (businessId: string, environment: string) =>
      live && current?.businessId === businessId && current.environment === environment && current.status === "connected" ? structuredClone(current) : null),
    replaceCredentials: vi.fn(async (input: NewMerchantCredentials, version: number) => {
      if (!current || current.version !== version || current.status !== "connected" || current.merchantId !== input.merchantId) return null;
      current = { ...current, ...input, version: version + 1, refreshedAt: now, updatedAt: now };
      return structuredClone(current);
    }),
    markReconnect: vi.fn(async (_businessId: string, _environment: string, version: number) => {
      if (current?.version !== version || current.status !== "connected") return false;
      current = { ...current, status: "reconnect_required", version: version + 1 };
      return true;
    }),
    beginDisconnect: vi.fn(async (ownerId: string, businessId: string) => {
      if (ownerId !== SESSION.userId || businessId !== BUSINESS.id || !current || current.status === "disconnected" || current.status === "disconnecting") return null;
      current = { ...current, status: "disconnecting", version: current.version + 1 };
      return structuredClone(current);
    }),
    finishDisconnect: vi.fn(async (_ownerId: string, _businessId: string, _environment: string, version: number) => {
      if (!current || current.status !== "disconnecting" || current.version !== version) return false;
      current = { ...current, status: "disconnected", version: version + 1, accessToken: "", refreshToken: "" };
      return true;
    }),
    listPendingRevocations: vi.fn(async () => current?.status === "disconnecting" ? [structuredClone(current)] : []),
  };
  const store = {
    sessions: { lookup: vi.fn(async (hash: string, at: Date) => {
      const session = sessions.get(hash);
      return live && session && session.expiresAt > at ? session : null;
    }) },
    businesses: {
      get: vi.fn(async (ownerId: string, businessId: string) => live && ownerId === BUSINESS.ownerId && businessId === BUSINESS.id ? BUSINESS : null),
      getById: vi.fn(async (businessId: string) => live && businessId === BUSINESS.id ? BUSINESS : null),
    },
    oauthStates: {
      issue: vi.fn(async (state: SquareOAuthState) => { states.set(state.stateHash, state); }),
      consume: vi.fn(async (input: { stateHash: string; userId: string; sessionHash: string; environment: string; now: Date }) => {
        const state = states.get(input.stateHash);
        if (!live || !state || state.userId !== input.userId || state.sessionHash !== input.sessionHash ||
          state.environment !== input.environment || state.expiresAt <= input.now) return null;
        states.delete(input.stateHash);
        return state;
      }),
    }, connections,
  };
  const newService = () => new MerchantConnections({ store: store as unknown as PilotStore, oauth, environment: "sandbox", now: () => now });
  const service = newService();
  return { service, newService, oauth, store, states, sessions, get current() { return current; },
    setCurrent(value: MerchantCredentials) { current = structuredClone(value); },
    setNow(value: Date) { now = value; }, revokeSession() { live = false; },
    async state() { return new URL(await service.start(SESSION, BUSINESS.id)).searchParams.get("state")!; },
  };
}

describe("merchant Square authorization orchestration", () => {
  it("stores only hashed state bound to owner, session, business, environment and connection generation", async () => {
    const f = fixture(CONNECTION);
    const state = await f.state();
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(f.store.oauthStates.issue).toHaveBeenCalledWith({
      stateHash: tokenHash(state), userId: SESSION.userId, sessionHash: SESSION.sessionHash,
      businessId: BUSINESS.id, environment: "sandbox", connectionVersion: 1, expiresAt: new Date(NOW.getTime() + 10 * 60_000),
    });
    expect(JSON.stringify([...f.states.values()])).not.toContain(state);
  });

  it("persists the verified grant only once and passes the session for transactional validation", async () => {
    const f = fixture();
    const state = await f.state();
    await expect(f.service.callback(SESSION, { state, code: "code" })).resolves.toBe(BUSINESS.id);
    expect(f.store.connections.connect).toHaveBeenCalledWith(SESSION.userId, expect.objectContaining({
      businessId: BUSINESS.id, accessToken: TOKENS.accessToken, merchantId: TOKENS.merchantId,
    }), null, SESSION.sessionHash);
    await expect(f.service.callback(SESSION, { state, code: "code" })).rejects.toMatchObject({ code: "square_state_invalid" });
    expect(f.oauth.exchangeCode).toHaveBeenCalledTimes(1);
  });

  it("rejects another owner or browser session without consuming the real owner's state", async () => {
    const f = fixture();
    const state = await f.state();
    const otherOwner = { ...SESSION, userId: "owner-2", sessionHash: tokenHash("other-owner") };
    const otherBrowser = { ...SESSION, sessionHash: tokenHash("other-browser") };
    f.sessions.set(otherOwner.sessionHash, otherOwner);
    f.sessions.set(otherBrowser.sessionHash, otherBrowser);
    for (const session of [otherOwner, otherBrowser]) {
      await expect(f.service.callback(session, { state, code: "code" })).rejects.toMatchObject({ code: "square_state_invalid" });
    }
    expect(f.oauth.exchangeCode).not.toHaveBeenCalled();
    await expect(f.service.callback(SESSION, { state, code: "code" })).resolves.toBe(BUSINESS.id);
  });

  it("denial consumes valid state without echoing provider-controlled errors", async () => {
    const f = fixture();
    const state = await f.state();
    const error = await f.service.callback(SESSION, { state, error: TOKENS.accessToken }).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "square_authorization_denied" });
    expect(String(error)).not.toContain(TOKENS.accessToken);
    await expect(f.service.callback(SESSION, { state, code: "code" })).rejects.toMatchObject({ code: "square_state_invalid" });
    expect(f.oauth.exchangeCode).not.toHaveBeenCalled();
  });

  it("rejects expired state without exchange", async () => {
    const f = fixture();
    const state = await f.state();
    f.setNow(new Date(NOW.getTime() + 10 * 60_000));
    await expect(f.service.callback(SESSION, { state, code: "code" })).rejects.toMatchObject({ code: "square_state_invalid" });
    expect(f.oauth.exchangeCode).not.toHaveBeenCalled();
  });

  it("rejects stale callbacks after disconnect before exchanging their codes", async () => {
    const f = fixture(CONNECTION);
    const state = await f.state();
    await f.service.disconnect(SESSION, BUSINESS.id);
    await expect(f.service.callback(SESSION, { state, code: "code" })).rejects.toMatchObject({ code: "square_connection_changed" });
    expect(f.oauth.exchangeCode).not.toHaveBeenCalled();
  });

  it("cannot start or finish connecting while revocation is pending", async () => {
    const f = fixture(CONNECTION);
    const state = await f.state();
    f.setCurrent({ ...CONNECTION, status: "disconnecting" });
    await expect(f.state()).rejects.toMatchObject({ code: "square_connection_changed" });
    await expect(f.service.callback(SESSION, { state, code: "code" })).rejects.toMatchObject({ code: "square_connection_changed" });
    expect(f.oauth.exchangeCode).not.toHaveBeenCalled();
  });

  it("cannot reconnect a business to a different Square merchant", async () => {
    const f = fixture(CONNECTION);
    const state = await f.state();
    f.oauth.exchangeCode.mockResolvedValueOnce({ ...TOKENS, merchantId: "other-merchant" });
    await expect(f.service.callback(SESSION, { state, code: "code" })).rejects.toMatchObject({ code: "square_account_mismatch" });
    expect(f.store.connections.connect).not.toHaveBeenCalled();
    expect(f.current?.merchantId).toBe(CONNECTION.merchantId);
  });

  it("rejects a session revoked during the token exchange", async () => {
    const f = fixture();
    const state = await f.state();
    f.oauth.exchangeCode.mockImplementationOnce(async () => { f.revokeSession(); return TOKENS; });
    await expect(f.service.callback(SESSION, { state, code: "code" })).rejects.toMatchObject({ code: "sign_in_required" });
    expect(f.store.connections.connect).not.toHaveBeenCalled();
  });

  it("does not resurrect a disconnected generation when exchange finishes late", async () => {
    const f = fixture(CONNECTION);
    const state = await f.state();
    f.oauth.exchangeCode.mockImplementationOnce(async () => { await f.service.disconnect(SESSION, BUSINESS.id); return TOKENS; });
    await expect(f.service.callback(SESSION, { state, code: "code" })).rejects.toMatchObject({ code: "square_connection_changed" });
    expect(f.current?.status).toBe("disconnected");
  });
});

describe("merchant credential renewal and disconnection", () => {
  it("uses a recent, valid connection without refreshing", async () => {
    const f = fixture({ ...CONNECTION, refreshedAt: NOW });
    await expect(f.service.credentials(BUSINESS.id)).resolves.toMatchObject({ accessToken: CONNECTION.accessToken });
    expect(f.oauth.refreshTokens).not.toHaveBeenCalled();
  });

  it.each([
    CONNECTION,
    { ...CONNECTION, refreshedAt: NOW, expiresAt: new Date(NOW.getTime() + DAY) },
    { ...CONNECTION, refreshedAt: NOW, expiresAt: new Date(NOW.getTime() - 1) },
  ])("refreshes stale or expiring grants and returns only persisted credentials %#", async (connection) => {
    const f = fixture(connection);
    await expect(f.service.credentials(BUSINESS.id)).resolves.toMatchObject({ accessToken: TOKENS.accessToken, version: 2 });
    expect(f.oauth.refreshTokens).toHaveBeenCalledWith(CONNECTION.refreshToken, CONNECTION.merchantId);
    expect(f.store.connections.replaceCredentials).toHaveBeenCalledWith(expect.objectContaining({ accessToken: TOKENS.accessToken }), 1);
  });

  it("shares refresh across callers while cancellation affects only the cancelled caller", async () => {
    const f = fixture(CONNECTION);
    const grant = deferred<SquareOAuthTokens>();
    const started = deferred<void>();
    f.oauth.refreshTokens.mockImplementationOnce(() => { started.resolve(); return grant.promise; });
    const controller = new AbortController();
    const first = expect(f.service.credentials(BUSINESS.id, controller.signal)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    const second = f.service.credentials(BUSINESS.id);
    await started.promise;
    controller.abort();
    grant.resolve(TOKENS);
    await first;
    await expect(second).resolves.toMatchObject({ accessToken: TOKENS.accessToken });
    expect(f.oauth.refreshTokens).toHaveBeenCalledTimes(1);
  });

  it("keeps an unexpired connection usable after a transient refresh failure", async () => {
    const f = fixture(CONNECTION);
    f.oauth.refreshTokens.mockRejectedValueOnce(new SquareOAuthError("unavailable"));
    await expect(f.service.credentials(BUSINESS.id)).resolves.toMatchObject({ accessToken: CONNECTION.accessToken });
    expect(f.store.connections.markReconnect).not.toHaveBeenCalled();
    expect(f.current?.status).toBe("connected");
  });

  it("never returns expired credentials after a transient refresh failure", async () => {
    const f = fixture({ ...CONNECTION, expiresAt: NOW });
    f.oauth.refreshTokens.mockRejectedValueOnce(new SquareOAuthError("unavailable"));
    await expect(f.service.credentials(BUSINESS.id)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(f.current?.status).toBe("connected");
  });

  it.each(["unauthorized", "scope_mismatch", "merchant_mismatch"] as const)("requires reconnection on a confirmed %s failure", async (code) => {
    const f = fixture(CONNECTION);
    f.oauth.refreshTokens.mockRejectedValueOnce(new SquareOAuthError(code));
    await expect(f.service.credentials(BUSINESS.id)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(f.current?.status).toBe("reconnect_required");
  });

  it("rereads a newer connection if its refresh loses compare-and-swap", async () => {
    const f = fixture(CONNECTION);
    f.oauth.refreshTokens.mockImplementationOnce(async () => {
      f.setCurrent({ ...CONNECTION, version: 2, accessToken: "winning-access-token", refreshedAt: NOW });
      return TOKENS;
    });
    await expect(f.service.credentials(BUSINESS.id)).resolves.toMatchObject({ accessToken: "winning-access-token", version: 2 });
    expect(f.current?.accessToken).not.toBe(TOKENS.accessToken);
  });

  it("does not replace or return credentials after a disconnect wins a refresh race", async () => {
    const f = fixture(CONNECTION);
    f.oauth.refreshTokens.mockImplementationOnce(async () => { await f.service.disconnect(SESSION, BUSINESS.id); return TOKENS; });
    await expect(f.service.credentials(BUSINESS.id)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(f.current?.status).toBe("disconnected");
    expect(f.current?.accessToken).toBe("");
  });

  it("blocks credentials before remote revocation and never resends an uncertain write after restart", async () => {
    const f = fixture(CONNECTION);
    f.oauth.revokeAuthorization.mockImplementationOnce(async () => {
      expect(f.current?.status).toBe("disconnecting");
      await expect(f.service.credentials(BUSINESS.id)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
      throw new Error(`secret: ${TOKENS.accessToken}`);
    });
    const error = await f.service.disconnect(SESSION, BUSINESS.id).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "square_disconnect_needs_review" });
    expect(String(error)).not.toContain(TOKENS.accessToken);
    expect(f.current).toMatchObject({ status: "disconnecting", accessToken: CONNECTION.accessToken });
    await expect(f.service.disconnect(SESSION, BUSINESS.id)).rejects.toMatchObject({ code: "square_disconnect_needs_review" });
    await expect(f.newService().disconnect(SESSION, BUSINESS.id)).rejects.toMatchObject({ code: "square_disconnect_needs_review" });
    await expect(f.state()).rejects.toMatchObject({ code: "square_connection_changed" });
    expect(f.current).toMatchObject({ status: "disconnecting", accessToken: CONNECTION.accessToken });
    expect(f.oauth.revokeAuthorization).toHaveBeenCalledTimes(1);
  });

  it("coalesces simultaneous disconnection requests in one process", async () => {
    const f = fixture(CONNECTION);
    const done = deferred<void>();
    const started = deferred<void>();
    f.oauth.revokeAuthorization.mockImplementationOnce(() => { started.resolve(); return done.promise; });
    const first = f.service.disconnect(SESSION, BUSINESS.id);
    await started.promise;
    const second = f.service.disconnect(SESSION, BUSINESS.id);
    done.resolve();
    await first;
    await second;
    expect(f.oauth.revokeAuthorization).toHaveBeenCalledTimes(1);
  });

  it("claims revocation durably across service instances so a delayed duplicate cannot revoke a later grant", async () => {
    const f = fixture(CONNECTION);
    const done = deferred<void>();
    const started = deferred<void>();
    f.oauth.revokeAuthorization.mockImplementationOnce(() => { started.resolve(); return done.promise; });
    const first = f.service.disconnect(SESSION, BUSINESS.id);
    await started.promise;
    const otherProcess = f.newService();
    await expect(otherProcess.disconnect(SESSION, BUSINESS.id)).rejects.toMatchObject({ code: "square_disconnect_needs_review" });
    expect(f.oauth.revokeAuthorization).toHaveBeenCalledTimes(1);
    done.resolve();
    await first;
    expect(f.current?.status).toBe("disconnected");
    // A new authorization can proceed only after the single revoke completed.
    const state = await f.state();
    await f.service.callback(SESSION, { state, code: "new-code" });
    expect(f.current?.status).toBe("connected");
    expect(f.oauth.revokeAuthorization).toHaveBeenCalledTimes(1);
  });

  it("leaves a completed remote revocation blocked if persisting completion fails, without resending", async () => {
    const f = fixture(CONNECTION);
    f.store.connections.finishDisconnect.mockRejectedValueOnce(new Error("Database unavailable"));
    await expect(f.service.disconnect(SESSION, BUSINESS.id)).rejects.toMatchObject({ code: "square_disconnect_needs_review" });
    expect(f.current?.status).toBe("disconnecting");
    await expect(f.newService().disconnect(SESSION, BUSINESS.id)).rejects.toMatchObject({ code: "square_disconnect_needs_review" });
    expect(f.oauth.revokeAuthorization).toHaveBeenCalledTimes(1);
  });

  it("does not let another owner disconnect the merchant", async () => {
    const f = fixture(CONNECTION);
    const other = { ...SESSION, userId: "owner-2", sessionHash: tokenHash("other-owner") };
    f.sessions.set(other.sessionHash, other);
    await expect(f.service.disconnect(other, BUSINESS.id)).rejects.toMatchObject({ code: "business_not_found" });
    expect(f.store.connections.beginDisconnect).not.toHaveBeenCalled();
  });
});
