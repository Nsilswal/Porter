import { afterEach, describe, expect, it, vi } from "vitest";
import type { HttpClient, HttpRequest, HttpResponse } from "@porter/shared";
import { SQUARE_BUYER_SCOPES, SquareOAuthClient, SquareOAuthError, type SquareOAuthOptions } from "./oauth.js";

const NOW = new Date("2026-09-25T12:00:00Z");
const EXPIRES = "2026-10-25T12:00:00Z";
const APP = "sandbox-sq0idb-test-application";
const CALLBACK = "http://localhost:8081/auth/square/callback";
const SECRET = "test-application-secret";
const ACCESS = "test-access-token";
const REFRESH = "test-refresh-token";
const MERCHANT = "MERCHANT_TEST_1";
const STATE = "0123456789abcdef0123456789abcdef0123456789abcdef";
const TOKEN = { access_token: ACCESS, refresh_token: REFRESH, token_type: "bearer", merchant_id: MERCHANT, expires_at: EXPIRES };
const STATUS = { client_id: APP, merchant_id: MERCHANT, scopes: [...SQUARE_BUYER_SCOPES], expires_at: EXPIRES };

function response(body: unknown, status = 200): HttpResponse {
  return { body, status, headers: {} };
}

function fixture(replies: readonly HttpResponse[] = [], overrides: Partial<SquareOAuthOptions> = {}) {
  const requests: HttpRequest[] = [];
  const http: HttpClient = { async send(request) {
    requests.push(request);
    const reply = replies[requests.length - 1];
    if (!reply) throw new Error("Unexpected request");
    return reply;
  } };
  const client = new SquareOAuthClient({
    environment: "sandbox", applicationId: APP, applicationSecret: SECRET,
    redirectUri: CALLBACK, now: () => NOW, http, ...overrides,
  });
  return { client, requests };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Square merchant OAuth contract", () => {
  it.each(["sandbox", "production"] as const)("builds the %s authorization URL with only the buyer permissions and configured callback", (environment) => {
    const applicationId = environment === "sandbox" ? APP : "sq0idp-test-application";
    const redirectUri = environment === "sandbox" ? CALLBACK : "https://porter.example/auth/square/callback";
    const { client } = fixture([], { environment, applicationId, redirectUri });
    const url = new URL(client.authorizationUrl(STATE));
    expect(url.origin).toBe(environment === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com");
    expect(url.pathname).toBe("/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: applicationId, scope: SQUARE_BUYER_SCOPES.join(" "),
      session: environment === "sandbox" ? "true" : "false", state: STATE, redirect_uri: redirectUri,
    });
    expect(url.href).not.toContain(SECRET);
    expect(JSON.stringify(client)).not.toContain(SECRET);
  });

  it("exchanges once, then verifies the grant independently before returning tokens", async () => {
    const { client, requests } = fixture([response(TOKEN), response({ ...STATUS, scopes: [...STATUS.scopes].reverse() })]);
    await expect(client.exchangeCode("test-code")).resolves.toEqual({
      applicationId: APP, merchantId: MERCHANT, expiresAt: "2026-10-25T12:00:00.000Z",
      scopes: SQUARE_BUYER_SCOPES, accessToken: ACCESS, refreshToken: REFRESH,
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      method: "POST", url: "https://connect.squareupsandbox.com/oauth2/token",
      headers: { "square-version": "2025-01-23" },
      body: { client_id: APP, client_secret: SECRET, redirect_uri: CALLBACK, grant_type: "authorization_code", code: "test-code" },
    });
    expect(requests[0]?.headers).not.toHaveProperty("authorization");
    expect(requests[1]).toMatchObject({ method: "POST", url: "https://connect.squareupsandbox.com/oauth2/token/status", headers: { authorization: `Bearer ${ACCESS}` } });
  });

  it("refreshes with explicit downscoping and validates the existing merchant", async () => {
    const { client, requests } = fixture([response(TOKEN), response(STATUS)]);
    await expect(client.refreshTokens(REFRESH, MERCHANT)).resolves.toMatchObject({ merchantId: MERCHANT, accessToken: ACCESS });
    expect(requests[0]?.body).toEqual({
      client_id: APP, client_secret: SECRET, redirect_uri: CALLBACK,
      grant_type: "refresh_token", refresh_token: REFRESH, scopes: SQUARE_BUYER_SCOPES,
    });
  });

  it("refuses a refreshed grant for another merchant before requesting token status", async () => {
    const { client, requests } = fixture([response({ ...TOKEN, merchant_id: "MERCHANT_OTHER" })]);
    await expect(client.refreshTokens(REFRESH, MERCHANT)).rejects.toMatchObject({ code: "merchant_mismatch" });
    expect(requests).toHaveLength(1);
  });

  it("revokes the entire authorization explicitly using application authentication", async () => {
    const { client, requests } = fixture([response({ success: true })]);
    await client.revokeAuthorization(ACCESS);
    expect(requests[0]).toMatchObject({
      method: "POST", url: "https://connect.squareupsandbox.com/oauth2/revoke",
      headers: { authorization: `Client ${SECRET}` },
      body: { client_id: APP, access_token: ACCESS, revoke_only_access_token: false },
    });
  });

  it.each([undefined, null, false, "true"])("requires explicit revoke success (%s)", async (success) => {
    const { client } = fixture([response({ success })]);
    await expect(client.revokeAuthorization(ACCESS)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([
    [{ ...STATUS, client_id: "OTHER_APP" }, "invalid_response"],
    [{ ...STATUS, merchant_id: "OTHER_MERCHANT" }, "merchant_mismatch"],
    [{ ...STATUS, scopes: SQUARE_BUYER_SCOPES.slice(1) }, "scope_mismatch"],
    [{ ...STATUS, scopes: [...SQUARE_BUYER_SCOPES, "PAYMENTS_WRITE"] }, "scope_mismatch"],
    [{ ...STATUS, scopes: SQUARE_BUYER_SCOPES.map(() => SQUARE_BUYER_SCOPES[0]) }, "scope_mismatch"],
    [{ ...STATUS, expires_at: "" }, "invalid_response"],
    [{ ...STATUS, expires_at: NOW.toISOString() }, "unauthorized"],
    [{ ...STATUS, expires_at: "not-a-date" }, "invalid_response"],
    [{ ...STATUS, expires_at: "2026-10-25T12:00:01Z" }, "invalid_response"],
  ] as const)("rejects mismatched token metadata %#", async (status, code) => {
    const { client } = fixture([response(TOKEN), response(status)]);
    await expect(client.exchangeCode("test-code")).rejects.toMatchObject({ code });
  });

  it.each([
    { ...TOKEN, access_token: "" }, { ...TOKEN, refresh_token: undefined },
    { ...TOKEN, token_type: "mac" }, { ...TOKEN, merchant_id: null },
    { ...TOKEN, access_token: "token\r\nInjected: header" },
  ])("rejects malformed token responses before attempting verification %#", async (body) => {
    const { client, requests } = fixture([response(body)]);
    await expect(client.exchangeCode("test-code")).rejects.toMatchObject({ code: "invalid_response" });
    expect(requests).toHaveLength(1);
  });

  it("accepts variable-length tokens without guessing their format", async () => {
    const { client } = fixture([response({ ...TOKEN, access_token: "a", refresh_token: "r".repeat(2048) }), response(STATUS)]);
    await expect(client.exchangeCode("test-code")).resolves.toMatchObject({ accessToken: "a", refreshToken: "r".repeat(2048) });
  });
});

describe("Square OAuth transport and configuration boundaries", () => {
  it.each([
    { redirectUri: "https://porter.example/callback?next=https://evil.example/" },
    { redirectUri: "https://porter.example/callback#fragment" },
    { redirectUri: "https://user:secret@porter.example/callback" },
    { redirectUri: "http://porter.example/callback" },
    { redirectUri: "javascript:alert(1)" },
    { redirectUri: "http://localhost.evil.example/callback" },
    { redirectUri: "https://porter.example:443/callback" },
    { applicationId: "sq0idp-production-app" },
    { applicationSecret: "a\nb" },
    { environment: "production", applicationId: "sq0idp-production-app", redirectUri: CALLBACK },
    { environment: "production", applicationId: "sq0idp-production-app", redirectUri: "https://localhost/callback" },
    { timeoutMs: 0 }, { timeoutMs: 30_001 },
  ] as Partial<SquareOAuthOptions>[])("rejects unsafe configuration %# without including its values", (options) => {
    expect(() => fixture([], options)).toThrow("Square authorization is not configured correctly.");
  });

  it("rejects malformed state and code before network activity", async () => {
    const { client, requests } = fixture();
    expect(() => client.authorizationUrl("business-id")).toThrow(SquareOAuthError);
    expect(() => client.authorizationUrl(`${STATE}&scope=PAYMENTS_WRITE`)).toThrow(SquareOAuthError);
    await expect(client.exchangeCode("\r\ncode")).rejects.toMatchObject({ code: "invalid_request" });
    expect(requests).toEqual([]);
  });

  it.each([
    [401, { error: "invalid_grant" }, "unauthorized"],
    [400, { error: "invalid_grant" }, "unauthorized"],
    [401, { error: "invalid_client" }, "invalid_configuration"],
    [400, { error: "invalid_client" }, "invalid_configuration"],
    [400, { error: "other" }, "invalid_request"],
    [403, {}, "unauthorized"], [429, {}, "unavailable"], [500, {}, "unavailable"],
    [302, {}, "unavailable"], [200, { errors: [{ code: "OTHER" }] }, "invalid_response"],
  ] as const)("classifies failure %s without leaking or retrying", async (status, body, code) => {
    const { client, requests } = fixture([response({ ...body, error_description: `${SECRET} ${ACCESS}` }, status)]);
    const error = await client.exchangeCode("test-code").catch((error: unknown) => error);
    expect(error).toMatchObject({ code });
    expect(error).not.toHaveProperty("cause");
    expect(String(error) + JSON.stringify(error)).not.toContain(SECRET);
    expect(String(error) + JSON.stringify(error)).not.toContain(ACCESS);
    expect(requests).toHaveLength(1);
  });

  it("does not retain transport exceptions, including custom OAuth errors", async () => {
    const transportError = new SquareOAuthError("unavailable");
    transportError.message = SECRET;
    const { client } = fixture([], { http: { async send() { throw transportError; } } });
    const error = await client.exchangeCode("test-code").catch((error: unknown) => error);
    expect(error).not.toBe(transportError);
    expect(String(error) + JSON.stringify(error)).not.toContain(SECRET);
  });

  it("uses a no-redirect, no-retry default transport", async () => {
    const send = vi.fn(async () => new Response(JSON.stringify({ error: "temporary" }), { status: 503 }));
    vi.stubGlobal("fetch", send);
    const { client } = fixture([], { http: undefined });
    await expect(client.exchangeCode("test-code")).rejects.toMatchObject({ code: "unavailable" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", method: "POST" });
  });

  it("does not dispatch a request with an already aborted signal", async () => {
    const { client, requests } = fixture();
    await expect(client.exchangeCode("test-code", AbortSignal.abort(SECRET))).rejects.toMatchObject({ code: "cancelled" });
    expect(requests).toEqual([]);
  });

  it("bounds transport time and aborts the request even if an injected transport ignores cancellation", async () => {
    vi.useFakeTimers();
    let observed: AbortSignal | undefined;
    const { client } = fixture([], { timeoutMs: 50, http: { send(request) { observed = request.signal; return new Promise(() => undefined); } } });
    const pending = expect(client.exchangeCode("test-code")).rejects.toMatchObject({ code: "unavailable" });
    await vi.advanceTimersByTimeAsync(50);
    await pending;
    expect(observed?.aborted).toBe(true);
  });

  it("propagates caller cancellation without exposing its reason", async () => {
    const controller = new AbortController();
    const { client } = fixture([], { http: { send() { return new Promise(() => undefined); } } });
    const pending = expect(client.exchangeCode("test-code", controller.signal)).rejects.toMatchObject({ code: "cancelled" });
    controller.abort(SECRET);
    await pending;
  });
});
