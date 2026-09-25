import { describe, expect, it, vi } from "vitest";
import { FakeSquare } from "@porter/adapter-square-appointments/testing";
import type { AdapterContext, CreateBookingRequest, SearchQuery, Slot } from "@porter/core";
import type { MerchantCredentials, PilotBusiness, PilotStore } from "@porter/db";
import { silentLogger, type HttpClient, type HttpRequest, type HttpResponse } from "@porter/shared";
import { createPilotSquareAdapter } from "./adapter.js";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const LOCATION = "L7GK3M2QWERTY";
const VARIATION = "VAR_CUT_45";
const NOW = new Date("2026-10-01T08:00:00Z");
const provider = (businessId: string) => `pilot-square:${businessId}`;
const service = (businessId: string, variation = VARIATION) => `${provider(businessId)}:${variation}`;
const ctx: AdapterContext = { actorId: "customer-a", credentials: { accessToken: "attacker-global-token" }, now: NOW, signal: new AbortController().signal, log: silentLogger };
const QUERY: SearchQuery = { categories: ["beauty.haircut"], limit: 10 };

function business(id: string, name: string): PilotBusiness {
  return { id, ownerId: `owner-${id}`, name, websiteUrl: "https://salon.example.com/", status: "active", selectedLocationId: LOCATION,
    profile: { enabledServiceIds: [VARIATION], policyReviewed: true, noPaymentObligations: true }, createdAt: NOW, updatedAt: NOW };
}
function credentials(businessId: string): MerchantCredentials {
  return { businessId, merchantId: `merchant-${businessId}`, environment: "sandbox", status: "connected", version: 1, accessToken: `token-${businessId}`, refreshToken: "refresh", scopes: [],
    expiresAt: new Date("2027-01-01T00:00:00Z"), createdAt: NOW, updatedAt: NOW, refreshedAt: NOW };
}
function harness(transform?: (response: HttpResponse, request: HttpRequest) => HttpResponse) {
  const businesses = new Map([[A, business(A, "Juniper Salon")], [B, business(B, "Magnolia Spa")]]);
  const grants = new Map([[A, credentials(A)], [B, credentials(B)]]);
  const upstream = new Map([[A, new FakeSquare({ accessToken: `token-${A}` })], [B, new FakeSquare({ accessToken: `token-${B}` })]]);
  const requests: HttpRequest[] = [];
  const http: HttpClient = { async send(request) {
    requests.push(request);
    const entry = [...grants].find(([, value]) => request.headers?.authorization === `Bearer ${value.accessToken}`);
    if (!entry) throw new Error("Unexpected credential routing");
    const response = await upstream.get(entry[0])!.send(request);
    return transform?.(response, request) ?? response;
  } };
  const store = { businesses: { getById: vi.fn(async (id: string) => businesses.get(id) ?? null), listActive: vi.fn(async () => [...businesses.values()].filter((b) => b.status === "active")) } } as unknown as PilotStore;
  const connections = { credentials: vi.fn(async (id: string) => { const value = grants.get(id); if (!value) throw new Error("disconnected"); return value; }) };
  const adapter = createPilotSquareAdapter({ store, connections, environment: "sandbox", http });
  return { businesses, grants, upstream, requests, store, connections, adapter };
}
async function slots(h: ReturnType<typeof harness>, businessId = A): Promise<Slot[]> {
  return h.adapter.getAvailability({ providerId: provider(businessId), serviceId: service(businessId), from: new Date("2026-10-02T10:00:00Z"), to: new Date("2026-10-03T10:00:00Z"), limit: 10 }, ctx);
}
function bookingRequest(slot: Slot, key = "test-booking"): CreateBookingRequest {
  return { ...slot, customer: { givenName: "Porter", phone: "+14155550101" }, idempotencyKey: key };
}

describe("merchant-aware pilot Square adapter", () => {
  it("namespaces identical merchant location and service IDs and ignores caller credentials", async () => {
    const h = harness(); const found = await h.adapter.searchProviders(QUERY, ctx);
    expect(found.map((result) => result.provider.id)).toEqual([provider(A), provider(B)]);
    expect(found.map((result) => result.provider.name)).toEqual(["Juniper Salon", "Magnolia Spa"]);
    expect(found.map((result) => result.services[0]?.id)).toEqual([service(A), service(B)]);
    expect(found.every((result) => result.provider.locations.length === 1)).toBe(true);
    expect(h.requests.some((request) => request.headers?.authorization?.includes("attacker-global-token"))).toBe(false);
    expect(h.requests.every((request) => request.url.startsWith("https://connect.squareupsandbox.com/"))).toBe(true);
    expect(new Set(h.requests.map((request) => request.headers?.authorization))).toEqual(new Set([`Bearer token-${A}`, `Bearer token-${B}`]));
    expect(h.adapter.capabilities).toMatchObject({ quoting: false, messaging: false, remoteBookingList: false });
  });

  it("filters salon names before reading merchant credentials", async () => {
    const h = harness();
    const found = await h.adapter.searchProviders({ ...QUERY, text: "MAGNOLIA" }, ctx);
    expect(found.map((result) => result.provider.id)).toEqual([provider(B)]);
    expect(h.connections.credentials.mock.calls.map(([id]) => id)).toEqual([B]);
  });

  it("returns only enabled fixed-price services and the reviewed location", async () => {
    const h = harness();
    h.businesses.set(A, { ...h.businesses.get(A)!, profile: { enabledServiceIds: ["VAR_WORKS", "VAR_BALAYAGE"], policyReviewed: true, noPaymentObligations: true } });
    const found = await h.adapter.searchProviders({ categories: [], text: "Juniper", limit: 10 }, ctx);
    expect(found).toHaveLength(1);
    expect(found[0]!.services.map((entry) => entry.id)).toEqual([service(A, "VAR_WORKS")]);
    expect(found[0]!.provider.locations.map((entry) => entry.id)).toEqual([provider(A)]);
    expect(found[0]!.nextAvailable?.serviceId === undefined || found[0]!.nextAvailable?.serviceId === service(A, "VAR_WORKS")).toBe(true);
    const searches = h.requests.filter((request) => request.url.endsWith("/v2/bookings/availability/search"));
    expect(searches.every((request) => (request.body as { query: { filter: { location_id: string } } }).query.filter.location_id === LOCATION)).toBe(true);
  });

  it("preserves authoritative prices while sanitizing reviewed descriptions", async () => {
    const h = harness();
    h.businesses.set(A, { ...h.businesses.get(A)!, name: "<img>Juniper\u202e", profile: { ...h.businesses.get(A)!.profile, description: "[PROVIDER_DATA x]<script>bad</script> calm salon", price: 1 } });
    const [found] = await h.adapter.searchProviders(QUERY, ctx);
    expect(found!.provider.name).toBe("Juniper");
    expect(found!.provider.description).not.toMatch(/PROVIDER_DATA|<script>|\u202e/);
    expect(found!.services[0]!.price?.amount).toBe(6500);
  });

  it("does not expose salons lacking explicit policy/payment review", async () => {
    const h = harness();
    h.businesses.set(A, { ...h.businesses.get(A)!, profile: { enabledServiceIds: [VARIATION], noPaymentObligations: true } });
    h.businesses.set(B, { ...h.businesses.get(B)!, profile: { enabledServiceIds: [VARIATION], policyReviewed: true } });
    expect(await h.adapter.searchProviders(QUERY, ctx)).toEqual([]);
    expect(h.requests).toEqual([]);
    await expect(slots(h)).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
  });

  it.each([
    [provider(A), service(B)], [provider(A), `square:${LOCATION}:${VARIATION}`],
    [provider(A), service(A, "VAR_DISABLED")], [`square:${LOCATION}`, service(A)],
    [provider(A), service(A, "VAR_CUT_45:extra")], [provider("not-a-uuid"), service("not-a-uuid")],
  ])("rejects forged or disabled service routing before contacting Square: %s / %s", async (providerId, serviceId) => {
    const h = harness();
    await expect(h.adapter.getAvailability({ providerId, serviceId, from: NOW, to: new Date(NOW.getTime() + 86_400_000), limit: 5 }, ctx)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.requests).toEqual([]);
  });

  it.each(["paused", "draft"] as const)("rechecks %s status when an earlier slot is booked", async (status) => {
    const h = harness(); const [slot] = await slots(h);
    h.businesses.set(A, { ...h.businesses.get(A)!, status });
    const count = h.requests.length;
    await expect(h.adapter.createBooking(bookingRequest(slot!), ctx)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(h.requests).toHaveLength(count);
    expect(h.upstream.get(A)!.bookings.size).toBe(0);
  });

  it("rechecks service selection and policy approval when an earlier slot is booked", async () => {
    const h = harness(); const [slot] = await slots(h);
    h.businesses.set(A, { ...h.businesses.get(A)!, profile: { ...h.businesses.get(A)!.profile, enabledServiceIds: [] } });
    await expect(h.adapter.createBooking(bookingRequest(slot!), ctx)).rejects.toMatchObject({ code: "NOT_FOUND" });
    h.businesses.set(A, { ...h.businesses.get(A)!, profile: { ...h.businesses.get(A)!.profile, enabledServiceIds: [VARIATION], noPaymentObligations: false } });
    await expect(h.adapter.createBooking(bookingRequest(slot!), ctx)).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
    expect(h.upstream.get(A)!.bookings.size).toBe(0);
  });

  it.each(["disconnected", "disconnecting", "reconnect_required"] as const)("blocks %s credentials", async (status) => {
    const h = harness(); h.grants.set(A, { ...h.grants.get(A)!, status });
    await expect(slots(h)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(h.requests).toEqual([]);
  });

  it("rejects credentials for another business, environment or an expired grant", async () => {
    for (const change of [{ businessId: B }, { environment: "production" as const }, { expiresAt: NOW }]) {
      const h = harness(); h.grants.set(A, { ...h.grants.get(A)!, ...change });
      await expect(slots(h)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
      expect(h.requests).toEqual([]);
    }
  });

  it("creates distinct public booking refs when upstream refs collide and manages paused appointments", async () => {
    const h = harness();
    const [slotA] = await slots(h, A); const [slotB] = await slots(h, B);
    const bookedA = await h.adapter.createBooking(bookingRequest(slotA!, "a-create"), ctx);
    const bookedB = await h.adapter.createBooking(bookingRequest(slotB!, "b-create"), ctx);
    expect(bookedA.providerBookingRef.split(":")[1]).toBe(bookedB.providerBookingRef.split(":")[1]);
    expect(bookedA.providerBookingRef).not.toBe(bookedB.providerBookingRef);
    expect(bookedA).toMatchObject({ adapterId: "pilot-square", providerId: provider(A), locationId: provider(A), serviceId: service(A) });
    h.businesses.set(A, { ...h.businesses.get(A)!, status: "paused", profile: {} });
    expect(await h.adapter.getCancellationPolicy(bookedA.providerBookingRef, ctx)).toMatchObject({ known: true });
    const moved = await h.adapter.rescheduleBooking({ bookingRef: bookedA.providerBookingRef, providerId: provider(A), serviceId: service(A), startsAt: new Date("2026-10-03T10:00:00Z"), endsAt: new Date("2026-10-03T10:45:00Z"), providerSlotRef: slotA!.providerSlotRef, idempotencyKey: "a-move" }, ctx);
    expect(moved.providerBookingRef).toBe(bookedA.providerBookingRef);
    const cancelled = await h.adapter.cancelBooking({ providerId: provider(A), bookingRef: bookedA.providerBookingRef, idempotencyKey: "a-cancel" }, ctx);
    expect(cancelled.status).toBe("cancelled");
    expect([...h.upstream.get(B)!.bookings.values()][0]!.status).toBe("ACCEPTED");
    await expect(h.adapter.checkSlot({ providerId: provider(A), serviceId: service(A), startsAt: slotA!.startsAt, providerSlotRef: slotA!.providerSlotRef }, ctx)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("rejects another business's booking reference before reading its credentials", async () => {
    const h = harness();
    await expect(h.adapter.cancelBooking({ providerId: provider(A), bookingRef: `${B}:SQBK1`, idempotencyKey: "cancel" }, ctx)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(h.adapter.rescheduleBooking({ providerId: provider(A), serviceId: service(A), bookingRef: `${B}:SQBK1`, startsAt: NOW, endsAt: new Date(NOW.getTime() + 60_000), idempotencyKey: "move" }, ctx)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(h.adapter.getCancellationPolicy(`${A}:SQBK1:extra`, ctx)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.connections.credentials).not.toHaveBeenCalled();
  });

  it("rejects a policy lookup for a booking at an unselected merchant location", async () => {
    const h = harness();
    h.upstream.get(A)!.bookings.set("SQBK_FOREIGN", { id: "SQBK_FOREIGN", version: 1, status: "ACCEPTED", location_id: "LQ9XBARBER01", start_at: NOW.toISOString() });
    await expect(h.adapter.getCancellationPolicy(`${A}:SQBK_FOREIGN`, ctx)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.requests.some((request) => request.url.includes("business-booking-profile"))).toBe(false);
  });

  it("fails closed on upstream booking identity mismatch", async () => {
    const h = harness((response, request) => {
      if (request.url.endsWith("/v2/bookings") && request.method === "POST" && response.status === 200) {
        const body = response.body as { booking: Record<string, unknown> };
        return { ...response, body: { booking: { ...body.booking, location_id: "OTHER_LOCATION" } } };
      }
      return response;
    });
    const [slot] = await slots(h);
    await expect(h.adapter.createBooking(bookingRequest(slot!), ctx)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Upstream write really happened: engine must retain its uncertain operation.
    expect(h.upstream.get(A)!.bookings.size).toBe(1);
  });

  it("continues discovery when a different merchant is disconnected", async () => {
    const h = harness(); h.grants.delete(A);
    const found = await h.adapter.searchProviders(QUERY, ctx);
    expect(found.map((entry) => entry.provider.id)).toEqual([provider(B)]);
  });

  it.each([-1, "500", null, 0.5])("does not mistake an invalid fee %s for a free policy", async (fee) => {
    let corrupt = false;
    const h = harness((response, request) => {
      if (!corrupt || !request.url.endsWith("/v2/bookings/business-booking-profile")) return response;
      const body = structuredClone(response.body) as { business_booking_profile: { business_appointment_settings: { cancellation_fee_money: { amount: unknown } } } };
      body.business_booking_profile.business_appointment_settings.cancellation_fee_money.amount = fee;
      return { ...response, body };
    });
    const [slot] = await slots(h);
    const created = await h.adapter.createBooking(bookingRequest(slot!), ctx);
    corrupt = true;
    await expect(h.adapter.getCancellationPolicy(created.providerBookingRef, ctx)).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
    await expect(h.adapter.cancelBooking({ providerId: provider(A), bookingRef: created.providerBookingRef, idempotencyKey: "cancel" }, ctx)).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
    expect(h.requests.some((request) => request.method === "POST" && request.url.endsWith("/cancel"))).toBe(false);
  });

  it.each([{ amount: 2500, currency: "USD" }, { amount: -1 }, { amount: "2500" }, { amount: 0.5 }, null, "invalid"])("rechecks variation no-show fee before writing an earlier slot: %j", async (fee) => {
    let changed = false;
    const h = harness((response, request) => changed ? withVariationFee(response, request, fee) : response);
    const [slot] = await slots(h);
    changed = true;
    await expect(h.adapter.createBooking(bookingRequest(slot!), ctx)).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
    await expect(slots(h)).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
    expect(h.requests.some((request) => request.method === "POST" && /\/v2\/(?:bookings|customers)$/.test(new URL(request.url).pathname))).toBe(false);
    expect(h.upstream.get(A)!.bookings.size).toBe(0);
  });

  it("filters fee-bearing variations without hiding other eligible services", async () => {
    const h = harness((response, request) => withVariationFee(response, request, { amount: 2500, currency: "USD" }));
    h.businesses.set(A, { ...h.businesses.get(A)!, profile: { ...h.businesses.get(A)!.profile, enabledServiceIds: [VARIATION, "VAR_WORKS"] } });
    const found = await h.adapter.searchProviders({ categories: [], text: "Juniper", limit: 10 }, ctx);
    expect(found).toHaveLength(1);
    expect(found[0]!.services.map((entry) => entry.id)).toEqual([service(A, "VAR_WORKS")]);
  });

  it.each([undefined, { currency: "USD" }, { amount: 0, currency: "USD" }])("allows owner-attested missing or zero variation fee: %j", async (fee) => {
    const h = harness((response, request) => withVariationFee(response, request, fee));
    const [slot] = await slots(h);
    expect(await h.adapter.createBooking(bookingRequest(slot!), ctx)).toMatchObject({ status: "confirmed" });
  });

  it("rejects a newly added variation fee in reschedule preflight before updating Square", async () => {
    let changed = false;
    const h = harness((response, request) => changed ? withVariationFee(response, request, { amount: 500, currency: "USD" }) : response);
    const [slot] = await slots(h);
    const booked = await h.adapter.createBooking(bookingRequest(slot!), ctx);
    changed = true;
    const request = { ...slot!, bookingRef: booked.providerBookingRef, startsAt: new Date("2026-10-03T10:00:00Z"), endsAt: new Date("2026-10-03T10:45:00Z") };
    await expect(h.adapter.validateReschedule!(request, ctx)).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
    await expect(h.adapter.rescheduleBooking({ ...request, idempotencyKey: "move" }, ctx)).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
    expect(h.requests.some((request) => request.method === "PUT")).toBe(false);
  });

  it.each([{ amount: 500, currency: "USD" }, { amount: -1 }, { amount: "500" }, null, "invalid"])("blocks cancellation for a live booked-service fee: %j", async (fee) => {
    let changed = false;
    const h = harness((response, request) => changed ? withVariationFee(response, request, fee) : response);
    const [slot] = await slots(h);
    const booked = await h.adapter.createBooking(bookingRequest(slot!), ctx);
    changed = true;
    await expect(h.adapter.validateCancellation({ providerId: provider(A), serviceId: service(A), bookingRef: booked.providerBookingRef }, ctx)).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
    await expect(h.adapter.getCancellationPolicy(booked.providerBookingRef, ctx)).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
    await expect(h.adapter.cancelBooking({ providerId: provider(A), bookingRef: booked.providerBookingRef, idempotencyKey: "cancel" }, ctx)).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
    expect(h.requests.some((request) => request.method === "POST" && request.url.endsWith("/cancel"))).toBe(false);
  });

  it("checks archived and disabled booked-service fees through every catalog page", async () => {
    let changed = false;
    const h = harness((response, request) => {
      if (!changed || !request.url.endsWith("/v2/catalog/search")) return response;
      if (!(request.body as { cursor?: string }).cursor) return { ...response, body: { objects: [], cursor: "next" } };
      const modified = withVariationFee(response, request, { amount: 500, currency: "USD" });
      const body = modified.body as { objects: Array<{ item_data?: { is_archived?: boolean; variations?: Array<{ item_variation_data: { available_for_booking?: boolean } }> } }> };
      for (const item of body.objects) {
        if (!item.item_data) continue;
        item.item_data.is_archived = true;
        for (const variation of item.item_data.variations ?? []) variation.item_variation_data.available_for_booking = false;
      }
      return modified;
    });
    const [slot] = await slots(h);
    const booked = await h.adapter.createBooking(bookingRequest(slot!), ctx);
    h.businesses.set(A, { ...h.businesses.get(A)!, status: "paused", profile: {} });
    changed = true;
    await expect(h.adapter.validateCancellation({ providerId: provider(A), serviceId: service(A), bookingRef: booked.providerBookingRef }, ctx)).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
    expect(h.requests.some((request) => (request.body as { cursor?: string } | undefined)?.cursor === "next")).toBe(true);
  });

  it.each([{ objects: [] }, { objects: "invalid" }, { objects: [], cursor: "loop" }])("fails cancellation preflight closed when the booked fee cannot be verified: %j", async (body) => {
    let changed = false;
    const h = harness((response, request) => changed && request.url.endsWith("/v2/catalog/search") ? { ...response, body } : response);
    const [slot] = await slots(h);
    const booked = await h.adapter.createBooking(bookingRequest(slot!), ctx);
    changed = true;
    await expect(h.adapter.validateCancellation({ providerId: provider(A), serviceId: service(A), bookingRef: booked.providerBookingRef }, ctx)).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
    expect(h.requests.some((request) => request.method === "POST" && request.url.endsWith("/cancel"))).toBe(false);
  });

  it("compares the expected booking state again after its final service fee read", async () => {
    let changeDuringRead = false;
    const h = harness((response, request) => {
      if (changeDuringRead && request.url.endsWith("/v2/catalog/search")) h.upstream.get(A)!.bookings.values().next().value!.version++;
      return response;
    });
    const [slot] = await slots(h);
    const booked = await h.adapter.createBooking(bookingRequest(slot!), ctx);
    const validation = await h.adapter.validateCancellation({ providerId: provider(A), serviceId: service(A), bookingRef: booked.providerBookingRef }, ctx);
    changeDuringRead = true;
    await expect(h.adapter.cancelBooking({ providerId: provider(A), bookingRef: booked.providerBookingRef, idempotencyKey: "cancel", expectedBookingState: validation.bookingState }, ctx)).rejects.toMatchObject({ code: "CONFIRMATION_STALE" });
    expect(h.requests.some((request) => request.method === "POST" && request.url.endsWith("/cancel"))).toBe(false);
  });

  it.each([["CUSTOMER_LOCATION"], ["PHONE"], [], "BUSINESS_LOCATION", null])("rejects a changed unsupported location type before creating or moving: %j", async (locationTypes) => {
    let changed = false;
    const h = harness((response, request) => {
      if (!changed || !request.url.endsWith("/v2/bookings/business-booking-profile")) return response;
      const body = structuredClone(response.body) as { business_booking_profile: { business_appointment_settings: Record<string, unknown> } };
      body.business_booking_profile.business_appointment_settings.location_types = locationTypes;
      return { ...response, body };
    });
    const [slot] = await slots(h);
    const booked = await h.adapter.createBooking(bookingRequest(slot!), ctx);
    const next = (await slots(h)).find((entry) => entry.providerSlotRef === slot!.providerSlotRef);
    changed = true;
    const before = h.requests.length;
    await expect(h.adapter.createBooking(bookingRequest(slot!, "second"), ctx)).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
    await expect(h.adapter.validateReschedule!({ ...next!, bookingRef: booked.providerBookingRef }, ctx)).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
    expect(h.requests.slice(before).some((request) => request.method === "PUT" || new URL(request.url).pathname === "/v2/bookings")).toBe(false);
    expect(await h.adapter.cancelBooking({ providerId: provider(A), bookingRef: booked.providerBookingRef, idempotencyKey: "cancel" }, ctx)).toMatchObject({ status: "cancelled" });
  });
});

function withVariationFee(response: HttpResponse, request: HttpRequest, fee: unknown): HttpResponse {
  if (!request.url.endsWith("/v2/catalog/search")) return response;
  const body = structuredClone(response.body) as { objects?: Array<{ item_data?: { variations?: Array<{ id: string; item_variation_data: Record<string, unknown> }> } }> };
  for (const item of body.objects ?? []) {
    for (const variation of item.item_data?.variations ?? []) {
      if (variation.id === VARIATION) variation.item_variation_data.no_show_fee = fee;
    }
  }
  return { ...response, body };
}
