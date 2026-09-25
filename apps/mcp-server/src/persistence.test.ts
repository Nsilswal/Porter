import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { migratePostgres, type PostgresStore } from "@porter/db";
import { createApp, type PorterApp } from "./app.js";
import type { PorterConfig } from "./config.js";

// Uses a real database and an isolated disposable schema; never resets the
// application's tables. Set TEST_DATABASE_URL to the local Compose database.
const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("HTTP server with PostgreSQL", () => {
  const schema = `porter_http_${randomUUID().replaceAll("-", "")}`;
  const apps = new Set<PorterApp>();
  let options: Partial<PorterConfig>;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: databaseUrl, max: 1 });
    try { await admin.query(`CREATE SCHEMA "${schema}"`); }
    finally { await admin.end(); }
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    await migratePostgres(url.toString());
    options = {
      storage: "postgres",
      databaseUrl: url.toString(),
      encryptionKey: randomBytes(32).toString("hex"),
      signingSecret: randomBytes(32).toString("hex"),
      apiKeys: { "customer-key": "customer_one", "other-key": "customer_two" },
      port: 0,
      demoMode: true,
      devOAuthEnabled: false,
      logLevel: "error",
      squareAccessToken: undefined,
      jobberAccessToken: undefined,
      stripeSecretKey: undefined,
      webSourcesPath: undefined,
      squarePublicSourcesPath: undefined,
    };
  });

  afterAll(async () => {
    await Promise.all([...apps].map((app) => app.close()));
    const admin = new Pool({ connectionString: databaseUrl, max: 1 });
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await admin.end(); }
  });

  async function start() {
    const app = await createApp(options);
    apps.add(app);
    const port = await app.listen(0);
    return { app, origin: `http://127.0.0.1:${port}` };
  }

  async function listOverMcp(origin: string, key: string) {
    const client = new Client({ name: "persistence-test", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      }));
      const result = await client.callTool({ name: "list_my_bookings", arguments: {} });
      const content = result.content as { type: string; text?: string }[];
      if (result.isError || content[0]?.type !== "text" || !content[0].text) throw new Error("Unexpected MCP booking response");
      return JSON.parse(content[0].text) as unknown;
    } finally { await client.close(); }
  }

  it("keeps booking ownership, confirmation consumption and exact replay after restart", async () => {
    const first = await start();
    const actor = { id: "customer_one" };
    const signal = new AbortController().signal;
    const { providers } = await first.app.engine.searchProviders(actor, { category: "haircut" }, signal);
    const provider = providers[0]!;
    const service = provider.services.find((entry) => !entry.quote_required)!;
    const { slots } = await first.app.engine.getAvailability(actor, {
      provider_id: provider.provider_id,
      service_id: service.service_id,
      from: new Date(Date.now() + 60_000).toISOString(),
      to: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    }, signal);
    const request = {
      slot_id: slots[0]!.slot_id,
      customer_details: { givenName: "Test", familyName: "Customer", email: "test@example.com", phone: "+12025550123" },
      idempotency_key: randomUUID(),
    };
    const quote = await first.app.engine.createBooking(actor, request, signal);
    if (quote.status !== "confirmation_required") throw new Error("Expected confirmation before booking");
    const commit = { ...request, confirmation_token: quote.confirmationToken };
    const original = await first.app.engine.createBooking(actor, commit, signal);
    if (original.status !== "ok") throw new Error("Expected a completed booking request");
    await first.app.close();

    const second = await start();
    expect(await second.app.engine.createBooking(actor, commit, signal)).toEqual(original);
    expect(await listOverMcp(second.origin, "customer-key")).toEqual({ bookings: [original.booking] });
    expect(await listOverMcp(second.origin, "other-key")).toEqual({ bookings: [] });
    await expect(second.app.engine.createBooking(actor, { ...commit, idempotency_key: randomUUID() }, signal))
      .rejects.toMatchObject({ code: "CONFIRMATION_EXPIRED" });
    const nextRequest = { ...request, slot_id: slots[1]!.slot_id, idempotency_key: randomUUID() };
    const nextQuote = await second.app.engine.createBooking(actor, nextRequest, signal);
    if (nextQuote.status !== "confirmation_required") throw new Error("Expected confirmation for second appointment");
    const nextBooking = await second.app.engine.createBooking(actor, { ...nextRequest, confirmation_token: nextQuote.confirmationToken }, signal);
    expect(nextBooking.status).toBe("ok");
    expect((await second.app.store.bookings.list(actor.id))).toHaveLength(2);
    expect(await (await fetch(`${second.origin}/readyz`)).json()).toEqual({ ok: true, storage: "postgres", mode: "demo" });
    await second.app.close();
  });

  it("reports database failure in readiness while keeping liveness available", async () => {
    const { app, origin } = await start();
    await (app.store as PostgresStore).close();
    expect((await fetch(`${origin}/healthz`)).status).toBe(200);
    expect((await fetch(`${origin}/readyz`)).status).toBe(503);
    await app.close();
  });
});
