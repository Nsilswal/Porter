import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { migratePostgres } from "@porter/db";
import { createApp, type PorterApp } from "../app.js";
import type { PorterConfig } from "../config.js";
import type { CustomerTokenResponse, RegisteredPublicClient } from "./customer-oauth.js";
import type { SignInEmail } from "./mail.js";
import { opaqueToken } from "./security.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const issuer = "http://localhost:8082";
const resource = `${issuer}/mcp`;
const defaultRedirect = "https://assistant.example.test/porter/callback";
const allScopes = "bookings:read bookings:write";

class BrowserCookies {
  readonly values = new Map<string, string>();
  header(): string { return [...this.values].map(([name, value]) => `${name}=${value}`).join("; "); }
  absorb(response: Response): void {
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]!;
      const split = pair.indexOf("=");
      const name = pair.slice(0, split);
      const value = pair.slice(split + 1);
      if (value) this.values.set(name, value);
      else this.values.delete(name);
    }
  }
}

interface Runtime { app: PorterApp; origin: string }
interface Pending {
  client: RegisteredPublicClient;
  verifier: string;
  redirectUri: string;
  state: string;
  cookies: BrowserCookies;
  request: string;
}

function unescapeAttribute(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

describe.skipIf(!databaseUrl)("customer OAuth HTTP and MCP with PostgreSQL", () => {
  const schema = `porter_customer_oauth_http_${randomUUID().replaceAll("-", "")}`;
  const apps: PorterApp[] = [];
  let settings: Partial<PorterConfig>;
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "porter-customer-oauth-http-"));
    const admin = new Pool({ connectionString: databaseUrl, max: 1 });
    try { await admin.query(`CREATE SCHEMA "${schema}"`); } finally { await admin.end(); }
    const database = new URL(databaseUrl!);
    database.searchParams.set("options", `-c search_path=${schema}`);
    await migratePostgres(database.href);
    settings = {
      issuer, port: 0, storage: "postgres", databaseUrl: database.href,
      signingSecret: randomBytes(32).toString("hex"), encryptionKey: randomBytes(32).toString("hex"),
      demoMode: false, devOAuthEnabled: false, apiKeys: {}, logLevel: "error",
      squareAccessToken: undefined, jobberAccessToken: undefined, stripeSecretKey: undefined,
      webSourcesPath: undefined, squarePublicSourcesPath: undefined,
      pilot: { origin: issuer, environment: "sandbox", applicationId: "sandbox-http-test-application",
        applicationSecret: "synthetic-test-application-secret", email: { mode: "file", directory },
        invitedEmails: [], operatorEmails: [], internalApiKeys: false },
    };
  });

  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

  afterAll(async () => {
    const admin = new Pool({ connectionString: databaseUrl, max: 1 });
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); }
    if (directory) await rm(directory, { recursive: true });
  });

  async function start(): Promise<Runtime> {
    const app = await createApp(settings);
    apps.push(app);
    return { app, origin: `http://127.0.0.1:${await app.listen(0)}` };
  }

  async function get(runtime: Runtime, path: string, cookies = new BrowserCookies()) {
    const response = await fetch(`${runtime.origin}${path}`, { redirect: "manual", headers: { Cookie: cookies.header() } });
    cookies.absorb(response);
    return response;
  }

  async function post(runtime: Runtime, path: string, form: Record<string, string>, cookies = new BrowserCookies(), origin = issuer) {
    const response = await fetch(`${runtime.origin}${path}`, { method: "POST", redirect: "manual", headers: {
      Origin: origin, Cookie: cookies.header(), "Content-Type": "application/x-www-form-urlencoded",
    }, body: new URLSearchParams(form) });
    cookies.absorb(response);
    return response;
  }

  async function register(runtime: Runtime, redirect = defaultRedirect, name = "Test assistant") {
    const response = await fetch(`${runtime.origin}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: name, redirect_uris: [redirect], token_endpoint_auth_method: "none" }) });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    return await response.json() as RegisteredPublicClient;
  }

  async function signIn(runtime: Runtime, cookies: BrowserCookies) {
    if (!cookies.values.has("porter_browser")) expect((await get(runtime, "/signin", cookies)).status).toBe(200);
    const email = `${randomUUID()}@example.test`;
    const sent = await post(runtime, "/signin/request", { email }, cookies);
    expect(sent.status).toBe(200);
    const messages = await Promise.all((await readdir(directory)).map(async (file) => JSON.parse(await readFile(join(directory, file), "utf8")) as SignInEmail));
    const message = messages.find((entry) => entry.to === email)!;
    const url = new URL(message.url);
    expect(url.origin).toBe(issuer);
    expect(url.search).toBe("");
    expect(await sent.text()).not.toContain(url.hash.slice(1));
    // Simulate opening the email fragment page; GET does not spend the link.
    expect((await get(runtime, url.pathname, cookies)).status).toBe(200);
    const verified = await post(runtime, "/signin/verify", { token: url.hash.slice(1) }, cookies);
    expect(verified.status).toBe(303);
    expect(verified.headers.getSetCookie().join(" ")).toContain("HttpOnly; SameSite=Lax");
    return verified;
  }

  async function pending(runtime: Runtime, options: { cookies?: BrowserCookies; client?: RegisteredPublicClient; scopes?: string; redirectUri?: string } = {}): Promise<Pending> {
    const cookies = options.cookies ?? new BrowserCookies();
    const redirectUri = options.redirectUri ?? defaultRedirect;
    const client = options.client ?? await register(runtime, redirectUri);
    const verifier = opaqueToken();
    const state = `state-${randomUUID()}`;
    const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirectUri, response_type: "code", resource,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
      scope: options.scopes ?? allScopes, state });
    const response = await get(runtime, `/oauth/authorize?${query}`, cookies);
    expect(response.status).toBe(303);
    if (!cookies.values.has("porter_session")) {
      expect(response.headers.get("location")).toBe("/signin");
      expect((await signIn(runtime, cookies)).headers.get("location")).toBe("/oauth/consent");
    } else expect(response.headers.get("location")).toBe("/oauth/consent");
    const consent = await get(runtime, "/oauth/consent", cookies);
    expect(consent.status).toBe(200);
    expect(consent.headers.get("cache-control")).toBe("no-store");
    expect(consent.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await consent.text();
    const request = /name="request" value="([A-Za-z0-9_-]{43})"/.exec(html)![1]!;
    expect(html).toContain(new URL(redirectUri).origin);
    expect(html).toContain("Application names are supplied during registration");
    return { client, verifier, redirectUri, state, cookies, request };
  }

  async function decide(runtime: Runtime, flow: Pending, decision = "approve") {
    const response = await post(runtime, "/oauth/consent", { request: flow.request, decision }, flow.cookies);
    expect(response.status).toBe(200);
    const html = await response.text();
    const match = /data-oauth-redirect href="([^"]+)"/.exec(html);
    expect(match).toBeTruthy();
    const target = new URL(unescapeAttribute(match![1]!));
    expect(target.origin + target.pathname).toBe(new URL(flow.redirectUri).origin + new URL(flow.redirectUri).pathname);
    expect(target.searchParams.get("state")).toBe(flow.state);
    expect(target.searchParams.get("iss")).toBe(issuer);
    return target;
  }

  function exchangeForm(flow: Pending, code: string) {
    return { grant_type: "authorization_code", client_id: flow.client.client_id, redirect_uri: flow.redirectUri,
      resource, code, code_verifier: flow.verifier };
  }

  async function connect(runtime: Runtime, scopes = allScopes) {
    const flow = await pending(runtime, { scopes });
    const redirect = await decide(runtime, flow);
    const response = await post(runtime, "/oauth/token", exchangeForm(flow, redirect.searchParams.get("code")!));
    expect(response.status).toBe(200);
    const tokens = await response.json() as CustomerTokenResponse;
    expect(tokens).toMatchObject({ token_type: "Bearer", scope: scopes });
    return { ...flow, tokens };
  }

  async function withClient<T>(runtime: Runtime, token: string, run: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ name: "customer-oauth-http-test", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${runtime.origin}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }));
      return await run(client);
    } finally { await client.close(); }
  }

  async function bearer(runtime: Runtime, path: string, token: string) {
    return fetch(`${runtime.origin}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  }

  it("discovers booking-only OAuth through the HTTP challenge and publishes CORS metadata", async () => {
    const runtime = await start();
    const challenge = await get(runtime, "/mcp");
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toContain(`resource_metadata="${issuer}/.well-known/oauth-protected-resource"`);
    expect(challenge.headers.get("www-authenticate")).toContain(`scope="${allScopes}"`);
    expect(challenge.headers.get("www-authenticate")).not.toContain("payments");
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const response = await get(runtime, path);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
      expect(await response.json()).toMatchObject({ resource, authorization_servers: [issuer], scopes_supported: allScopes.split(" ") });
    }
    const metadata = await (await get(runtime, "/.well-known/oauth-authorization-server")).json();
    expect(metadata).toMatchObject({ issuer, code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
      authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token` });
    for (const path of ["/oauth/register", "/oauth/token", "/oauth/revoke"]) {
      const response = await fetch(`${runtime.origin}${path}`, { method: "OPTIONS", headers: { Origin: "https://assistant.example.test" } });
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("access-control-allow-headers")).toBe("Content-Type");
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    }
  });

  it("connects via registration, browser email consent and PKCE, survives restart, then refreshes and revokes", async () => {
    const first = await start();
    const flow = await connect(first);
    expect(flow.cookies.values.has("porter_oauth_request")).toBe(false);
    expect(flow.tokens.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(flow.tokens.refresh_token).not.toBe(flow.tokens.access_token);
    const names = await withClient(first, flow.tokens.access_token, async (client) => (await client.listTools()).tools.map((tool) => tool.name));
    expect(names.sort()).toEqual(["cancel_booking", "create_booking", "get_availability", "list_my_bookings", "reschedule_booking", "search_providers"]);
    const before = await first.app.pilot!.options.accounts.session(flow.cookies.values.get("porter_session")!);
    await first.app.close();
    const restarted = await start();
    const after = await restarted.app.pilot!.options.oauth!.authenticate(`Bearer ${flow.tokens.access_token}`);
    expect(after?.userId).toBe(before?.userId);
    const bookings = await withClient(restarted, flow.tokens.access_token, (client) => client.callTool({ name: "list_my_bookings", arguments: {} }));
    expect(bookings.isError).not.toBe(true);
    const refreshed = await post(restarted, "/oauth/token", { grant_type: "refresh_token", client_id: flow.client.client_id,
      resource, refresh_token: flow.tokens.refresh_token });
    expect(refreshed.status).toBe(200);
    const next = await refreshed.json() as CustomerTokenResponse;
    expect(next.refresh_token).not.toBe(flow.tokens.refresh_token);
    expect((await bearer(restarted, "/v1/audit", next.access_token)).status).toBe(200);
    const revoked = await post(restarted, "/oauth/revoke", { client_id: flow.client.client_id, token: next.refresh_token });
    expect(revoked.status).toBe(200);
    for (const token of [flow.tokens.access_token, next.access_token]) expect((await bearer(restarted, "/mcp", token)).status).toBe(401);
    expect((await post(restarted, "/oauth/token", { grant_type: "refresh_token", client_id: flow.client.client_id,
      resource, refresh_token: next.refresh_token })).status).toBe(400);
  });

  it("offers directory connection instructions without manual keys and disables the key creation route", async () => {
    const runtime = await start();
    const flow = await connect(runtime);
    const response = await get(runtime, "/connect", flow.cookies);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Find Porter in Muse’s connector directory");
    expect(html).toContain("Test assistant");
    expect(html).not.toMatch(/API key|X-API-Key|paste|name="label"/i);
    expect(html).not.toContain(flow.tokens.access_token);
    expect(html).not.toContain(flow.tokens.refresh_token);
    expect((await post(runtime, "/connect/keys", { label: "Forbidden" }, flow.cookies)).status).toBe(404);
    expect((await get(runtime, "/connect/keys", flow.cookies)).status).toBe(404);
    expect((await get(runtime, "/mcp", flow.cookies)).status).toBe(401);
    expect((await bearer(runtime, "/mcp", `porter_${opaqueToken()}`)).status).toBe(401);
    expect((await fetch(`${runtime.origin}/mcp`, { headers: { "X-API-Key": flow.tokens.access_token } })).status).toBe(401);
    expect((await fetch(`${runtime.origin}/mcp`, { headers: { Authorization: `Bearer ${flow.tokens.access_token}`, "X-API-Key": "ambiguous" } })).status).toBe(401);
  });

  it("rejects cross-browser and cross-origin consent without spending the legitimate request", async () => {
    const runtime = await start();
    const flow = await pending(runtime);
    const foreign = new BrowserCookies();
    foreign.values.set("porter_session", flow.cookies.values.get("porter_session")!);
    foreign.values.set("porter_oauth_request", flow.request);
    foreign.values.set("porter_browser", opaqueToken());
    expect((await get(runtime, "/oauth/consent", foreign)).status).toBe(400);
    expect((await post(runtime, "/oauth/consent", { request: flow.request, decision: "approve" }, foreign)).status).toBe(400);
    expect((await post(runtime, "/oauth/consent", { request: flow.request, decision: "approve" }, flow.cookies, "https://attacker.example")).status).toBe(403);
    const withoutOrigin = await fetch(`${runtime.origin}/oauth/consent`, { method: "POST", headers: { Cookie: flow.cookies.header(),
      "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ request: flow.request, decision: "approve" }) });
    expect(withoutOrigin.status).toBe(403);
    const crossSite = await fetch(`${runtime.origin}/oauth/consent`, { method: "POST", headers: { Origin: issuer,
      "Sec-Fetch-Site": "cross-site", Cookie: flow.cookies.header(), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request: flow.request, decision: "approve" }) });
    expect(crossSite.status).toBe(403);
    expect((await decide(runtime, flow)).searchParams.has("code")).toBe(true);
    expect((await post(runtime, "/oauth/consent", { request: flow.request, decision: "approve" }, flow.cookies)).status).toBe(400);
  });

  it("binds two open consent tabs to their hidden requests despite the shared resume cookie", async () => {
    const runtime = await start();
    const cookies = new BrowserCookies();
    const first = await pending(runtime, { cookies, redirectUri: "https://first.example.test/callback" });
    const second = await pending(runtime, { cookies, redirectUri: "https://second.example.test/callback" });
    expect(first.request).not.toBe(second.request);
    expect(cookies.values.get("porter_oauth_request")).toBe(second.request);
    const firstRedirect = await decide(runtime, first);
    expect(cookies.values.get("porter_oauth_request")).toBe(second.request);
    const secondRedirect = await decide(runtime, second);
    expect(cookies.values.has("porter_oauth_request")).toBe(false);
    for (const [flow, redirect] of [[first, firstRedirect], [second, secondRedirect]] as const) {
      const response = await post(runtime, "/oauth/token", exchangeForm(flow, redirect.searchParams.get("code")!));
      expect(response.status).toBe(200);
    }
  });

  it("returns denial only to the registered callback with state and no authorization code", async () => {
    const runtime = await start();
    const flow = await pending(runtime);
    const redirect = await decide(runtime, flow, "deny");
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.has("code")).toBe(false);
    expect(flow.cookies.values.has("porter_oauth_request")).toBe(false);
    expect((await post(runtime, "/oauth/consent", { request: flow.request, decision: "approve" }, flow.cookies)).status).toBe(400);
    expect(await (await get(runtime, "/connect", flow.cookies)).text()).toContain("No applications are connected yet.");
  });

  it("bounds protocol bodies, rejects ambiguous fields and invalid client proofs, and leaves the valid code usable", async () => {
    const runtime = await start();
    const oversized = await fetch(`${runtime.origin}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "x".repeat(20_000) }) });
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get("access-control-allow-origin")).toBe("*");
    expect((await post(runtime, "/oauth/register", { client_name: "Wrong type" })).status).toBe(415);
    expect((await get(runtime, "/oauth/token")).status).toBe(405);
    expect((await post(runtime, "/oauth/token", { code: "x".repeat(20_000) })).status).toBe(413);
    const duplicate = await fetch(`${runtime.origin}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "client_id=one&client_id=two" });
    expect(duplicate.status).toBe(400);
    const flow = await pending(runtime);
    const redirect = await decide(runtime, flow);
    const form = exchangeForm(flow, redirect.searchParams.get("code")!);
    for (const patch of [{ resource: "https://other.example/mcp" }, { code_verifier: opaqueToken() }, { redirect_uri: `${flow.redirectUri}/wrong` }]) {
      const rejected = await post(runtime, "/oauth/token", { ...form, ...patch });
      expect(rejected.status).toBe(400);
      expect(rejected.headers.get("cache-control")).toBe("no-store");
      expect(rejected.headers.get("access-control-allow-credentials")).toBeNull();
    }
    const basic = await fetch(`${runtime.origin}/oauth/token`, { method: "POST", headers: { Authorization: "Basic unsupported",
      "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
    expect(basic.status).toBe(400);
    expect(await basic.json()).toMatchObject({ error: "invalid_client" });
    expect((await post(runtime, "/oauth/token", form)).status).toBe(200);
  });

  it("enforces read and write scopes at MCP and audit HTTP routes without exposing payment tools", async () => {
    const runtime = await start();
    const reader = await connect(runtime, "bookings:read");
    const writer = await connect(runtime, "bookings:write");
    expect((await bearer(runtime, "/v1/audit", reader.tokens.access_token)).status).toBe(200);
    const audit = await bearer(runtime, "/v1/audit", writer.tokens.access_token);
    expect(audit.status).toBe(403);
    expect(audit.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    expect(audit.headers.get("www-authenticate")).toContain('scope="bookings:read"');
    expect(audit.headers.get("www-authenticate")).not.toContain("payments");
    await withClient(runtime, reader.tokens.access_token, async (client) => {
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(["get_availability", "list_my_bookings", "search_providers"]);
      for (const name of ["create_booking", "pay_or_deposit"]) {
        const denied = await client.callTool({ name, arguments: {} });
        expect(denied.isError).toBe(true);
        expect(JSON.stringify(denied)).toContain("not found");
      }
    });
    await withClient(runtime, writer.tokens.access_token, async (client) => {
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(["cancel_booking", "create_booking", "reschedule_booking"]);
      const denied = await client.callTool({ name: "list_my_bookings", arguments: {} });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied)).toContain("not found");
    });
  });

  it("isolates connected applications by customer and lets the owner disconnect their whole token family", async () => {
    const runtime = await start();
    const flow = await connect(runtime);
    const html = await (await get(runtime, "/connect", flow.cookies)).text();
    const route = /action="(\/connect\/grants\/[a-f0-9-]{36}\/revoke)"/.exec(html)![1]!;
    const other = new BrowserCookies();
    await signIn(runtime, other);
    const otherHtml = await (await get(runtime, "/connect", other)).text();
    expect(otherHtml).not.toContain(route);
    expect(otherHtml).toContain("No applications are connected yet.");
    await post(runtime, route, {}, other);
    expect((await bearer(runtime, "/v1/audit", flow.tokens.access_token)).status).toBe(200);
    expect((await post(runtime, route, {}, flow.cookies, "https://attacker.example")).status).toBe(403);
    expect((await post(runtime, route, {}, flow.cookies)).status).toBe(303);
    expect((await bearer(runtime, "/mcp", flow.tokens.access_token)).status).toBe(401);
    expect((await post(runtime, "/oauth/token", { grant_type: "refresh_token", client_id: flow.client.client_id,
      resource, refresh_token: flow.tokens.refresh_token })).status).toBe(400);
  });
});
