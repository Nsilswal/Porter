import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCustomerOAuthStore, createPilotStore, migratePostgres, type CustomerOAuthStore, type PilotSession, type PilotStore } from "@porter/db";
import { BOOKING_SCOPES, CustomerOAuth, type RegisteredPublicClient } from "./customer-oauth.js";
import { opaqueToken, tokenHash } from "./security.js";

const ORIGIN = "https://porter.example";
const REDIRECT = "https://agent.example/callback?channel=booking";
const NOW = new Date("2026-09-25T12:00:00Z");
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

function stub(sandbox = false) {
  const store = {
    clients: { register: vi.fn(async (input) => ({ ...input, createdAt: input.now })), get: vi.fn(async () => null) },
    requests: { issue: vi.fn() },
  } as unknown as CustomerOAuthStore;
  const pilotStore = { sessions: { lookup: vi.fn() }, rateLimits: { take: vi.fn(async () => true) } } as unknown as PilotStore;
  return { service: new CustomerOAuth({ store, pilotStore, origin: ORIGIN, sandbox, now: () => NOW }), store, pilotStore };
}

describe("customer OAuth protocol policy", () => {
  it("advertises public S256 code flow, booking scopes, resource binding and revocation", () => {
    const { service } = stub();
    expect(service.protectedResourceMetadata()).toEqual({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN],
      scopes_supported: BOOKING_SCOPES, bearer_methods_supported: ["header"] });
    expect(service.authorizationServerMetadata()).toMatchObject({ issuer: ORIGIN, code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"], grant_types_supported: ["authorization_code", "refresh_token"],
      revocation_endpoint: `${ORIGIN}/oauth/revoke`, authorization_response_iss_parameter_supported: true });
    expect(service.authorizationServerMetadata()).not.toHaveProperty("client_id_metadata_document_supported");
    expect(service.challengeHeader()).toBe(`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource", scope="bookings:read bookings:write"`);
    expect(service.challengeHeader(["bookings:write"], "insufficient_scope")).toContain('error="insufficient_scope"');
    expect(() => service.challengeHeader(['bad"scope'])).toThrow();
  });

  it.each(["http://porter.example", "https://porter.example/", "https://porter.example/path", "https://porter.example?query=x", "https://user:password@porter.example"])("rejects unsafe issuer %s", (origin) => {
    const f = stub();
    expect(() => new CustomerOAuth({ store: f.store, pilotStore: f.pilotStore, origin })).toThrow();
  });

  it("allows sandbox loopback issuers only with explicit sandbox mode", () => {
    const f = stub();
    expect(() => new CustomerOAuth({ store: f.store, pilotStore: f.pilotStore, origin: "http://127.0.0.1:3000" })).toThrow();
    expect(new CustomerOAuth({ store: f.store, pilotStore: f.pilotStore, origin: "http://127.0.0.1:3000", sandbox: true }).origin).toBe("http://127.0.0.1:3000");
  });

  it.each(["http://agent.example/callback", "http://localhost:3000/callback", "javascript:alert(1)", "https://user:password@agent.example/callback",
    "https://agent.example/callback#fragment", "https://agent.example/callback#", "https://agent.example/callback?code=fixed",
    "https://agent.example/callback?state=fixed", "https://agent.example/callback?iss=evil", "https://agent.example/callback?error=fixed",
    "https:agent.example/callback", "https:///agent.example/callback", "https://agent.example\\@evil.example/callback", "https://agent.example/call\nback"])("rejects unsafe registered redirect %s", async (redirect) => {
    const f = stub();
    await expect(f.service.register({ redirect_uris: [redirect] })).rejects.toMatchObject({ status: 400, error: "invalid_redirect_uri" });
    expect(f.store.clients.register).not.toHaveBeenCalled();
  });

  it("registers exact HTTPS and explicitly sandbox loopback callbacks without a client secret", async () => {
    const f = stub(true);
    for (const redirect of [REDIRECT, "http://localhost:9876/callback", "http://127.0.0.1:9876/callback", "http://[::1]:9876/callback"]) {
      const client = await f.service.register({ client_name: "Agent <unverified>", redirect_uris: [redirect], token_endpoint_auth_method: "none" });
      expect(client).toMatchObject({ client_name: "Agent <unverified>", redirect_uris: [redirect], token_endpoint_auth_method: "none", client_id_issued_at: NOW.getTime() / 1000 });
      expect(client).not.toHaveProperty("client_secret");
    }
    await expect(f.service.register({ redirect_uris: ["http://localhost.evil.example/callback"] })).rejects.toMatchObject({ error: "invalid_redirect_uri" });
  });

  it.each([{ token_endpoint_auth_method: "client_secret_basic" }, { grant_types: ["implicit"] }, { response_types: ["token"] },
    { client_name: "\nforged" }, { client_name: " " }, { client_secret: "never-store" }, { client_id: "claimed-id" }])("rejects unsupported registration metadata %j", async (metadata) => {
    const f = stub();
    await expect(f.service.register({ redirect_uris: [REDIRECT], ...metadata })).rejects.toMatchObject({ error: "invalid_client_metadata" });
    expect(f.store.clients.register).not.toHaveBeenCalled();
  });

  it("rejects duplicate parameters before reaching storage, including resource and grant type", async () => {
    const f = stub();
    for (const field of ["client_id", "resource", "grant_type", "code_verifier"]) {
      await expect(f.service.token(new URLSearchParams([[field, "one"], [field, "two"]]))).rejects.toMatchObject({ error: "invalid_request" });
    }
    expect(f.store.clients.get).not.toHaveBeenCalled();
  });

  it("fails closed on a shared rate limit and returns no underlying database details", async () => {
    const f = stub();
    vi.mocked(f.pilotStore.rateLimits.take).mockResolvedValueOnce(false);
    await expect(f.service.register({ redirect_uris: [REDIRECT] })).rejects.toMatchObject({ status: 429, error: "temporarily_unavailable" });
    expect(f.store.clients.register).not.toHaveBeenCalled();
    vi.mocked(f.store.clients.register).mockRejectedValueOnce(new Error("postgres://secret:password@private/query"));
    await expect(f.service.register({ redirect_uris: [REDIRECT] })).rejects.toMatchObject({ status: 503, error: "temporarily_unavailable",
      message: "Authorization is temporarily unavailable. Please try again later." });
    expect(vi.mocked(f.pilotStore.rateLimits.take).mock.calls[0]![0].keyHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("customer OAuth protocol with PostgreSQL", () => {
  const schema = `porter_customer_oauth_protocol_${randomUUID().replaceAll("-", "")}`;
  const encryptionKey = randomBytes(32);
  let connectionString: string;
  let store: CustomerOAuthStore;
  let pilot: PilotStore;
  let service: CustomerOAuth;
  let client: RegisteredPublicClient;
  let now: Date;
  let session: PilotSession;

  function instance(oauthStore = store, origin = ORIGIN) {
    return new CustomerOAuth({ store: oauthStore, pilotStore: pilot, origin, now: () => now });
  }
  beforeAll(async () => {
    const admin = new Pool({ connectionString: databaseUrl, max: 1 });
    try { await admin.query(`CREATE SCHEMA "${schema}"`); } finally { await admin.end(); }
    const database = new URL(databaseUrl!);
    database.searchParams.set("options", `-c search_path=${schema}`);
    connectionString = database.href;
    await migratePostgres(connectionString);
    pilot = await createPilotStore({ connectionString, encryptionKey, maxConnections: 3 });
    store = await createCustomerOAuthStore({ connectionString, encryptionKey, maxConnections: 3 });
    now = new Date(NOW);
    service = instance();
    client = await service.register({ client_name: "Unverified Agent", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
  });
  beforeEach(async () => {
    now = new Date(NOW);
    session = await signIn();
  });
  afterAll(async () => {
    await store?.close();
    await pilot?.close();
    const admin = new Pool({ connectionString: databaseUrl, max: 1 });
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); }
  });

  async function signIn(): Promise<PilotSession> {
    const identity = await pilot.identities.getOrCreate(`${randomUUID()}@example.test`);
    const token = tokenHash(opaqueToken());
    const browser = tokenHash(opaqueToken());
    await pilot.loginTokens.issue({ tokenHash: token, browserNonceHash: browser, userId: identity.userId, expiresAt: new Date(now.getTime() + 60_000) });
    const result = await pilot.loginTokens.consume({ tokenHash: token, browserNonceHash: browser, sessionHash: tokenHash(opaqueToken()),
      sessionExpiresAt: new Date(now.getTime() + 365 * 24 * 60 * 60_000), now });
    if (!result) throw new Error("Unable to create test session");
    return result;
  }
  function authorization(overrides: Record<string, string> = {}): URLSearchParams {
    return new URLSearchParams({ client_id: client.client_id, redirect_uri: REDIRECT, response_type: "code", resource: `${ORIGIN}/mcp`,
      code_challenge: CHALLENGE, code_challenge_method: "S256", scope: BOOKING_SCOPES.join(" "), state: "client state/with+symbols", ...overrides });
  }
  async function pending(overrides: Record<string, string> = {}) {
    const browser = opaqueToken();
    return { ...await service.startAuthorization(authorization(overrides), browser), browser };
  }
  async function code(overrides: Record<string, string> = {}, user = session) {
    const request = await pending(overrides);
    const result = await service.decide(user, request.requestToken, request.browser, true);
    const value = new URL(result.redirectUrl).searchParams.get("code");
    if (!value) throw new Error("Missing authorization code");
    return value;
  }
  function exchange(value: string, overrides: Record<string, string> = {}) {
    return new URLSearchParams({ client_id: client.client_id, grant_type: "authorization_code", code: value, code_verifier: VERIFIER,
      redirect_uri: REDIRECT, resource: `${ORIGIN}/mcp`, ...overrides });
  }
  function refresh(value: string, overrides: Record<string, string> = {}) {
    return new URLSearchParams({ client_id: client.client_id, grant_type: "refresh_token", refresh_token: value, resource: `${ORIGIN}/mcp`, ...overrides });
  }

  it("resumes an anonymous request across a service restart and binds consent to the initiating browser and verified user", async () => {
    const request = await pending({ porter_user: "attacker-selected-user" });
    const secondStore = await createCustomerOAuthStore({ connectionString, encryptionKey, maxConnections: 2 });
    try {
      const restarted = instance(secondStore);
      expect(await restarted.authorization(request.requestToken, opaqueToken())).toBeNull();
      expect(await restarted.authorization(request.requestToken, request.browser)).toMatchObject({ clientName: "Unverified Agent", clientVerified: false,
        redirectUri: REDIRECT, redirectOrigin: "https://agent.example", scopes: BOOKING_SCOPES, expiresAt: new Date(NOW.getTime() + 20 * 60_000) });
      await expect(restarted.decide(session, request.requestToken, opaqueToken(), true)).rejects.toMatchObject({ error: "invalid_request" });
      const approved = new URL((await restarted.decide(session, request.requestToken, request.browser, true)).redirectUrl);
      expect(approved.searchParams.get("state")).toBe("client state/with+symbols");
      expect(approved.searchParams.get("iss")).toBe(ORIGIN);
      expect(approved.searchParams.get("channel")).toBe("booking");
      expect(await service.authorization(request.requestToken, request.browser)).toBeNull();
      const tokens = await service.token(exchange(approved.searchParams.get("code")!));
      expect(await restarted.authenticate(`Bearer ${tokens.access_token}`)).toEqual({ userId: session.userId, scopes: BOOKING_SCOPES, method: "oauth" });
      expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 900, scope: BOOKING_SCOPES.join(" ") });
    } finally { await secondStore.close(); }
  });

  it("requires a live correctly owned session for consent and never consumes the request on a failed session check", async () => {
    const request = await pending();
    await expect(service.decide({ ...session, userId: "someone-else" }, request.requestToken, request.browser, true)).rejects.toMatchObject({ error: "invalid_request" });
    expect(await service.authorization(request.requestToken, request.browser)).not.toBeNull();
    await pilot.sessions.revoke(session.userId, session.sessionHash);
    await expect(service.decide(session, request.requestToken, request.browser, true)).rejects.toMatchObject({ error: "invalid_request" });
    const live = await signIn();
    const url = new URL((await service.decide(live, request.requestToken, request.browser, false)).redirectUrl);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("code")).toBeNull();
    expect(url.searchParams.get("state")).toBe("client state/with+symbols");
    expect(await service.authorization(request.requestToken, request.browser)).toBeNull();
  });

  it.each([{ redirect_uri: "https://evil.example/callback" }, { redirect_uri: "https://agent.example/callback?channel=booking&extra=yes" },
    { code_challenge_method: "plain" }, { code_challenge_method: "" }, { code_challenge: "short" }, { scope: "payments:write" },
    { scope: "bookings:read bookings:read" }, { resource: "https://other.example/mcp" }, { resource: `${ORIGIN}/mcp/` }, { response_type: "token" }])("rejects invalid authorization binding %j", async (change) => {
    await expect(pending(change)).rejects.toMatchObject({ status: 400 });
  });

  it("rejects wrong client, redirect, verifier and audience without consuming the valid authorization code", async () => {
    const value = await code();
    const other = await service.register({ redirect_uris: [REDIRECT] });
    for (const override of [{ client_id: other.client_id }, { redirect_uri: "https://evil.example/callback" }, { code_verifier: opaqueToken() }]) {
      await expect(service.token(exchange(value, override))).rejects.toMatchObject({ error: "invalid_grant" });
    }
    await expect(service.token(exchange(value, { resource: "https://other.example/mcp" }))).rejects.toMatchObject({ error: "invalid_target" });
    const tokens = await service.token(exchange(value));
    expect(await service.authenticate(`Bearer ${tokens.access_token}`)).toMatchObject({ userId: session.userId });
    expect(await instance(store, "https://other.example").authenticate(`Bearer ${tokens.access_token}`)).toBeNull();
  });

  it("accepts the full RFC 7636 unreserved verifier alphabet through length 128 and rejects invalid bounds", async () => {
    const verifier = "Aa0-._~".repeat(18) + "AZ";
    expect(verifier).toHaveLength(128);
    const value = await code({ code_challenge: createHash("sha256").update(verifier).digest("base64url") });
    for (const invalid of ["a".repeat(42), "a".repeat(129), "+".repeat(43)]) {
      await expect(service.token(exchange(value, { code_verifier: invalid }))).rejects.toMatchObject({ status: 400 });
    }
    await expect(service.token(exchange(value, { code_verifier: verifier }))).resolves.toHaveProperty("access_token");
  });

  it("expires requests, authorization codes and access tokens at their boundary", async () => {
    const request = await pending();
    now = new Date(NOW.getTime() + 20 * 60_000);
    expect(await service.authorization(request.requestToken, request.browser)).toBeNull();
    const value = await code();
    now = new Date(now.getTime() + 2 * 60_000);
    await expect(service.token(exchange(value))).rejects.toMatchObject({ error: "invalid_grant" });
    const tokens = await service.token(exchange(await code()));
    now = new Date(now.getTime() + 15 * 60_000);
    expect(await service.authenticate(`Bearer ${tokens.access_token}`)).toBeNull();
    await expect(service.token(refresh(tokens.refresh_token))).resolves.toHaveProperty("access_token");
  });

  it("permits exactly one concurrent consent and one code exchange; a correctly bound replay revokes the issued grant", async () => {
    const request = await pending();
    const decisions = await Promise.allSettled([service.decide(session, request.requestToken, request.browser, true), service.decide(session, request.requestToken, request.browser, true)]);
    const accepted = decisions.filter((result) => result.status === "fulfilled");
    expect(accepted).toHaveLength(1);
    const value = new URL(accepted[0]!.value.redirectUrl).searchParams.get("code")!;
    const exchanges = await Promise.allSettled([service.token(exchange(value)), service.token(exchange(value))]);
    const issued = exchanges.filter((result) => result.status === "fulfilled");
    expect(issued).toHaveLength(1);
    expect(await service.authenticate(`Bearer ${issued[0]!.value.access_token}`)).toBeNull();
  });

  it("rotates refresh tokens, narrows scopes permanently and detects replay of spent generations", async () => {
    const original = await service.token(exchange(await code()));
    const narrow = await service.token(refresh(original.refresh_token, { scope: "bookings:read" }));
    expect(narrow.refresh_token).not.toBe(original.refresh_token);
    expect(narrow.scope).toBe("bookings:read");
    expect(await service.authenticate(`Bearer ${narrow.access_token}`)).toMatchObject({ scopes: ["bookings:read"] });
    expect(await service.authenticate(`Bearer ${original.access_token}`)).toMatchObject({ scopes: ["bookings:read"] });
    await expect(service.token(refresh(narrow.refresh_token, { scope: "bookings:write" }))).rejects.toMatchObject({ error: "invalid_grant" });
    const next = await service.token(refresh(narrow.refresh_token));
    expect(next.scope).toBe("bookings:read");
    await expect(service.token(refresh(original.refresh_token))).rejects.toMatchObject({ error: "invalid_grant" });
    expect(await service.authenticate(`Bearer ${next.access_token}`)).toBeNull();
    await expect(service.token(refresh(next.refresh_token))).rejects.toMatchObject({ error: "invalid_grant" });
  });

  it("does not extend the refresh grant lifetime and clamps the final access token expiry", async () => {
    const original = await service.token(exchange(await code()));
    now = new Date(NOW.getTime() + 30 * 24 * 60 * 60_000 - 1000);
    const final = await service.token(refresh(original.refresh_token));
    expect(final.expires_in).toBe(1);
    now = new Date(now.getTime() + 1000);
    expect(await service.authenticate(`Bearer ${final.access_token}`)).toBeNull();
    await expect(service.token(refresh(final.refresh_token))).rejects.toMatchObject({ error: "invalid_grant" });
  });

  it("requires an actual OAuth Bearer token and never accepts old API keys or a refresh token", async () => {
    const tokens = await service.token(exchange(await code()));
    for (const header of [undefined, tokens.access_token, `Basic ${tokens.access_token}`, `Bearer porter_${opaqueToken()}`,
      `Bearer ${tokens.refresh_token}`, `Bearer ${tokens.access_token}, Bearer ${tokens.access_token}`, `Bearer ${tokens.access_token} `]) {
      expect(await service.authenticate(header)).toBeNull();
    }
    expect(await service.authenticate(`bearer ${tokens.access_token}`)).toMatchObject({ userId: session.userId });
  });

  it("binds revocation to the client and returns identical success for unknown tokens and hints", async () => {
    const tokens = await service.token(exchange(await code()));
    const other = await service.register({ redirect_uris: ["https://another-agent.example/callback"] });
    await service.revoke(new URLSearchParams({ client_id: other.client_id, token: tokens.refresh_token }));
    expect(await service.authenticate(`Bearer ${tokens.access_token}`)).not.toBeNull();
    await service.revoke(new URLSearchParams({ client_id: client.client_id, token: "unknown", token_type_hint: "unknown" }));
    await service.revoke(new URLSearchParams({ client_id: client.client_id, token: tokens.access_token, token_type_hint: "unknown" }));
    expect(await service.authenticate(`Bearer ${tokens.access_token}`)).toBeNull();
    await expect(service.token(refresh(tokens.refresh_token))).rejects.toMatchObject({ error: "invalid_grant" });
  });

  it("shows only the live signed-in customer's connections and revokes only their grants", async () => {
    const tokens = await service.token(exchange(await code()));
    const connections = await service.connections(session);
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({ clientName: "Unverified Agent", clientVerified: false, redirectOrigins: ["https://agent.example"], scopes: BOOKING_SCOPES });
    expect(JSON.stringify(connections)).not.toContain(tokens.access_token);
    const other = await signIn();
    expect(await service.connections(other)).toEqual([]);
    expect(await service.revokeConnection(other, connections[0]!.id)).toBe(false);
    await expect(service.connections({ ...session, userId: other.userId })).rejects.toMatchObject({ status: 401 });
    expect(await service.revokeConnection(session, connections[0]!.id)).toBe(true);
    expect(await service.authenticate(`Bearer ${tokens.access_token}`)).toBeNull();
    await pilot.sessions.revoke(session.userId, session.sessionHash);
    await expect(service.connections(session)).rejects.toMatchObject({ status: 401 });
  });
});
