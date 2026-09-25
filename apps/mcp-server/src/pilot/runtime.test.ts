import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { migratePostgres } from "@porter/db";
import { createApp, type PorterApp } from "../app.js";
import type { PorterConfig } from "../config.js";
import { opaqueToken } from "./security.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("pilot runtime and internal test credentials", () => {
  const schema = `porter_pilot_http_${randomUUID().replaceAll("-", "")}`;
  const apps: PorterApp[] = [];
  let settings: Partial<PorterConfig>;
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "porter-pilot-http-"));
    const admin = new Pool({ connectionString: databaseUrl, max: 1 });
    try { await admin.query(`CREATE SCHEMA "${schema}"`); } finally { await admin.end(); }
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    await migratePostgres(url.href);
    settings = {
      issuer: "http://localhost:8082", port: 0, storage: "postgres", databaseUrl: url.href,
      signingSecret: randomBytes(32).toString("hex"), encryptionKey: randomBytes(32).toString("hex"),
      demoMode: false, devOAuthEnabled: false, apiKeys: {}, logLevel: "error",
      squareAccessToken: undefined, jobberAccessToken: undefined, stripeSecretKey: undefined, webSourcesPath: undefined, squarePublicSourcesPath: undefined,
      pilot: { origin: "http://localhost:8082", environment: "sandbox", applicationId: "sandbox-test-application", applicationSecret: "application-secret-for-tests",
        email: { mode: "file", directory }, invitedEmails: [], operatorEmails: [], internalApiKeys: true },
    };
  });

  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
    const admin = new Pool({ connectionString: databaseUrl, max: 1 });
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); }
    if (directory) await rm(directory, { recursive: true });
  });

  async function start() {
    const app = await createApp(settings);
    apps.push(app);
    const port = await app.listen(0);
    return { app, origin: `http://127.0.0.1:${port}` };
  }

  async function credential(app: PorterApp) {
    const accounts = app.pilot!.options.accounts;
    const email = `${randomUUID()}@example.test`;
    const browser = opaqueToken();
    await accounts.requestLink(email, browser);
    const messages = await Promise.all((await readdir(directory)).map(async (file) => JSON.parse(await readFile(join(directory, file), "utf8")) as { to: string; url: string }));
    const token = new URL(messages.find((message) => message.to === email)!.url).hash.slice(1);
    const sessionToken = await accounts.verifyLink(token, browser);
    const session = (await accounts.session(sessionToken))!;
    return { ...(await accounts.issueConnector(session, "Muse test")), session, sessionToken };
  }

  async function withClient<T>(origin: string, key: string, run: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ name: "pilot-test", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
      return await run(client);
    } finally { await client.close(); }
  }

  it("uses individual persisted keys and exposes only the six pilot booking tools", async () => {
    const { app, origin } = await start();
    const user = await credential(app);
    const tools = await withClient(origin, user.key, async (client) => (await client.listTools()).tools.map((tool) => tool.name));
    expect(tools.sort()).toEqual(["cancel_booking", "create_booking", "get_availability", "list_my_bookings", "reschedule_booking", "search_providers"]);
    expect((await fetch(`${origin}/oauth/authorize`)).status).toBe(400);
    expect((await fetch(`${origin}/mcp`, { headers: { Authorization: "Bearer demo-key" } })).status).toBe(401);
    expect((await fetch(`${origin}/mcp`, { headers: { Cookie: `porter_session=${user.sessionToken}` } })).status).toBe(401);
    const metadata = await (await fetch(`${origin}/.well-known/oauth-protected-resource`)).json() as { scopes_supported: string[] };
    expect(metadata.scopes_supported).toEqual(["bookings:read", "bookings:write"]);
    const documentation = await (await fetch(`${origin}/docs`)).text();
    expect(documentation).toContain("six tools");
    expect(documentation).toContain("Square sandbox");
    expect(documentation).not.toContain(user.key);
    expect(documentation).not.toContain("pay_or_deposit");
  });

  it("preserves customer key identity after restart and rejects it immediately after revocation", async () => {
    const first = await start();
    const user = await credential(first.app);
    await first.app.close();
    const second = await start();
    const response = await withClient(second.origin, user.key, (client) => client.callTool({ name: "list_my_bookings", arguments: {} }));
    expect(response.isError).not.toBe(true);
    const accounts = second.app.pilot!.options.accounts;
    expect(await accounts.authenticateConnector(user.key)).toBe(user.session.userId);
    await second.app.pilot!.options.store.connectors.revoke(user.session.userId, user.id);
    expect((await fetch(`${second.origin}/mcp`, { headers: { Authorization: `Bearer ${user.key}` } })).status).toBe(401);
    expect(await accounts.authenticateConnector(user.key)).toBeNull();
  });

  it("rejects conflicting authentication headers instead of choosing an identity", async () => {
    const { app, origin } = await start();
    const first = await credential(app);
    const second = await credential(app);
    expect((await fetch(`${origin}/mcp`, { headers: { Authorization: `Bearer ${first.key}`, "X-API-Key": second.key } })).status).toBe(401);
    expect((await fetch(`${origin}/mcp`, { headers: { Authorization: "Bearer malformed trailing", "X-API-Key": first.key } })).status).toBe(401);
  });
});
