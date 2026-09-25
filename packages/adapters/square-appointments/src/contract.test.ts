import { describe, expect, it } from "vitest";
import { makeContext } from "@porter/adapter-contract";
import { PorterError, type HttpClient, type HttpRequest, type HttpResponse } from "@porter/shared";
import { createSquareAdapter } from "./index.js";
import { isPresentAtLocation, mapServiceVariation } from "./map.js";
import type { SquareCatalogObject } from "./api.js";
import { FakeSquare, SQUARE_TEST_TOKEN } from "./testing/fake-square.js";
import catalogFixture from "./fixtures/catalog.json" with { type: "json" };
import profileFixture from "./fixtures/business-booking-profile.json" with { type: "json" };

const context = () => makeContext({ credentials: { accessToken: SQUARE_TEST_TOKEN } });
const locationId = "L7GK3M2QWERTY";
const providerId = `square:${locationId}`;
const serviceId = `${providerId}:VAR_CUT_45`;
const startsAt = new Date("2026-10-02T16:00:00.000Z");

function bookingRequest(idempotencyKey = "contract-booking") {
  return {
    providerId,
    locationId: providerId,
    serviceId,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 45 * 60_000),
    providerSlotRef: "TM_ALEX",
    customer: { givenName: "Sam", email: "sam@example.com", phone: "+14155550100" },
    idempotencyKey,
  };
}

function response(body: unknown, status = 200): HttpResponse {
  return { status, headers: {}, body };
}

function build(intercept: (request: HttpRequest) => HttpResponse | undefined = () => undefined) {
  const fake = new FakeSquare();
  const http: HttpClient = { send: async (request) => intercept(request) ?? fake.send(request) };
  return { fake, adapter: createSquareAdapter({ http }) };
}

function hasCode(code: PorterError["code"]) {
  return (error: unknown) => PorterError.is(error) && error.code === code;
}

describe("Square documented booking requirements", () => {
  it("requires a phone before creating any customer or appointment", async () => {
    const { adapter, fake } = build();
    const request = bookingRequest();
    await expect(adapter.createBooking({ ...request, customer: { givenName: "Sam", email: "sam@example.com" } }, context()))
      .rejects.toSatisfy(hasCode("INVALID_REQUEST"));
    expect(adapter.capabilities.requiredCustomerFields).toContain("phone");
    expect(fake.customers.size).toBe(0);
    expect(fake.bookings.size).toBe(0);
  });

  it("does not reuse a same-email customer with a different phone", async () => {
    const { adapter, fake } = build();
    fake.customers.set("another-person", { id: "another-person", email_address: "sam@example.com", phone_number: "+14155550199" });
    const booking = await adapter.createBooking(bookingRequest(), context());
    expect(fake.bookings.get(booking.providerBookingRef)?.customer_id).not.toBe("another-person");
    expect(fake.customers.size).toBe(2);
  });

  it("stops after a customer lookup failure instead of creating a possible duplicate", async () => {
    const { adapter, fake } = build((request) => new URL(request.url).pathname === "/v2/customers/search"
      ? response({ errors: [{ code: "INTERNAL_SERVER_ERROR", category: "API_ERROR" }] }, 500)
      : undefined);
    await expect(adapter.createBooking(bookingRequest(), context())).rejects.toSatisfy(hasCode("ADAPTER_DOWN"));
    expect(fake.customers.size).toBe(0);
    expect(fake.bookings.size).toBe(0);
  });

  it("blocks a known cancellation fee before any customer write", async () => {
    const profile = structuredClone(profileFixture);
    profile.business_booking_profile.business_appointment_settings.cancellation_fee_money.amount = 2500;
    const { adapter, fake } = build((request) => new URL(request.url).pathname.endsWith("business-booking-profile")
      ? response(profile) : undefined);
    await expect(adapter.createBooking(bookingRequest(), context())).rejects.toSatisfy(hasCode("POLICY_BLOCKED"));
    expect(fake.customers.size).toBe(0);
    expect(fake.bookings.size).toBe(0);
  });

  it("preserves the selected availability's duration when it differs from the catalog", async () => {
    const { adapter, fake } = build();
    const booking = await adapter.createBooking({ ...bookingRequest(), endsAt: new Date(startsAt.getTime() + 30 * 60_000) }, context());
    expect(fake.bookings.get(booking.providerBookingRef)?.appointment_segments?.[0]?.duration_minutes).toBe(30);
    expect(booking.endsAt.getTime() - booking.startsAt.getTime()).toBe(30 * 60_000);
  });

  it("never fabricates success from an empty cancellation response", async () => {
    const { adapter } = build((request) => new URL(request.url).pathname.endsWith("/cancel") ? response({}) : undefined);
    const booking = await adapter.createBooking(bookingRequest(), context());
    await expect(adapter.cancelBooking({ providerId, bookingRef: booking.providerBookingRef, idempotencyKey: "cancel-empty" }, context()))
      .rejects.toSatisfy(hasCode("ADAPTER_DOWN"));
  });

  it("preserves the full idempotency key when two keys share a long prefix", async () => {
    const { adapter, fake } = build();
    const prefix = "k".repeat(192);
    const first = await adapter.createBooking(bookingRequest(`${prefix}-first`), context());
    const second = await adapter.createBooking({ ...bookingRequest(`${prefix}-second`), providerSlotRef: "TM_JO" }, context());
    expect(second.providerBookingRef).not.toBe(first.providerBookingRef);
    expect(fake.bookings.size).toBe(2);
  });

  it("rejects an oversized idempotency key without touching Square", async () => {
    const { adapter, fake } = build();
    await expect(adapter.createBooking(bookingRequest("k".repeat(256)), context())).rejects.toSatisfy(hasCode("INVALID_REQUEST"));
    expect(fake.requests).toHaveLength(0);
  });
});

describe("Square catalog contract", () => {
  const item = catalogFixture.objects.find((entry) => entry.id === "ITEM_CUT") as SquareCatalogObject;
  const variation = item.item_data!.variations![0]!;
  const map = (value: SquareCatalogObject, parent = item) => mapServiceVariation("square", locationId, parent, value, "Hair");

  it("uses both parent and variation location visibility", () => {
    expect(isPresentAtLocation({ type: "ITEM", id: "all" }, locationId)).toBe(true);
    expect(map(variation)).not.toBeNull();
    expect(map({ ...variation, present_at_location_ids: [] })).toBeNull();
    expect(map(variation, { ...item, absent_at_location_ids: [locationId] })).toBeNull();
    expect(map({ ...variation, present_at_all_locations: true, absent_at_location_ids: [locationId] })).toBeNull();
  });

  it("uses the location price and does not turn variable pricing into a fixed quote", () => {
    const override = { location_id: locationId, pricing_type: "FIXED_PRICING" as const, price_money: { amount: 8000, currency: "USD" } };
    expect(map({ ...variation, item_variation_data: { ...variation.item_variation_data, location_overrides: [override] } })?.service.price?.amount).toBe(8000);
    const variable = map({ ...variation, item_variation_data: {
      ...variation.item_variation_data,
      location_overrides: [{ location_id: locationId, pricing_type: "VARIABLE_PRICING" }],
    } });
    expect(variable?.service.price).toBeUndefined();
    expect(variable?.service.quoteRequired).toBe(true);
  });

  it("does not invent missing durations or expose deleted, archived or unbookable services", () => {
    expect(map({ ...variation, item_variation_data: { ...variation.item_variation_data, service_duration: undefined } })).toBeNull();
    expect(map({ ...variation, item_variation_data: { ...variation.item_variation_data, available_for_booking: undefined } })).toBeNull();
    expect(map({ ...variation, version: undefined })).toBeNull();
    expect(map({ ...variation, is_deleted: true })).toBeNull();
    expect(map(variation, { ...item, item_data: { ...item.item_data, is_archived: true } })).toBeNull();
  });

  it("reads subsequent catalog pages instead of silently dropping services", async () => {
    const cursors: (string | undefined)[] = [];
    const { adapter } = build((request) => {
      if (new URL(request.url).pathname !== "/v2/catalog/search") return undefined;
      const cursor = (request.body as { cursor?: string }).cursor;
      cursors.push(cursor);
      return response(cursor ? catalogFixture : { objects: [], cursor: "next-page" });
    });
    const results = await adapter.searchProviders({ categories: ["beauty.haircut"], limit: 1 }, context());
    expect(results[0]?.services[0]?.id).toBe(serviceId);
    expect(cursors).toEqual([undefined, "next-page"]);
  });

  it("refreshes catalog prices when checking a previously offered slot", async () => {
    let amount = 6500;
    const { adapter } = build((request) => {
      if (new URL(request.url).pathname !== "/v2/catalog/search") return undefined;
      return response({ objects: [{ ...item, item_data: { ...item.item_data, variations: [{
        ...variation, item_variation_data: { ...variation.item_variation_data, price_money: { amount, currency: "USD" } },
      }] } }] });
    });
    const first = await adapter.getAvailability({ providerId, serviceId, from: startsAt, to: new Date(startsAt.getTime() + 60_000), limit: 1 }, context());
    expect(first[0]?.price?.amount).toBe(6500);
    amount = 8000;
    const checked = await adapter.checkSlot({ providerId, serviceId, startsAt, providerSlotRef: "TM_ALEX" }, context());
    expect(checked?.price?.amount).toBe(8000);
  });
});

describe("Square merchant isolation", () => {
  it("does not serve one credential's cached booking policy to another credential", async () => {
    const adapter = createSquareAdapter({ http: { send: async (request) => {
      if (new URL(request.url).pathname === "/v2/bookings") return response({ bookings: [{
        id: "booking", start_at: startsAt.toISOString(), location_id: locationId,
      }] });
      const profile = structuredClone(profileFixture);
      profile.business_booking_profile.business_appointment_settings.cancellation_window_seconds =
        request.headers?.authorization === "Bearer merchant-one" ? 86_400 : 172_800;
      return response(profile);
    } } });
    const first = await adapter.listBookings({ limit: 1 }, makeContext({ credentials: { accessToken: "merchant-one" } }));
    const second = await adapter.listBookings({ limit: 1 }, makeContext({ credentials: { accessToken: "merchant-two" } }));
    expect(first[0]?.cancellationPolicy.freeUntil?.getTime()).toBe(startsAt.getTime() - 86_400_000);
    expect(second[0]?.cancellationPolicy.freeUntil?.getTime()).toBe(startsAt.getTime() - 172_800_000);
  });

  it("does not serve one credential's cached catalog to another credential", async () => {
    const firstFake = new FakeSquare({ accessToken: "merchant-one" });
    const secondFake = new FakeSquare({ accessToken: "merchant-two" });
    const adapter = createSquareAdapter({ http: { send: async (request) => {
      if (request.headers?.authorization === "Bearer merchant-one") return firstFake.send(request);
      if (new URL(request.url).pathname === "/v2/catalog/search") return response({ objects: [] });
      return secondFake.send(request);
    } } });
    const query = { providerId, serviceId, from: startsAt, to: new Date(startsAt.getTime() + 60_000), limit: 1 };
    const first = makeContext({ credentials: { accessToken: "merchant-one" } });
    const second = makeContext({ credentials: { accessToken: "merchant-two" } });
    expect(await adapter.getAvailability(query, first)).toHaveLength(1);
    await expect(adapter.getAvailability(query, second)).rejects.toSatisfy(hasCode("NOT_FOUND"));
  });

  it("does not accept a service ID from a different provider namespace", async () => {
    const { adapter, fake } = build();
    await expect(adapter.getAvailability({ providerId, serviceId: "square:other-location:VAR_CUT_45", from: startsAt, to: startsAt, limit: 1 }, context()))
      .rejects.toSatisfy(hasCode("NOT_FOUND"));
    expect(fake.requests).toHaveLength(0);
  });
});
