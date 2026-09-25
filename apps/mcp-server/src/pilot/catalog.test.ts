import { afterEach, describe, expect, it, vi } from "vitest";
import type { MerchantCredentials, PilotBusiness, PilotSession, PilotStore } from "@porter/db";
import type { HttpClient, HttpRequest } from "@porter/shared";
import { OwnerSquareCatalog, type ActivationSelection } from "./catalog.js";
import { tokenHash } from "./security.js";

const NOW = new Date("2026-09-25T12:00:00Z");
const SESSION: PilotSession = { userId: "owner", sessionHash: tokenHash("session"), createdAt: NOW, expiresAt: new Date("2026-10-25T12:00:00Z"), revokedAt: null };
const BUSINESS: PilotBusiness = { id: "business", ownerId: SESSION.userId, websiteUrl: "https://salon.example/", name: "Salon", status: "draft",
  selectedLocationId: null, profile: {}, createdAt: NOW, updatedAt: NOW };
const CREDENTIALS: MerchantCredentials = { businessId: BUSINESS.id, environment: "sandbox", merchantId: "MERCHANT", status: "connected", version: 3,
  accessToken: "private-merchant-token", refreshToken: "private-refresh-token", scopes: [], expiresAt: new Date("2026-10-25T12:00:00Z"),
  createdAt: NOW, updatedAt: NOW, refreshedAt: NOW };
const SELECTION: ActivationSelection = { selectedLocationId: "LOCATION", enabledServiceIds: ["HAIRCUT"], policyReviewed: true, noPaymentObligations: true };

function item(id = "HAIRCUT", variation: Record<string, unknown> = {}) {
  return { type: "ITEM", id: `ITEM_${id}`, item_data: { name: "Haircut", description: "Wash and cut", product_type: "APPOINTMENTS_SERVICE", variations: [{
    type: "ITEM_VARIATION", id, version: 123, present_at_all_locations: false, present_at_location_ids: ["LOCATION"],
    item_variation_data: { item_id: `ITEM_${id}`, name: "Standard", available_for_booking: true, service_duration: 1_800_000,
      pricing_type: "FIXED_PRICING", price_money: { amount: 6500, currency: "USD" }, team_member_ids: ["STAFF"], ...variation },
  }] } };
}

function fixture() {
  let live = true;
  let business = structuredClone(BUSINESS);
  let current = structuredClone(CREDENTIALS);
  const data: Record<string, unknown> = {
    locations: [{ id: "LOCATION", name: "Downtown", business_name: "Salon", status: "ACTIVE", currency: "USD", timezone: "America/New_York",
      address: { address_line_1: "123 Main St", locality: "Boston", administrative_district_level_1: "MA", postal_code: "02110", country: "US" } },
    { id: "OTHER_LOCATION", name: "Other", status: "ACTIVE", currency: "USD", timezone: "America/New_York", address: { country: "US" } }],
    location_booking_profiles: [{ location_id: "LOCATION", online_booking_enabled: true }, { location_id: "OTHER_LOCATION", online_booking_enabled: true }],
    business_booking_profile: { seller_id: "MERCHANT", booking_enabled: true, allow_user_cancel: true,
      business_appointment_settings: { cancellation_window_seconds: 86_400, cancellation_fee_money: { amount: 0, currency: "USD" },
        cancellation_policy_text: "Cancel up to 24 hours before your appointment. No cancellation fee." } },
    team_member_booking_profiles: [{ team_member_id: "STAFF", display_name: "Alex", is_bookable: true }, { team_member_id: "NOT_BOOKABLE", display_name: "Not bookable", is_bookable: false }],
    objects: [item()],
  };
  const store = {
    sessions: { lookup: vi.fn(async (sessionHash: string) => live && sessionHash === SESSION.sessionHash ? SESSION : null) },
    businesses: { get: vi.fn(async (ownerId: string, id: string) => live && ownerId === business.ownerId && id === business.id ? structuredClone(business) : null) },
    connections: { get: vi.fn(async () => structuredClone(current)) },
  };
  const connections = { credentials: vi.fn(async () => structuredClone(current)) };
  const requests: HttpRequest[] = [];
  let intercept: ((request: HttpRequest) => Promise<{ status: number; headers: Record<string, string>; body: unknown } | undefined>) | undefined;
  const http: HttpClient = { async send(request) {
    requests.push(request);
    const override = await intercept?.(request);
    if (override) return override;
    const path = new URL(request.url).pathname;
    const key = ({ "/v2/locations": "locations", "/v2/bookings/location-booking-profiles": "location_booking_profiles",
      "/v2/bookings/business-booking-profile": "business_booking_profile", "/v2/bookings/team-member-booking-profiles": "team_member_booking_profiles",
      "/v2/catalog/search": "objects" } as Record<string, string>)[path];
    if (!key) throw new Error("Unexpected request");
    return { status: 200, headers: {}, body: { [key]: structuredClone(data[key]) } };
  } };
  const service = new OwnerSquareCatalog({ store: store as unknown as PilotStore, connections, environment: "sandbox", http, now: () => NOW });
  return { service, data, store, connections, requests, http,
    setBusiness(value: Partial<PilotBusiness>) { business = { ...business, ...value }; },
    setConnection(value: Partial<MerchantCredentials>) { current = { ...current, ...value }; },
    revokeSession() { live = false; },
    intercept(fn: NonNullable<typeof intercept>) { intercept = fn; },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Square owner catalog review", () => {
  it("lists merchant locations without implicitly choosing the first location", async () => {
    const f = fixture();
    const review = await f.service.review(SESSION, BUSINESS.id);
    expect(review.selectedLocationId).toBeNull();
    expect(review.locations).toHaveLength(2);
    expect(review.services).toEqual([]);
    expect(review.staff).toEqual([]);
    expect(f.requests).toHaveLength(3);
    expect(review).toMatchObject({ businessId: BUSINESS.id, merchantId: "MERCHANT", connectionVersion: 3, fetchedAt: NOW.toISOString() });
    expect(JSON.stringify(review)).not.toContain(CREDENTIALS.accessToken);
    expect(JSON.stringify(review)).not.toContain(CREDENTIALS.refreshToken);
  });

  it("loads authoritative fixed-price services and location-filtered bookable staff", async () => {
    const f = fixture();
    const review = await f.service.review(SESSION, BUSINESS.id, "LOCATION");
    expect(review.services).toEqual([expect.objectContaining({ id: "HAIRCUT", priceMinor: 6500, currency: "USD", durationMinutes: 30,
      staffIds: ["STAFF"], supported: true, blockingReasons: [] })]);
    expect(review.staff).toEqual([{ id: "STAFF", name: "Alex" }]);
    expect(review.locations[0]).toMatchObject({ country: "US", currency: "USD", timezone: "America/New_York", supported: true });
    const staffRequest = f.requests.find((request) => new URL(request.url).pathname.endsWith("team-member-booking-profiles"))!;
    expect(new URL(staffRequest.url).searchParams.get("location_id")).toBe("LOCATION");
    expect(new URL(staffRequest.url).searchParams.get("bookable_only")).toBe("true");
    expect(f.requests.every((request) => new URL(request.url).origin === "https://connect.squareupsandbox.com")).toBe(true);
    expect(f.requests.every((request) => request.headers?.authorization === `Bearer ${CREDENTIALS.accessToken}` && request.headers?.["square-version"] === "2025-01-23")).toBe(true);
  });

  it("authorizes the current owner/session before accessing any merchant credentials", async () => {
    const f = fixture();
    await expect(f.service.review({ ...SESSION, userId: "another-owner" }, BUSINESS.id, "LOCATION")).rejects.toMatchObject({ status: 401 });
    await expect(f.service.review(SESSION, "another-business", "LOCATION")).rejects.toMatchObject({ status: 404 });
    f.revokeSession();
    await expect(f.service.review(SESSION, BUSINESS.id, "LOCATION")).rejects.toMatchObject({ status: 401 });
    expect(f.connections.credentials).not.toHaveBeenCalled();
    expect(f.requests).toHaveLength(0);
  });

  it("rejects another merchant, environment, expired or disconnected credentials", async () => {
    for (const change of [{ businessId: "other-business" }, { environment: "production" as const }, { status: "disconnecting" as const }, { expiresAt: NOW }]) {
      const f = fixture();
      f.setConnection(change);
      await expect(f.service.review(SESSION, BUSINESS.id)).rejects.toMatchObject({ code: "square_connection_unavailable" });
      expect(f.requests).toHaveLength(0);
    }
    const f = fixture();
    (f.data.business_booking_profile as Record<string, unknown>).seller_id = "OTHER_MERCHANT";
    await expect(f.service.review(SESSION, BUSINESS.id)).rejects.toMatchObject({ code: "square_catalog_unavailable" });
  });

  it("rejects unknown locations and never changes an already selected location", async () => {
    const f = fixture();
    await expect(f.service.review(SESSION, BUSINESS.id, "UNKNOWN")).rejects.toMatchObject({ code: "square_selection_invalid" });
    f.requests.length = 0;
    f.setBusiness({ selectedLocationId: "LOCATION" });
    await expect(f.service.review(SESSION, BUSINESS.id, "OTHER_LOCATION")).rejects.toMatchObject({ code: "square_location_changed" });
    expect(f.requests).toHaveLength(0);
    await expect(f.service.review(SESSION, BUSINESS.id)).resolves.toMatchObject({ selectedLocationId: "LOCATION" });
  });

  it("rechecks logout, selected location and connection generation after provider reads", async () => {
    for (const mutation of [(f: ReturnType<typeof fixture>) => f.revokeSession(), (f: ReturnType<typeof fixture>) => f.setConnection({ version: 4 }),
      (f: ReturnType<typeof fixture>) => f.setConnection({ status: "disconnecting" }), (f: ReturnType<typeof fixture>) => f.setBusiness({ selectedLocationId: "OTHER_LOCATION" })]) {
      const f = fixture();
      f.intercept(async (request) => { if (new URL(request.url).pathname === "/v2/catalog/search") mutation(f); return undefined; });
      await expect(f.service.review(SESSION, BUSINESS.id, "LOCATION")).rejects.toBeInstanceOf(Error);
    }
  });

  it("paginates catalog, staff and booking locations without exposing provider cursors", async () => {
    const f = fixture();
    f.intercept(async (request) => {
      const url = new URL(request.url);
      const body = request.body as Record<string, unknown> | undefined;
      if (url.pathname === "/v2/catalog/search") return { status: 200, headers: {}, body: body?.cursor ? { objects: [item("SECOND")] } : { objects: [item()], cursor: "catalog-next" } };
      if (url.pathname.endsWith("team-member-booking-profiles")) return { status: 200, headers: {}, body: url.searchParams.has("cursor") ? { team_member_booking_profiles: [{ team_member_id: "STAFF", is_bookable: true }] } : { team_member_booking_profiles: [], cursor: "staff-next" } };
      if (url.pathname.endsWith("location-booking-profiles")) return { status: 200, headers: {}, body: url.searchParams.has("cursor") ? { location_booking_profiles: f.data.location_booking_profiles } : { location_booking_profiles: [], cursor: "location-next" } };
      return undefined;
    });
    const review = await f.service.review(SESSION, BUSINESS.id, "LOCATION");
    expect(review.services.map((service) => service.id)).toEqual(["HAIRCUT", "SECOND"]);
    expect(review.services.every((service) => service.supported)).toBe(true);
    expect(JSON.stringify(review)).not.toContain("catalog-next");
  });

  it("refuses incomplete pagination, oversized pages and malformed profile data", async () => {
    for (const response of [
      { objects: [], cursor: "repeated" },
      { objects: Array.from({ length: 5_001 }, () => item()) },
      { objects: "invalid" },
    ]) {
      const f = fixture();
      f.intercept(async (request) => new URL(request.url).pathname === "/v2/catalog/search" ? { status: 200, headers: {}, body: response } : undefined);
      await expect(f.service.review(SESSION, BUSINESS.id, "LOCATION")).rejects.toMatchObject({ code: "square_catalog_unavailable" });
      expect(f.requests.length).toBeLessThan(25);
    }
  });

  it("bounds error messages and discards transport secrets and provider details", async () => {
    for (const behavior of ["throw", "redirect", "errors", "malformed"] as const) {
      const f = fixture();
      f.intercept(async () => {
        if (behavior === "throw") throw new Error(`Authorization: Bearer ${CREDENTIALS.accessToken}`);
        return { status: behavior === "redirect" ? 302 : 200, headers: { location: "https://attacker.example/" },
          body: behavior === "errors" ? { errors: [{ detail: CREDENTIALS.accessToken }] } : `${CREDENTIALS.accessToken}<html>` };
      });
      const error = await f.service.review(SESSION, BUSINESS.id).catch((value: unknown) => value);
      expect(error).toMatchObject({ code: "square_catalog_unavailable" });
      expect(String(error)).not.toContain(CREDENTIALS.accessToken);
      expect(String(error)).not.toContain("attacker.example");
      expect(String(error).length).toBeLessThan(200);
    }
  });

  it("uses redirect:error and the fixed production endpoint in the default HTTP client", async () => {
    const f = fixture();
    f.setConnection({ environment: "production" });
    const fetchMock = vi.fn(async () => new Response("", { status: 302, headers: { location: "https://attacker.example/" } }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new OwnerSquareCatalog({ store: f.store as unknown as PilotStore, connections: f.connections, environment: "production", now: () => NOW });
    await expect(service.review(SESSION, BUSINESS.id)).rejects.toMatchObject({ code: "square_catalog_unavailable" });
    for (const [url, init] of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect(new URL(url).origin).toBe("https://connect.squareup.com");
      expect(init.redirect).toBe("error");
    }
  });

  it("does not make provider requests after caller cancellation", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(f.service.review(SESSION, BUSINESS.id, undefined, controller.signal)).rejects.toMatchObject({ code: "square_catalog_unavailable" });
    expect(f.requests).toHaveLength(0);
  });
});

describe("fresh Square activation eligibility", () => {
  it("validates current service and policy details without changing unknown policy into a verified zero fee", async () => {
    const f = fixture();
    (f.data.business_booking_profile as Record<string, unknown>).business_appointment_settings = { cancellation_fee_money: { currency: "USD" } };
    const review = await f.service.validateActivation(SESSION, BUSINESS.id, SELECTION);
    expect(review.policy).toMatchObject({ known: false, cancellationFeeMinor: null, cancellationWindowSeconds: null,
      paymentRequirements: "owner_attestation_required", requiresAttestation: true });
    expect(review.blockingReasons).toEqual([]);
  });

  it.each(["policyReviewed", "noPaymentObligations"] as const)("requires the explicit %s attestation even when cancellation fees are zero", async (field) => {
    const f = fixture();
    await expect(f.service.validateActivation(SESSION, BUSINESS.id, { ...SELECTION, [field]: false })).rejects.toMatchObject({ code: "policy_attestation_required" });
  });

  it("freshly rejects a cancellation fee added since the owner's previous review", async () => {
    const f = fixture();
    await f.service.review(SESSION, BUSINESS.id, "LOCATION");
    const profile = f.data.business_booking_profile as { business_appointment_settings: Record<string, unknown> };
    profile.business_appointment_settings.cancellation_fee_money = { amount: 2500, currency: "USD" };
    await expect(f.service.validateActivation(SESSION, BUSINESS.id, SELECTION)).rejects.toMatchObject({ code: "square_activation_blocked" });
    expect(f.requests.filter((request) => new URL(request.url).pathname.endsWith("business-booking-profile"))).toHaveLength(2);
  });

  it.each(["A 50% deposit is required to book.", "We require a credit card on file.", "Prepayment is mandatory for this service.", "We charge a no-show fee."])("blocks an explicit payment obligation in Square policy text: %s", async (text) => {
    const f = fixture();
    (f.data.business_booking_profile as { business_appointment_settings: Record<string, unknown> }).business_appointment_settings.cancellation_policy_text = text;
    await expect(f.service.validateActivation(SESSION, BUSINESS.id, SELECTION)).rejects.toMatchObject({ code: "square_activation_blocked" });
  });

  it("does not interpret an explicit no-deposit statement as a deposit requirement", async () => {
    const f = fixture();
    (f.data.business_booking_profile as { business_appointment_settings: Record<string, unknown> }).business_appointment_settings.cancellation_policy_text = "No deposit is required. Cancel at least 24 hours in advance.";
    await expect(f.service.validateActivation(SESSION, BUSINESS.id, SELECTION)).resolves.toMatchObject({ connectionVersion: 3 });
  });

  it.each(["No cancellation fee will be charged.", "A cancellation fee is not charged.", "No no-show fee is collected.", "A credit card is not required."])("keeps an explicit negative policy eligible for owner review: %s", async (text) => {
    const f = fixture();
    (f.data.business_booking_profile as { business_appointment_settings: Record<string, unknown> }).business_appointment_settings.cancellation_policy_text = text;
    await expect(f.service.validateActivation(SESSION, BUSINESS.id, SELECTION)).resolves.toMatchObject({ connectionVersion: 3 });
  });

  it("blocks inactive/non-US/non-USD locations, disabled online booking and incomplete location settings", async () => {
    for (const changes of [{ status: "INACTIVE" }, { address: { country: "CA" } }, { currency: "CAD" }, { timezone: "invalid/timezone" }, { currency: undefined }]) {
      const f = fixture();
      (f.data.locations as Record<string, unknown>[])[0] = { ...(f.data.locations as Record<string, unknown>[])[0], ...changes };
      await expect(f.service.validateActivation(SESSION, BUSINESS.id, SELECTION)).rejects.toMatchObject({ code: "square_activation_blocked" });
    }
    const f = fixture();
    f.data.location_booking_profiles = [];
    await expect(f.service.validateActivation(SESSION, BUSINESS.id, SELECTION)).rejects.toMatchObject({ code: "square_activation_blocked" });
  });

  it("requires Square Appointments account setup and rejects invalid fee data", async () => {
    for (const changes of [{ booking_enabled: false }, { business_appointment_settings: undefined },
      { business_appointment_settings: { cancellation_fee_money: { amount: "invalid", currency: "USD" } } }]) {
      const f = fixture();
      f.data.business_booking_profile = { ...(f.data.business_booking_profile as object), ...changes };
      await expect(f.service.validateActivation(SESSION, BUSINESS.id, SELECTION)).rejects.toMatchObject({ code: "square_activation_blocked" });
    }
  });

  it("requires confirmed customer cancellation support for the pilot", async () => {
    for (const allow_user_cancel of [false, undefined]) {
      const f = fixture();
      (f.data.business_booking_profile as Record<string, unknown>).allow_user_cancel = allow_user_cancel;
      const review = await f.service.review(SESSION, BUSINESS.id, "LOCATION");
      expect(review.policy.customerCancellationAllowed).toBe(false);
      await expect(f.service.validateActivation(SESSION, BUSINESS.id, SELECTION)).rejects.toMatchObject({ code: "square_activation_blocked" });
    }
  });

  it("does not infer service assignments from absent or empty team-member lists", async () => {
    for (const team_member_ids of [undefined, []]) {
      const f = fixture();
      f.data.objects = [item("HAIRCUT", { team_member_ids })];
      const review = await f.service.review(SESSION, BUSINESS.id, "LOCATION");
      expect(review.staff).toHaveLength(1);
      expect(review.services[0]).toMatchObject({ staffIds: [], supported: false });
      await expect(f.service.validateActivation(SESSION, BUSINESS.id, SELECTION)).rejects.toMatchObject({ code: "square_activation_blocked" });
    }
  });

  it("blocks an explicit home-visit-only account while preserving unknown location-type settings for review", async () => {
    const f = fixture();
    const settings = (f.data.business_booking_profile as { business_appointment_settings: Record<string, unknown> }).business_appointment_settings;
    settings.location_types = ["CUSTOMER_LOCATION"];
    await expect(f.service.validateActivation(SESSION, BUSINESS.id, SELECTION)).rejects.toMatchObject({ code: "square_activation_blocked" });
    settings.location_types = ["BUSINESS_LOCATION"];
    await expect(f.service.validateActivation(SESSION, BUSINESS.id, SELECTION)).resolves.toBeTruthy();
    delete settings.location_types;
    await expect(f.service.validateActivation(SESSION, BUSINESS.id, SELECTION)).resolves.toBeTruthy();
  });

  it("blocks nonzero or malformed variation no-show fees despite a zero account cancellation fee", async () => {
    for (const no_show_fee of [{ amount: 2500, currency: "USD" }, { amount: -1, currency: "USD" }, { amount: "2500", currency: "USD" }, "invalid"]) {
      const f = fixture();
      f.data.objects = [item("HAIRCUT", { no_show_fee }), item("SUPPORTED")];
      const review = await f.service.review(SESSION, BUSINESS.id, "LOCATION");
      expect(review.services.find((service) => service.id === "HAIRCUT")?.supported).toBe(false);
      await expect(f.service.validateActivation(SESSION, BUSINESS.id, SELECTION)).rejects.toMatchObject({ code: "square_service_unavailable" });
    }
    const f = fixture();
    f.data.objects = [item("HAIRCUT", { no_show_fee: { amount: 0, currency: "USD" } })];
    await expect(f.service.validateActivation(SESSION, BUSINESS.id, SELECTION)).resolves.toBeTruthy();
  });

  it("shows unsupported services without enabling them and honors location pricing overrides", async () => {
    const f = fixture();
    f.data.objects = [item(), item("VARIABLE", { pricing_type: "VARIABLE_PRICING" }), item("FOREIGN", { price_money: { amount: 5000, currency: "CAD" } }),
      item("NO_STAFF", { team_member_ids: ["NOT_BOOKABLE"] }), item("SHORT", { service_duration: 1 }),
      item("OVERRIDE", { price_money: { amount: 5000, currency: "CAD" }, location_overrides: [{ location_id: "LOCATION", price_money: { amount: 7000, currency: "USD" }, pricing_type: "FIXED_PRICING" }] })];
    const review = await f.service.review(SESSION, BUSINESS.id, "LOCATION");
    expect(review.services.filter((service) => service.supported).map((service) => service.id)).toEqual(["HAIRCUT", "OVERRIDE"]);
    expect(review.services.find((service) => service.id === "OVERRIDE")?.priceMinor).toBe(7000);
    for (const id of ["VARIABLE", "FOREIGN", "NO_STAFF", "SHORT", "UNKNOWN"]) {
      await expect(f.service.validateActivation(SESSION, BUSINESS.id, { ...SELECTION, enabledServiceIds: [id] })).rejects.toMatchObject({ code: "square_service_unavailable" });
    }
  });

  it("rejects a service that becomes unavailable after review and hides offerings at other locations", async () => {
    const f = fixture();
    await f.service.review(SESSION, BUSINESS.id, "LOCATION");
    const elsewhere = item("ELSEWHERE");
    elsewhere.item_data.variations[0]!.present_at_location_ids = ["OTHER_LOCATION"];
    f.data.objects = [item("HAIRCUT", { available_for_booking: false }), elsewhere];
    const review = await f.service.review(SESSION, BUSINESS.id, "LOCATION");
    expect(review.services.map((service) => service.id)).toEqual(["HAIRCUT"]);
    expect(review.services[0]?.supported).toBe(false);
    await expect(f.service.validateActivation(SESSION, BUSINESS.id, SELECTION)).rejects.toMatchObject({ code: "square_activation_blocked" });
  });

  it("rejects incomplete, duplicate, or malformed service selections", async () => {
    const f = fixture();
    for (const enabledServiceIds of [[], ["HAIRCUT", "HAIRCUT"], ["../other"], Array.from({ length: 501 }, (_, index) => `SERVICE${index}`)]) {
      await expect(f.service.validateActivation(SESSION, BUSINESS.id, { ...SELECTION, enabledServiceIds })).rejects.toMatchObject({ code: "square_selection_invalid" });
    }
    expect(f.requests).toHaveLength(0);
  });

  it("cleans merchant-controlled display text while returning plain serializable review data", async () => {
    const f = fixture();
    const serviceItem = item();
    serviceItem.item_data.name = "<script>alert(1)</script>Haircut";
    f.data.objects = [serviceItem];
    const review = await f.service.review(SESSION, BUSINESS.id, "LOCATION");
    expect(JSON.parse(JSON.stringify(review))).toEqual(review);
    expect(review.services[0]!.name).not.toContain("<script>");
  });
});
