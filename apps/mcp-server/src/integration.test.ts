import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp, type PorterApp } from "./app.js";

/**
 * Integration tests: the real MCP server, over real Streamable HTTP, with the
 * real OAuth flow, against the mock adapter.
 *
 * This is the milestone 2 exit criterion — an MCP client completing
 * search -> availability -> confirm -> book -> reschedule -> cancel.
 */

let app: PorterApp;
let baseUrl: string;
const API_KEY = "test-key-abc";
const OTHER_API_KEY = "test-key-xyz";

beforeAll(async () => {
  app = createApp({
    port: 0,
    apiKeys: { [API_KEY]: "user_integration", [OTHER_API_KEY]: "user_other" },
    signingSecret: "integration-signing-secret-long-enough-01",
    logLevel: "error",
    adapterLatencyMs: 0,
    adapterFailureRate: 0,
  });
  const port = await app.listen(0);
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await app.close();
});

async function connect(token = API_KEY): Promise<Client> {
  const client = new Client({ name: "porter-test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

function parse(result: any): any {
  return JSON.parse(result.content[0].text);
}

describe("auth surface", () => {
  it("challenges an unauthenticated MCP request and points at discovery", async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate");
    expect(challenge).toContain("resource_metadata=");
    expect(challenge).toContain("/.well-known/oauth-protected-resource");
  });

  it("serves RFC 9728 protected-resource metadata", async () => {
    const meta = await (await fetch(`${baseUrl}/.well-known/oauth-protected-resource`)).json();
    expect(meta.resource).toBe(`${app.config.issuer}/mcp`);
    expect(meta.authorization_servers).toContain(app.config.issuer);
    expect(meta.scopes_supported).toContain("bookings:write");
  });

  it("serves RFC 8414 metadata advertising PKCE S256 only", async () => {
    const meta = await (await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)).json();
    expect(meta.code_challenge_methods_supported).toEqual(["S256"]);
    expect(meta.grant_types_supported).toContain("authorization_code");
    expect(meta.registration_endpoint).toContain("/oauth/register");
  });

  it("completes dynamic registration and a PKCE code exchange", async () => {
    const reg = await (
      await fetch(`${baseUrl}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "Test", redirect_uris: ["http://localhost:9999/cb"] }),
      })
    ).json();
    expect(reg.client_id).toMatch(/^porter_/);

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");

    const authUrl = new URL(`${baseUrl}/oauth/authorize`);
    authUrl.searchParams.set("client_id", reg.client_id);
    authUrl.searchParams.set("redirect_uri", "http://localhost:9999/cb");
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", "xyz");
    authUrl.searchParams.set("porter_user", "user_oauth");

    const redirected = await fetch(authUrl, { redirect: "manual" });
    expect(redirected.status).toBe(302);
    const location = new URL(redirected.headers.get("location")!);
    expect(location.searchParams.get("state")).toBe("xyz");
    const code = location.searchParams.get("code")!;

    const tokenRes = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: reg.client_id,
        redirect_uri: "http://localhost:9999/cb",
      }),
    });
    const tokens = await tokenRes.json();
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.access_token).toBeTruthy();

    // The issued token works against the MCP endpoint.
    const client = await connect(tokens.access_token);
    const { tools } = await client.listTools();
    expect(tools.length).toBe(9);
    await client.close();
  });

  it("rejects a PKCE exchange with the wrong verifier", async () => {
    const reg = await (
      await fetch(`${baseUrl}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://localhost:9999/cb"] }),
      })
    ).json();
    const challenge = createHash("sha256").update("the-real-verifier").digest("base64url");
    const authUrl = new URL(`${baseUrl}/oauth/authorize`);
    authUrl.searchParams.set("client_id", reg.client_id);
    authUrl.searchParams.set("redirect_uri", "http://localhost:9999/cb");
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    const redirected = await fetch(authUrl, { redirect: "manual" });
    const code = new URL(redirected.headers.get("location")!).searchParams.get("code")!;

    const res = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: "a-different-verifier",
        client_id: reg.client_id,
        redirect_uri: "http://localhost:9999/cb",
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("tool surface", () => {
  it("exposes exactly the nine declared tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "cancel_booking",
      "create_booking",
      "get_availability",
      "get_quote",
      "list_my_bookings",
      "message_provider",
      "pay_or_deposit",
      "reschedule_booking",
      "search_providers",
    ]);
    await client.close();
  });

  it("describes tools the way a user phrases the need", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === "search_providers")!;
    expect(search.description).toMatch(/haircut/i);
    expect(search.description).toMatch(/plumber/i);
    const cancel = tools.find((t) => t.name === "cancel_booking")!;
    expect(cancel.description).toMatch(/fee BEFORE/);
    await client.close();
  });
});

describe("end to end booking lifecycle", () => {
  it("runs search, availability, confirm, book, reschedule and cancel", async () => {
    const client = await connect();

    // 1. search
    const search = parse(await client.callTool({ name: "search_providers", arguments: { category: "haircut", limit: 5 } }));
    expect(search.providers.length).toBeGreaterThan(0);
    const provider = search.providers.find((p: any) => p.services.some((s: any) => !s.quote_required));
    const service = provider.services.find((s: any) => !s.quote_required);

    // 2. availability
    const from = new Date(Date.now() + 60 * 60_000).toISOString();
    const to = new Date(Date.now() + 14 * 24 * 60 * 60_000).toISOString();
    const avail = parse(await client.callTool({ name: "get_availability", arguments: { provider_id: provider.provider_id, service_id: service.service_id, from, to, limit: 10 } }));
    expect(avail.slots.length).toBeGreaterThan(0);

    // 3. first booking call returns a summary and books nothing
    const summary = parse(await client.callTool({
      name: "create_booking",
      arguments: { slot_id: avail.slots[0].slot_id, customer_details: { givenName: "Sam", phone: "555-0100" }, idempotency_key: "e2e-1" },
    }));
    expect(summary.status).toBe("confirmation_required");
    expect(summary.confirmationToken).toBeTruthy();
    expect(summary.cancellationPolicy).toBeDefined();

    const before = parse(await client.callTool({ name: "list_my_bookings", arguments: {} }));
    expect(before.bookings).toHaveLength(0);

    // 4. commit
    const booked = parse(await client.callTool({
      name: "create_booking",
      arguments: { slot_id: avail.slots[0].slot_id, customer_details: { givenName: "Sam", phone: "555-0100" }, idempotency_key: "e2e-1", confirmation_token: summary.confirmationToken },
    }));
    expect(booked.status).toBe("ok");
    const bookingId = booked.booking.booking_id;

    // 5. reschedule
    const later = parse(await client.callTool({
      name: "get_availability",
      arguments: { provider_id: provider.provider_id, service_id: service.service_id, from: new Date(Date.parse(avail.slots[0].ends_at) + 60 * 60_000).toISOString(), to, limit: 5 },
    }));
    const moveSummary = parse(await client.callTool({
      name: "reschedule_booking",
      arguments: { booking_id: bookingId, new_slot_id: later.slots[0].slot_id, idempotency_key: "e2e-2" },
    }));
    expect(moveSummary.status).toBe("confirmation_required");
    const moved = parse(await client.callTool({
      name: "reschedule_booking",
      arguments: { booking_id: bookingId, new_slot_id: later.slots[0].slot_id, idempotency_key: "e2e-2", confirmation_token: moveSummary.confirmationToken },
    }));
    expect(moved.booking.starts_at).toBe(later.slots[0].starts_at);

    // 6. cancel — the fee comes back before anything is cancelled
    const cancelSummary = parse(await client.callTool({ name: "cancel_booking", arguments: { booking_id: bookingId, idempotency_key: "e2e-3" } }));
    expect(cancelSummary.status).toBe("confirmation_required");
    expect(cancelSummary.cancellationPolicy).toBeDefined();
    const stillThere = parse(await client.callTool({ name: "list_my_bookings", arguments: {} }));
    expect(stillThere.bookings[0].status).toBe("confirmed");

    const cancelled = parse(await client.callTool({
      name: "cancel_booking",
      arguments: { booking_id: bookingId, idempotency_key: "e2e-3", confirmation_token: cancelSummary.confirmationToken },
    }));
    expect(cancelled.booking.status).toBe("cancelled");

    await client.close();
  });

  it("returns a structured error the agent can explain, not a transport fault", async () => {
    const client = await connect();
    const result: any = await client.callTool({
      name: "create_booking",
      arguments: { slot_id: "forged.slot.token", customer_details: { givenName: "Sam", phone: "555-0100" }, idempotency_key: "bad-1" },
    });
    expect(result.isError).toBe(true);
    const body = parse(result);
    expect(body.error.code).toBe("INVALID_REQUEST");
    expect(typeof body.error.message).toBe("string");
    await client.close();
  });

  it("keeps one user's bookings invisible to another", async () => {
    const a = await connect(API_KEY);
    const search = parse(await a.callTool({ name: "search_providers", arguments: { category: "manicure", limit: 3 } }));
    const provider = search.providers[0];
    const service = provider.services[0];
    const from = new Date(Date.now() + 60 * 60_000).toISOString();
    const to = new Date(Date.now() + 14 * 24 * 60 * 60_000).toISOString();
    const avail = parse(await a.callTool({ name: "get_availability", arguments: { provider_id: provider.provider_id, service_id: service.service_id, from, to, limit: 5 } }));
    const summary = parse(await a.callTool({ name: "create_booking", arguments: { slot_id: avail.slots[0].slot_id, customer_details: { givenName: "Sam", phone: "555-0100" }, idempotency_key: "iso-1" } }));
    await a.callTool({ name: "create_booking", arguments: { slot_id: avail.slots[0].slot_id, customer_details: { givenName: "Sam", phone: "555-0100" }, idempotency_key: "iso-1", confirmation_token: summary.confirmationToken } });

    const mine = parse(await a.callTool({ name: "list_my_bookings", arguments: {} }));
    expect(mine.bookings.length).toBeGreaterThan(0);
    await a.close();

    // A different credential maps to a different user, who must see nothing.
    const b = await connect(OTHER_API_KEY);
    const theirs = parse(await b.callTool({ name: "list_my_bookings", arguments: {} }));
    expect(theirs.bookings).toHaveLength(0);

    // And cannot reach the other user's booking by id.
    const attempt: any = await b.callTool({ name: "cancel_booking", arguments: { booking_id: mine.bookings[0].booking_id, idempotency_key: "iso-2" } });
    expect(attempt.isError).toBe(true);
    expect(parse(attempt).error.code).toBe("NOT_FOUND");
    await b.close();
  });
});

describe("hostile provider content over the wire", () => {
  it("never reaches the client unsanitised", async () => {
    const client = await connect();
    const raw: any = await client.callTool({ name: "search_providers", arguments: { category: "haircut", limit: 25 } });
    const text = raw.content[0].text as string;
    expect(text).not.toContain("<tool_call>");
    expect(text).not.toContain("[/PROVIDER_DATA]");
    expect(text).not.toMatch(/[​-‏‪-‮]/);
    await client.close();
  });
});

describe("payments and audit over the wire", () => {
  it("runs the full money path through the MCP server", async () => {
    const client = await connect();

    // Find something with a deposit.
    const search = parse(await client.callTool({ name: "search_providers", arguments: { category: "massage", limit: 5 } }));
    const provider = search.providers.find((p: any) => p.services.some((s: any) => s.deposit_required));
    const service = provider.services.find((s: any) => s.deposit_required);

    const from = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const to = new Date(Date.now() + 14 * 24 * 60 * 60_000).toISOString();
    const avail = parse(await client.callTool({ name: "get_availability", arguments: { provider_id: provider.provider_id, service_id: service.service_id, from, to, limit: 5 } }));

    const bookSummary = parse(await client.callTool({
      name: "create_booking",
      arguments: { slot_id: avail.slots[0].slot_id, customer_details: { givenName: "Pat", phone: "555-0199" }, idempotency_key: "pay-e2e-1" },
    }));
    const booked = parse(await client.callTool({
      name: "create_booking",
      arguments: { slot_id: avail.slots[0].slot_id, customer_details: { givenName: "Pat", phone: "555-0199" }, idempotency_key: "pay-e2e-1", confirmation_token: bookSummary.confirmationToken },
    }));
    const bookingId = booked.booking.booking_id;

    // Without a saved payment method the agent is told exactly what is wrong.
    const noMethod: any = await client.callTool({ name: "pay_or_deposit", arguments: { booking_id: bookingId, idempotency_key: "pay-e2e-2" } });
    const noMethodSummary = parse(noMethod);
    expect(noMethodSummary.status).toBe("confirmation_required");

    const attempt: any = await client.callTool({
      name: "pay_or_deposit",
      arguments: { booking_id: bookingId, idempotency_key: "pay-e2e-2", confirmation_token: noMethodSummary.confirmationToken },
    });
    expect(attempt.isError).toBe(true);
    expect(parse(attempt).error.details.reason).toBe("no_payment_method");

    // Save one the way a real user would, then pay.
    await app.store.paymentProfiles.put("user_integration", {
      customerRef: "cus_it_1",
      paymentMethodRef: "pm_it_1",
      label: "Visa ending 4242",
    });

    const paySummary = parse(await client.callTool({ name: "pay_or_deposit", arguments: { booking_id: bookingId, idempotency_key: "pay-e2e-3" } }));
    expect(paySummary.money.kind).toBe("deposit");
    const paid = parse(await client.callTool({
      name: "pay_or_deposit",
      arguments: { booking_id: bookingId, idempotency_key: "pay-e2e-3", confirmation_token: paySummary.confirmationToken },
    }));
    expect(paid.status).toBe("ok");
    expect(paid.kind).toBe("deposit");
    expect(paid.amount_outstanding).toBeGreaterThan(0);

    await client.close();
  });

  it("serves the user's audit trail without any personal data", async () => {
    const res = await fetch(`${baseUrl}/v1/audit?limit=50`, { headers: { Authorization: `Bearer ${API_KEY}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBeGreaterThan(0);

    const serialised = JSON.stringify(body.entries);
    expect(serialised).not.toContain("555-0199");
    expect(serialised).not.toContain("sam@example.com");
    // Field names are recorded so a Meta audit can see what was disclosed.
    expect(serialised).toContain("disclosed_fields");
  });

  it("requires authentication for the audit trail", async () => {
    const res = await fetch(`${baseUrl}/v1/audit`);
    expect(res.status).toBe(401);
  });
});

describe("rate limiting", () => {
  it("refuses a runaway agent with a retry hint it can explain", async () => {
    const limited = createApp({
      port: 0,
      apiKeys: { "rl-key": "user_rl" },
      signingSecret: "rate-limit-signing-secret-long-enough-01",
      logLevel: "error",
      rateLimitPerUser: { capacity: 3, refillPerSecond: 0.1 },
    });
    const port = await limited.listen(0);
    const client = new Client({ name: "rl", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: { Authorization: "Bearer rl-key" } },
      }),
    );

    let limitedResult: any = null;
    for (let i = 0; i < 8; i++) {
      const result: any = await client.callTool({ name: "list_my_bookings", arguments: {} });
      if (result.isError) {
        limitedResult = parse(result);
        break;
      }
    }

    expect(limitedResult).not.toBeNull();
    expect(limitedResult.error.code).toBe("RATE_LIMITED");
    expect(limitedResult.error.retryAfterSeconds).toBeGreaterThan(0);

    await client.close();
    await limited.close();
  });
});
