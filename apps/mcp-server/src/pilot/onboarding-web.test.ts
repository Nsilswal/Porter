import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createPilotStore, migratePostgres, type PilotBusiness, type PilotSession, type PilotStore } from "@porter/db";
import type { HttpClient } from "@porter/shared";
import { PilotAccounts } from "./accounts.js";
import { OwnerSquareCatalog } from "./catalog.js";
import { MerchantConnections } from "./connections.js";
import { PilotOnboarding } from "./onboarding.js";
import type { WebsitePreview } from "./importer.js";
import type { SignInEmail } from "./mail.js";
import { PilotWeb } from "./web.js";
import { opaqueToken } from "./security.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
class BrowserCookies {
  readonly values = new Map<string, string>();
  header(): string { return [...this.values].map(([name, value]) => `${name}=${value}`).join("; "); }
  absorb(response: Response): void {
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]!;
      const split = pair.indexOf("=");
      this.values.set(pair.slice(0, split), pair.slice(split + 1));
    }
  }
}

interface SquareFixture { merchantId: string; serviceAvailable: boolean; fee: number; priceMinor: number; policyText: string; requests: number }

describe.skipIf(!databaseUrl)("pilot onboarding HTTP flow with PostgreSQL", () => {
  const schema = `porter_onboarding_web_${randomUUID().replaceAll("-", "")}`;
  const messages: SignInEmail[] = [];
  const invitedEmails: string[] = [];
  const squares = new Map<string, SquareFixture>();
  const seenPaths: string[] = [];
  let store: PilotStore;
  let web: PilotWeb;
  let server: Server;
  let origin: string;
  let raw: Pool;
  let importer: ReturnType<typeof vi.fn<(url: string) => Promise<WebsitePreview>>>;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: databaseUrl, max: 1 });
    try { await admin.query(`CREATE SCHEMA "${schema}"`); } finally { await admin.end(); }
    const database = new URL(databaseUrl!);
    database.searchParams.set("options", `-c search_path=${schema}`);
    await migratePostgres(database.href);
    store = await createPilotStore({ connectionString: database.href, encryptionKey: randomBytes(32), maxConnections: 3 });
    raw = new Pool({ connectionString: database.href, max: 2 });
    server = createServer((req, res) => {
      seenPaths.push(req.url ?? "/");
      void web.handle(req, res, new URL(req.url ?? "/", origin)).then((handled) => {
        if (!handled) { res.statusCode = 404; res.end(); }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server");
    origin = `http://127.0.0.1:${address.port}`;
    const accounts = new PilotAccounts(store, { send: async (message) => { messages.push(message); } }, origin);
    const connections = new MerchantConnections({ store, environment: "sandbox", oauth: {
      authorizationUrl: (state) => `https://connect.squareupsandbox.com/oauth2/authorize?state=${state}`,
      exchangeCode: async () => { throw new Error("not used"); }, refreshTokens: async () => { throw new Error("not used"); }, revokeAuthorization: async () => undefined,
    } });
    importer = vi.fn(async (url: string): Promise<WebsitePreview> => ({
      submittedUrl: url, sourceUrl: url, fetchedAt: new Date().toISOString(), name: "Website Salon", description: "Imported description",
      bookingProvider: "square", services: [{ name: "Website Haircut", sourceUrl: url, priceText: "$1 website suggestion" }], warnings: [],
    }));
    const http: HttpClient = { async send(request) {
      const token = request.headers?.authorization?.slice("Bearer ".length) ?? "";
      const square = squares.get(token);
      if (!square) throw new Error("No Square fixture for this grant");
      square.requests++;
      const path = new URL(request.url).pathname;
      const bodies: Record<string, unknown> = {
        "/v2/locations": { locations: [{ id: "LOCATION", name: "Square Salon", status: "ACTIVE", currency: "USD", timezone: "America/New_York", address: { country: "US", address_line_1: "123 Main St" } },
          { id: "OTHER", name: "Other location", status: "ACTIVE", currency: "USD", timezone: "America/New_York", address: { country: "US" } }] },
        "/v2/bookings/location-booking-profiles": { location_booking_profiles: [{ location_id: "LOCATION", online_booking_enabled: true }, { location_id: "OTHER", online_booking_enabled: true }] },
        "/v2/bookings/business-booking-profile": { business_booking_profile: { seller_id: square.merchantId, booking_enabled: true, allow_user_cancel: true,
          business_appointment_settings: { cancellation_fee_money: { amount: square.fee, currency: "USD" }, cancellation_window_seconds: 86_400,
            cancellation_policy_text: square.policyText, location_types: ["BUSINESS_LOCATION"] } } },
        "/v2/bookings/team-member-booking-profiles": { team_member_booking_profiles: [{ team_member_id: "STAFF", display_name: "Alex", is_bookable: true }] },
        "/v2/catalog/search": { objects: [{ type: "ITEM", id: "ITEM", item_data: { name: "Square Haircut", product_type: "APPOINTMENTS_SERVICE", variations: [{
          type: "ITEM_VARIATION", id: "HAIRCUT", version: 42, item_variation_data: { name: "Standard", available_for_booking: square.serviceAvailable,
            pricing_type: "FIXED_PRICING", price_money: { amount: square.priceMinor, currency: "USD" }, service_duration: 1_800_000, team_member_ids: ["STAFF"] },
        }] } }] },
      };
      if (!bodies[path]) throw new Error("Unexpected provider endpoint");
      return { status: 200, headers: {}, body: bodies[path] };
    } };
    web = new PilotWeb({ store, accounts, connections, onboarding: new PilotOnboarding(store, importer),
      catalog: new OwnerSquareCatalog({ store, connections, environment: "sandbox", http }),
      config: { origin, environment: "sandbox", applicationId: "sandbox-app", applicationSecret: "test-secret", email: { mode: "file", directory: "/unused" }, invitedEmails, operatorEmails: [] } });
  });

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await raw?.end();
    await store?.close();
    const admin = new Pool({ connectionString: databaseUrl, max: 1 });
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); }
  });

  async function get(path: string, cookies = new BrowserCookies()): Promise<Response> {
    const response = await fetch(`${origin}${path}`, { redirect: "manual", headers: { Cookie: cookies.header() } });
    cookies.absorb(response);
    return response;
  }
  async function post(path: string, form: Record<string, string>, cookies: BrowserCookies, originHeader = origin): Promise<Response> {
    const response = await fetch(`${origin}${path}`, { method: "POST", redirect: "manual", headers: {
      Origin: originHeader, Cookie: cookies.header(), "Content-Type": "application/x-www-form-urlencoded",
    }, body: new URLSearchParams(form) });
    cookies.absorb(response);
    return response;
  }
  async function preview() {
    const cookies = new BrowserCookies();
    const landing = await get("/", cookies);
    expect(landing.status).toBe(200);
    const imported = await post("/onboarding/import", { website: "https://salon.example.test/" }, cookies);
    expect(imported.status).toBe(303);
    expect(imported.headers.get("location")).toBe("/onboarding/preview");
    return { cookies, imported, token: cookies.values.get("porter_draft")! };
  }
  async function signIn(cookies: BrowserCookies, invited = false) {
    if (!cookies.values.has("porter_browser")) await get("/signin", cookies);
    const email = `${randomUUID()}@example.test`;
    if (invited) invitedEmails.push(email);
    expect((await post("/signin/request", { email }, cookies)).status).toBe(200);
    const message = messages.find((entry) => entry.to === email)!;
    const verified = await post("/signin/verify", { token: new URL(message.url).hash.slice(1) }, cookies);
    expect(verified.status).toBe(303);
    const identity = await store.identities.getOrCreate(email);
    const session = (await web.options.accounts.session(cookies.values.get("porter_session")!))!;
    return { email, identity, session, verified };
  }
  async function claimed(invited = false) {
    const draft = await preview();
    const owner = await signIn(draft.cookies, invited);
    const response = await post("/onboarding/claim", { name: "Owner Salon", draft: draft.token }, draft.cookies);
    expect(response.status).toBe(303);
    const business = (await store.businesses.list(owner.identity.userId))[0]!;
    return { ...draft, ...owner, business, response };
  }
  async function connect(business: PilotBusiness, session: PilotSession) {
    const token = `square-${randomUUID()}`;
    const square = { merchantId: randomUUID(), serviceAvailable: true, fee: 0, priceMinor: 6500, policyText: "Cancel at least 24 hours before your appointment. No cancellation fee.", requests: 0 };
    squares.set(token, square);
    await store.connections.connect(business.ownerId, { businessId: business.id, environment: "sandbox", merchantId: square.merchantId,
      accessToken: token, refreshToken: `refresh-${randomUUID()}`, expiresAt: new Date(Date.now() + 30 * 86_400_000), scopes: [] }, null, session.sessionHash);
    return square;
  }
  async function selected(invited = true) {
    const setup = await claimed(invited);
    const square = await connect(setup.business, setup.session);
    const route = `/owner/businesses/${setup.business.id}`;
    const location = await post(`${route}/location`, { location: "LOCATION", location_matches: "yes" }, setup.cookies);
    expect(location.status).toBe(303);
    const business = (await store.businesses.get(setup.identity.userId, setup.business.id))!;
    const review = await get(`${route}/review`, setup.cookies);
    expect(review.status).toBe(200);
    return { ...setup, business, square, route, catalogDigest: digestFrom(await review.text()) };
  }
  function digestFrom(html: string): string {
    const digest = /name="catalog_digest" value="([a-f0-9]{64})"/.exec(html)?.[1];
    if (!digest) throw new Error("Review did not contain its authoritative catalog digest");
    return digest;
  }
  function activation(business: PilotBusiness, catalogDigest: string): Record<string, string> {
    return { review_version: business.updatedAt.toISOString(), merchant_matches: "yes", name: "Reviewed Salon", description: "Reviewed description",
      service_HAIRCUT: "yes", policy_reviewed: "yes", no_payment_obligations: "yes", catalog_digest: catalogDigest };
  }

  it("persists an anonymous preview, keeps draft credentials out of URLs/HTML, and returns to it after sign-in", async () => {
    const f = await preview();
    const response = await get("/onboarding/preview", f.cookies);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("Website Salon");
    expect(html).toContain('href="/signin"');
    expect(html).not.toContain(f.token);
    expect(f.imported.headers.getSetCookie().join(" ")).toContain("HttpOnly; SameSite=Lax");
    expect(seenPaths.every((path) => !path.includes(f.token))).toBe(true);
    expect(JSON.stringify((await raw.query("SELECT * FROM import_drafts")).rows)).not.toContain(f.token);
    const signed = await signIn(f.cookies);
    expect(signed.verified.headers.get("location")).toBe("/onboarding/preview");
    const saved = await get("/onboarding/preview", f.cookies);
    expect(await saved.text()).toContain('action="/onboarding/claim"');
  });

  it("binds preview and claim to the original browser without spending a draft on a failed claim", async () => {
    const f = await preview();
    const owner = await signIn(f.cookies);
    const stranger = new BrowserCookies();
    stranger.values.set("porter_draft", f.token);
    stranger.values.set("porter_browser", opaqueToken());
    stranger.values.set("porter_session", f.cookies.values.get("porter_session")!);
    expect((await get("/onboarding/preview", stranger)).status).toBe(400);
    expect((await post("/onboarding/claim", { name: "Wrong browser", draft: f.token }, stranger)).status).toBe(400);
    expect(await store.businesses.list(owner.identity.userId)).toHaveLength(0);
    const claimedResponse = await post("/onboarding/claim", { name: "Actual owner", draft: f.token }, f.cookies);
    expect(claimedResponse.status).toBe(303);
    expect(claimedResponse.headers.getSetCookie().join(" ")).toContain("porter_draft=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    const businesses = await store.businesses.list(owner.identity.userId);
    expect(businesses).toHaveLength(1);
    expect(businesses[0]).toMatchObject({ websiteUrl: "https://salon.example.test/", profile: { imported: { name: "Website Salon" } } });
    expect((await get("/onboarding/preview", f.cookies)).status).toBe(400);
  });

  it("rejects foreign-origin imports and claims before importer or database mutation", async () => {
    const cookies = new BrowserCookies();
    await get("/", cookies);
    const before = importer.mock.calls.length;
    expect((await post("/onboarding/import", { website: "https://salon.example.test/" }, cookies, "https://attacker.example")).status).toBe(403);
    expect(importer.mock.calls).toHaveLength(before);
    const f = await preview();
    const owner = await signIn(f.cookies);
    expect((await post("/onboarding/claim", { name: "Rejected" }, f.cookies, "https://attacker.example")).status).toBe(403);
    expect(await store.businesses.list(owner.identity.userId)).toHaveLength(0);
  });

  it("claims the draft displayed in each tab without consuming another tab's resume cookie", async () => {
    const first = await preview();
    const owner = await signIn(first.cookies);
    const firstHtml = await (await get("/onboarding/preview", first.cookies)).text();
    expect(firstHtml).toContain(`name="draft" value="${first.token}"`);
    expect((await post("/onboarding/import", { website: "https://second-salon.example.test/" }, first.cookies)).status).toBe(303);
    const secondToken = first.cookies.values.get("porter_draft")!;
    expect(secondToken).not.toBe(first.token);
    expect((await post("/onboarding/claim", { name: "Missing displayed draft" }, first.cookies)).status).toBe(400);
    const firstClaim = await post("/onboarding/claim", { name: "First salon", draft: first.token }, first.cookies);
    expect(firstClaim.status).toBe(303);
    expect(firstClaim.headers.getSetCookie()).toEqual([]);
    expect(first.cookies.values.get("porter_draft")).toBe(secondToken);
    expect(await store.businesses.list(owner.identity.userId)).toEqual([expect.objectContaining({ name: "First salon", websiteUrl: "https://salon.example.test/" })]);
    const secondHtml = await (await get("/onboarding/preview", first.cookies)).text();
    expect(secondHtml).toContain(`name="draft" value="${secondToken}"`);
    expect((await post("/onboarding/claim", { name: "Second salon", draft: secondToken }, first.cookies)).status).toBe(303);
    expect(first.cookies.values.get("porter_draft")).toBe("");
    expect(await store.businesses.list(owner.identity.userId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "First salon", websiteUrl: "https://salon.example.test/" }),
      expect.objectContaining({ name: "Second salon", websiteUrl: "https://second-salon.example.test/" }),
    ]));
    expect(seenPaths.every((path) => !path.includes(first.token) && !path.includes(secondToken))).toBe(true);
  });

  it("saves setup for non-invited owners but denies forged activation requests", async () => {
    const f = await selected(false);
    const review = await get(`${f.route}/review`, f.cookies);
    expect(review.status).toBe(200);
    expect(await review.text()).toContain("limited to invited pilot owners");
    const before = f.square.requests;
    expect((await post(`${f.route}/activate`, activation(f.business, f.catalogDigest), f.cookies)).status).toBe(403);
    expect(f.square.requests).toBe(before);
    await expect(store.businesses.get(f.identity.userId, f.business.id)).resolves.toMatchObject({ status: "draft" });
  });

  it("requires explicit location confirmation and keeps the selected location immutable", async () => {
    const f = await claimed(true);
    await connect(f.business, f.session);
    const route = `/owner/businesses/${f.business.id}`;
    expect((await post(`${route}/location`, { location: "LOCATION" }, f.cookies)).status).toBe(400);
    expect((await store.businesses.get(f.identity.userId, f.business.id))!.selectedLocationId).toBeNull();
    expect((await post(`${route}/location`, { location: "UNKNOWN", location_matches: "yes" }, f.cookies)).status).toBe(400);
    expect((await post(`${route}/location`, { location: "LOCATION", location_matches: "yes" }, f.cookies)).status).toBe(303);
    expect((await post(`${route}/location`, { location: "OTHER", location_matches: "yes" }, f.cookies)).status).toBe(409);
    expect((await store.businesses.get(f.identity.userId, f.business.id))!.selectedLocationId).toBe("LOCATION");
  });

  it("uses fresh Square catalog details at activation and never trusts website prices", async () => {
    const f = await selected();
    const review = await get(`${f.route}/review`, f.cookies);
    const html = await review.text();
    expect(html).toContain("Square Haircut");
    expect(html).toContain("$65.00 USD");
    expect(html).not.toContain("$1 website suggestion");
    f.square.serviceAvailable = false;
    expect((await post(`${f.route}/activate`, activation(f.business, f.catalogDigest), f.cookies)).status).toBe(409);
    await expect(store.businesses.get(f.identity.userId, f.business.id)).resolves.toMatchObject({ status: "draft" });
    f.square.serviceAvailable = true;
    const activated = await post(`${f.route}/activate`, activation(f.business, f.catalogDigest), f.cookies);
    expect(activated.status).toBe(200);
    const business = (await store.businesses.get(f.identity.userId, f.business.id))!;
    expect(business).toMatchObject({ status: "active", profile: { enabledServiceIds: ["HAIRCUT"], review: { services: [{ priceMinor: 6500 }] }, imported: { name: "Website Salon" } } });
  });

  it("requires the currently reviewed business snapshot and all owner confirmations", async () => {
    const f = await selected();
    for (const field of ["merchant_matches", "policy_reviewed", "no_payment_obligations"]) {
      const form = activation(f.business, f.catalogDigest);
      delete form[field];
      expect((await post(`${f.route}/activate`, form, f.cookies)).status).toBe(400);
    }
    await store.businesses.update(f.identity.userId, f.business.id, { name: "Changed elsewhere" });
    const before = f.square.requests;
    expect((await post(`${f.route}/activate`, activation(f.business, f.catalogDigest), f.cookies)).status).toBe(409);
    expect(f.square.requests).toBe(before);
  });

  it.each(["price", "policy"] as const)("requires a fresh owner review when supported Square %s changes", async (field) => {
    const f = await selected();
    const displayed = activation(f.business, f.catalogDigest);
    if (field === "price") f.square.priceMinor = 7900;
    else f.square.policyText = "Contact us by phone if you need to cancel. No cancellation fee.";
    const stale = await post(`${f.route}/activate`, displayed, f.cookies);
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain("changed after you opened this page");
    expect(await store.businesses.get(f.identity.userId, f.business.id)).toMatchObject({ status: "draft", updatedAt: f.business.updatedAt });
    const freshHtml = await (await get(`${f.route}/review`, f.cookies)).text();
    expect(freshHtml).toContain(field === "price" ? "$79.00 USD" : "Contact us by phone");
    const newDigest = digestFrom(freshHtml);
    expect(newDigest).not.toBe(f.catalogDigest);
    expect((await post(`${f.route}/activate`, activation(f.business, newDigest), f.cookies)).status).toBe(200);
    expect(await store.businesses.get(f.identity.userId, f.business.id)).toMatchObject({ status: "active" });
  });

  it("rejects activation without the catalog shown in the form", async () => {
    const f = await selected();
    const form = activation(f.business, f.catalogDigest);
    delete form.catalog_digest;
    expect((await post(`${f.route}/activate`, form, f.cookies)).status).toBe(409);
    expect(await store.businesses.get(f.identity.userId, f.business.id)).toMatchObject({ status: "draft" });
  });

  it("cannot activate when disconnection occurs between fresh catalog validation and the transaction", async () => {
    const f = await selected();
    const original = web.catalog.validateActivation.bind(web.catalog);
    vi.spyOn(web.catalog, "validateActivation").mockImplementationOnce(async (...args) => {
      const review = await original(...args);
      await store.connections.beginDisconnect(f.identity.userId, f.business.id, "sandbox");
      return review;
    });
    expect((await post(`${f.route}/activate`, activation(f.business, f.catalogDigest), f.cookies)).status).toBe(409);
    await expect(store.businesses.get(f.identity.userId, f.business.id)).resolves.toMatchObject({ status: "paused" });
    await expect(store.connections.get(f.identity.userId, f.business.id, "sandbox")).resolves.toMatchObject({ status: "disconnecting" });
  });

  it("cannot overwrite an owner edit made after catalog validation", async () => {
    const f = await selected();
    const original = web.catalog.validateActivation.bind(web.catalog);
    vi.spyOn(web.catalog, "validateActivation").mockImplementationOnce(async (...args) => {
      const review = await original(...args);
      await store.businesses.update(f.identity.userId, f.business.id, { name: "Newest owner edit" });
      return review;
    });
    expect((await post(`${f.route}/activate`, activation(f.business, f.catalogDigest), f.cookies)).status).toBe(409);
    await expect(store.businesses.get(f.identity.userId, f.business.id)).resolves.toMatchObject({ status: "draft", name: "Newest owner edit" });
  });

  it("isolates owner routes and exposes only active connected businesses on public share pages", async () => {
    const f = await selected();
    const otherCookies = new BrowserCookies();
    await signIn(otherCookies, true);
    for (const suffix of ["", "/review"]) expect((await get(`${f.route}${suffix}`, otherCookies)).status).toBe(404);
    for (const suffix of ["/activate", "/pause", "/location"]) expect((await post(`${f.route}${suffix}`, activation(f.business, f.catalogDigest), otherCookies)).status).toBe(404);
    expect((await get(`/s/${f.business.id}`)).status).toBe(404);
    expect((await post(`${f.route}/activate`, activation(f.business, f.catalogDigest), f.cookies)).status).toBe(200);
    const publicPage = await get(`/s/${f.business.id}`);
    const html = await publicPage.text();
    expect(publicPage.status).toBe(200);
    expect(html).toContain('href="/connect"');
    expect(html).not.toContain(f.session.sessionHash);
    expect(html).not.toContain(f.email);
    expect((await post(`${f.route}/pause`, {}, f.cookies)).status).toBe(303);
    expect((await get(`/s/${f.business.id}`)).status).toBe(404);
  });

  it("HTML-escapes imported suggestions, owner fields and public descriptions", async () => {
    importer.mockResolvedValueOnce({ submittedUrl: "https://salon.example.test/", sourceUrl: "https://salon.example.test/", fetchedAt: new Date().toISOString(),
      name: '\"><script>previewAttack()</script>', description: "<img src=x onerror=previewAttack()>", bookingProvider: "unknown",
      services: [{ name: "<b>Untrusted service</b>", sourceUrl: "https://salon.example.test/" }], warnings: ["<svg onload=previewAttack()>"] });
    const draft = await preview();
    const html = await (await get("/onboarding/preview", draft.cookies)).text();
    expect(html).not.toContain("<script>previewAttack()");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("&lt;b&gt;Untrusted service&lt;/b&gt;");
    const f = await selected();
    await store.businesses.update(f.identity.userId, f.business.id, { name: '</h1><script>ownerAttack()</script>', profile: { description: '<img src=x onerror=ownerAttack()>' }, status: "active" });
    const publicHtml = await (await get(`/s/${f.business.id}`)).text();
    expect(publicHtml).not.toContain("<script>ownerAttack()");
    expect(publicHtml).not.toContain("<img src=x");
    expect(publicHtml).toContain("&lt;img src=x");
    const ownerHtml = await (await get(`${f.route}/review`, f.cookies)).text();
    expect(ownerHtml).not.toContain("<script>ownerAttack()");
    expect(ownerHtml).toContain("&lt;img src=x");
  });
});
