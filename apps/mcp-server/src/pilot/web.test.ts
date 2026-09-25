import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPilotStore, migratePostgres, type PilotStore } from "@porter/db";
import { PilotAccounts } from "./accounts.js";
import { MerchantConnections } from "./connections.js";
import { PilotWeb } from "./web.js";
import type { SignInEmail } from "./mail.js";
import { opaqueToken } from "./security.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("pilot browser authentication with PostgreSQL", () => {
  const schema = `porter_web_${randomUUID().replaceAll("-", "")}`;
  const messages: SignInEmail[] = [];
  let store: PilotStore;
  let web: PilotWeb;
  let server: Server;
  let origin: string;
  let raw: Pool;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: databaseUrl, max: 1 });
    try { await admin.query(`CREATE SCHEMA "${schema}"`); } finally { await admin.end(); }
    const database = new URL(databaseUrl!);
    database.searchParams.set("options", `-c search_path=${schema}`);
    await migratePostgres(database.href);
    store = await createPilotStore({ connectionString: database.href, encryptionKey: randomBytes(32) });
    raw = new Pool({ connectionString: database.href });
    server = createServer((req, res) => {
      void web.handle(req, res, new URL(req.url ?? "/", origin)).then((handled) => { if (!handled) { res.statusCode = 404; res.end(); } });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server");
    origin = `http://127.0.0.1:${address.port}`;
    const accounts = new PilotAccounts(store, { send: async (message) => { messages.push(message); } }, origin);
    const connections = new MerchantConnections({ store, environment: "sandbox", oauth: {
      authorizationUrl: (state) => `https://connect.squareupsandbox.com/oauth2/authorize?state=${state}`,
      exchangeCode: async () => { throw new Error("not used"); },
      refreshTokens: async () => { throw new Error("not used"); },
      revokeAuthorization: async () => undefined,
    } });
    web = new PilotWeb({ store, accounts, connections, config: { origin, environment: "sandbox", applicationId: "sandbox-application", applicationSecret: "test-secret",
      email: { mode: "file", directory: "/unused" }, invitedEmails: [], operatorEmails: [] } });
  });

  afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await raw?.end();
    await store?.close();
    const admin = new Pool({ connectionString: databaseUrl, max: 1 });
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); }
  });

  async function post(path: string, form: Record<string, string>, cookie = "", originHeader = origin) {
    return fetch(`${origin}${path}`, { method: "POST", redirect: "manual", headers: {
      Origin: originHeader, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded",
    }, body: new URLSearchParams(form) });
  }

  async function requestLink() {
    const landing = await fetch(`${origin}/signin`);
    const browserCookie = landing.headers.getSetCookie()[0]!.split(";")[0]!;
    const email = `${randomUUID()}@example.test`;
    const response = await post("/signin/request", { email }, browserCookie);
    expect(response.status).toBe(200);
    const message = messages.find((entry) => entry.to === email)!;
    return { email, browserCookie, token: new URL(message.url).hash.slice(1), message, response };
  }

  async function signIn() {
    const link = await requestLink();
    const response = await post("/signin/verify", { token: link.token }, link.browserCookie);
    expect(response.status).toBe(303);
    return { ...link, sessionCookie: response.headers.getSetCookie()[0]!.split(";")[0]!, response };
  }

  it("delivers a fragment link without exposing it to the public response or stored plaintext", async () => {
    const link = await requestLink();
    expect(new URL(link.message.url).search).toBe("");
    expect(await link.response.text()).not.toContain(link.token);
    const rows = await raw.query("SELECT token_hash, browser_nonce_hash FROM email_login_tokens");
    expect(JSON.stringify(rows.rows)).not.toContain(link.token);
    expect(link.response.headers.get("cache-control")).toBe("no-store");
    expect(link.response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("does not spend a login link when an email scanner opens its GET page", async () => {
    const link = await requestLink();
    const scanned = await fetch(link.message.url);
    expect(scanned.status).toBe(200);
    expect(scanned.headers.getSetCookie()).toHaveLength(0);
    const verified = await post("/signin/verify", { token: link.token }, link.browserCookie);
    expect(verified.status).toBe(303);
    expect(verified.headers.get("location")).toBe("/owner");
  });

  it("rejects another browser without consuming the owner's link, then rejects replay", async () => {
    const link = await requestLink();
    expect((await post("/signin/verify", { token: link.token }, `porter_browser=${opaqueToken()}`)).status).toBe(400);
    const verified = await post("/signin/verify", { token: link.token }, link.browserCookie);
    expect(verified.status).toBe(303);
    expect(verified.headers.getSetCookie()[0]).toContain("HttpOnly; SameSite=Lax");
    expect((await post("/signin/verify", { token: link.token }, link.browserCookie)).status).toBe(400);
  });

  it("rejects cross-origin form actions before sending mail or consuming a token", async () => {
    const before = messages.length;
    expect((await post("/signin/request", { email: "attacker@example.test" }, "", "https://attacker.example")).status).toBe(403);
    expect(messages).toHaveLength(before);
    const link = await requestLink();
    expect((await post("/signin/verify", { token: link.token }, link.browserCookie, "https://attacker.example")).status).toBe(403);
    expect((await post("/signin/verify", { token: link.token }, link.browserCookie)).status).toBe(303);
  });

  it("issues a private customer key once and enforces durable ownership and revocation", async () => {
    const first = await signIn();
    const second = await signIn();
    const issued = await post("/connect/keys", { label: "My Muse" }, first.sessionCookie);
    expect(issued.status).toBe(201);
    const html = await issued.text();
    const key = /value="(porter_[A-Za-z0-9_-]{43})"/.exec(html)![1]!;
    const userId = await web.options.accounts.authenticateConnector(key);
    expect(userId).toBeTruthy();
    const credentials = await store.connectors.list(userId!);
    expect(credentials).toHaveLength(1);
    const listed = await fetch(`${origin}/connect`, { headers: { Cookie: first.sessionCookie } });
    expect(await listed.text()).not.toContain(key);
    const rows = await raw.query("SELECT * FROM connector_credentials");
    expect(JSON.stringify(rows.rows)).not.toContain(key);
    const path = `/connect/keys/${credentials[0]!.id}/revoke`;
    expect((await post(path, {}, second.sessionCookie)).status).toBe(404);
    expect(await web.options.accounts.authenticateConnector(key)).toBe(userId);
    expect((await post(path, {}, first.sessionCookie)).status).toBe(303);
    expect(await web.options.accounts.authenticateConnector(key)).toBeNull();
  });

  it("requires live sessions and rejects ambiguous cookies after sign-out", async () => {
    const owner = await signIn();
    expect((await fetch(`${origin}/owner`, { headers: { Cookie: `${owner.sessionCookie}; ${owner.sessionCookie}` } })).status).toBe(401);
    expect((await post("/signout", {}, owner.sessionCookie)).status).toBe(303);
    expect((await fetch(`${origin}/owner`, { headers: { Cookie: owner.sessionCookie } })).status).toBe(401);
    expect((await post("/connect/keys", { label: "No access" }, owner.sessionCookie)).status).toBe(401);
  });

  it("does not expose another owner's business or initiate Square authorization for it", async () => {
    const first = await signIn();
    const second = await signIn();
    const identity = await store.identities.getOrCreate(first.email);
    const business = await store.businesses.create({ id: randomUUID(), ownerId: identity.userId, name: "Private salon", websiteUrl: "https://salon.example.test" });
    expect((await fetch(`${origin}/owner/businesses/${business.id}`, { headers: { Cookie: second.sessionCookie } })).status).toBe(404);
    expect((await post(`/owner/businesses/${business.id}/square`, {}, second.sessionCookie)).status).toBe(404);
    const consent = await post(`/owner/businesses/${business.id}/square`, {}, first.sessionCookie);
    expect(consent.status).toBe(200);
    expect(consent.headers.get("content-security-policy")).toContain("form-action 'self'");
    const html = await consent.text();
    const target = /data-square-authorize href="([^"]+)"/.exec(html)![1]!;
    expect(new URL(target).origin).toBe("https://connect.squareupsandbox.com");
  });

  it("bounds form bodies and rejects ambiguous duplicate fields", async () => {
    expect((await post("/signin/request", { email: "x".repeat(20_000) })).status).toBe(413);
    const response = await fetch(`${origin}/signin/request`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body: "email=first%40example.test&email=second%40example.test" });
    expect(response.status).toBe(400);
  });
});
