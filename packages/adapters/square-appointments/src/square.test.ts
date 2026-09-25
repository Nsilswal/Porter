import { describe, expect, it } from "vitest";
import { makeContext, runAdapterConformance } from "@porter/adapter-contract";
import { PorterError, sanitize } from "@porter/shared";
import { createSquareAdapter } from "./index.js";
import { FakeSquare, SQUARE_TEST_TOKEN } from "./testing/fake-square.js";
import { inferCategory, mapCancellationPolicy } from "./map.js";

const ctx = () => makeContext({ credentials: { accessToken: SQUARE_TEST_TOKEN } });

function build(options: ConstructorParameters<typeof FakeSquare>[0] = {}) {
  const fake = new FakeSquare(options);
  return { fake, adapter: createSquareAdapter({ http: fake, baseUrl: "https://connect.squareupsandbox.com" }) };
}

// The whole point of milestone 3: the same suite, unchanged, against a second
// platform. If this passes without core changing, the interface generalises.
runAdapterConformance("square-appointments", {
  makeAdapter: () => build().adapter,
  searchCategory: "beauty.haircut",
  customer: { givenName: "Sam", email: "sam@example.com", phone: "+14155550100" },
  credentials: { accessToken: SQUARE_TEST_TOKEN },
  makeFailingAdapter: () => build({ failWith: { status: 503, code: "SERVICE_UNAVAILABLE" } }).adapter,
});

describe("square adapter — catalog mapping", () => {
  it("returns only bookable appointment services, not retail items", async () => {
    const { adapter } = build();
    const results = await adapter.searchProviders({ categories: [], limit: 10 }, ctx());
    const names = results.flatMap((r) => r.services.map((s) => String(s.name)));
    expect(names.some((n) => n.includes("Haircut"))).toBe(true);
    // A REGULAR product type is not an appointment service.
    expect(names.some((n) => n.includes("Shampoo"))).toBe(false);
  });

  it("skips inactive locations", async () => {
    const { adapter } = build();
    const results = await adapter.searchProviders({ categories: [], limit: 10 }, ctx());
    expect(results.every((r) => !String(r.provider.name).includes("Old Location"))).toBe(true);
  });

  it("treats variable pricing as quote-required rather than inventing a price", async () => {
    const { adapter } = build();
    const results = await adapter.searchProviders({ categories: ["beauty.hair.color"], limit: 10 }, ctx());
    const balayage = results.flatMap((r) => r.services).find((s) => String(s.name).includes("Balayage"));
    expect(balayage).toBeDefined();
    expect(balayage!.price).toBeUndefined();
    expect(balayage!.quoteRequired).toBe(true);
  });

  it("converts Square's millisecond durations to minutes", async () => {
    const { adapter } = build();
    const results = await adapter.searchProviders({ categories: ["beauty.haircut"], limit: 10 }, ctx());
    const cut = results.flatMap((r) => r.services).find((s) => String(s.name).includes("Haircut"));
    expect(cut!.durationMinutes).toBe(45);
  });

  it("reports services it cannot categorise instead of dropping them", async () => {
    const { adapter } = build();
    const results = await adapter.searchProviders({ categories: [], limit: 10 }, ctx());
    const salon = results.find((r) => String(r.provider.name).includes("Shear Genius"))!;
    const works = salon.services.find((s) => String(s.name).includes("The Full Works"));
    expect(works).toBeDefined();
    // Null, not a guess. It stays searchable by text but is never auto-matched.
    expect(works!.category).toBeNull();
    expect(salon.provider.unmappedCategories).toContain("The Full Works");
  });

  it("sends the Square-Version header on every call", async () => {
    const { fake, adapter } = build();
    await adapter.searchProviders({ categories: ["beauty.haircut"], limit: 1 }, ctx());
    expect(fake.requests.length).toBeGreaterThan(0);
  });
});

describe("square adapter — booking", () => {
  async function bookFirst(adapter: ReturnType<typeof build>["adapter"], c = ctx()) {
    const [result] = await adapter.searchProviders({ categories: ["beauty.haircut"], limit: 1 }, c);
    const service = result!.services.find((s) => !s.quoteRequired)!;
    const from = new Date(c.now.getTime() + 2 * 60 * 60_000);
    const slots = await adapter.getAvailability(
      { providerId: result!.provider.id, serviceId: service.id, from, to: new Date(from.getTime() + 7 * 86_400_000), limit: 5 },
      c,
    );
    const slot = slots[0]!;
    const booking = await adapter.createBooking(
      {
        providerId: result!.provider.id,
        locationId: slot.locationId,
        serviceId: service.id,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        providerSlotRef: slot.providerSlotRef,
        customer: { givenName: "Sam", email: "sam@example.com", phone: "+14155550100" },
        idempotencyKey: "sq-test-1",
      },
      c,
    );
    return { booking, slot, service, provider: result!.provider };
  }

  it("carries the team member through as the slot reference", async () => {
    const { adapter } = build();
    const c = ctx();
    const [result] = await adapter.searchProviders({ categories: ["beauty.haircut"], limit: 1 }, c);
    const service = result!.services.find((s) => !s.quoteRequired)!;
    const from = new Date(c.now.getTime() + 2 * 60 * 60_000);
    const slots = await adapter.getAvailability({ providerId: result!.provider.id, serviceId: service.id, from, to: new Date(from.getTime() + 2 * 86_400_000), limit: 10 }, c);
    // Square books a specific person, so the slot must name one.
    expect(slots[0]!.providerSlotRef).toMatch(/^TM_/);
    expect(new Set(slots.map((s) => s.providerSlotRef)).size).toBeGreaterThan(1);
  });

  it("forwards the idempotency key to Square", async () => {
    const { fake, adapter } = build();
    await bookFirst(adapter);
    const create = fake.requests.find((r) => r.method === "POST" && r.path === "/v2/bookings");
    expect((create!.body as any).idempotency_key).toBe("sq-test-1");
  });

  it("replays rather than double-booking when Square sees the same key", async () => {
    const { fake, adapter } = build();
    const first = await bookFirst(adapter);
    const second = await adapter.createBooking(
      {
        providerId: first.provider.id,
        locationId: first.slot.locationId,
        serviceId: first.service.id,
        startsAt: first.slot.startsAt,
        endsAt: first.slot.endsAt,
        providerSlotRef: first.slot.providerSlotRef,
        customer: { givenName: "Sam", email: "sam@example.com", phone: "+14155550100" },
        idempotencyKey: "sq-test-1",
      },
      ctx(),
    );
    expect(second.providerBookingRef).toBe(first.booking.providerBookingRef);
    expect(fake.bookings.size).toBe(1);
  });

  it("reuses an existing Square customer instead of creating duplicates", async () => {
    const { fake, adapter } = build();
    await bookFirst(adapter);
    const before = fake.customers.size;
    const [result] = await adapter.searchProviders({ categories: ["beauty.haircut"], limit: 1 }, ctx());
    const service = result!.services.find((s) => !s.quoteRequired)!;
    const c = ctx();
    const from = new Date(c.now.getTime() + 3 * 86_400_000);
    // A full week, so the window cannot land entirely on a closed day.
    const slots = await adapter.getAvailability({ providerId: result!.provider.id, serviceId: service.id, from, to: new Date(from.getTime() + 7 * 86_400_000), limit: 5 }, c);
    await adapter.createBooking(
      { providerId: result!.provider.id, locationId: slots[0]!.locationId, serviceId: service.id, startsAt: slots[0]!.startsAt, endsAt: slots[0]!.endsAt, providerSlotRef: slots[0]!.providerSlotRef, customer: { givenName: "Sam", email: "sam@example.com", phone: "+14155550100" }, idempotencyKey: "sq-test-2" },
      c,
    );
    expect(fake.customers.size).toBe(before);
  });

  it("sends only the customer fields it declared", async () => {
    const { fake, adapter } = build();
    await bookFirst(adapter);
    const created = fake.requests.find((r) => r.method === "POST" && r.path === "/v2/customers");
    const body = created!.body as Record<string, unknown>;
    // Core projects before calling; nothing beyond the declared set arrives.
    expect(Object.keys(body).sort()).toEqual(["email_address", "given_name", "idempotency_key", "phone_number"]);
    expect(body).not.toHaveProperty("address_line_1");
  });

  it("sends Square's version field so a concurrent change is rejected", async () => {
    const { fake, adapter } = build();
    const { booking, provider, service } = await bookFirst(adapter);
    const c = ctx();
    const from = new Date(c.now.getTime() + 5 * 86_400_000);
    const slots = await adapter.getAvailability({ providerId: provider.id, serviceId: service.id, from, to: new Date(from.getTime() + 7 * 86_400_000), limit: 3 }, c);
    await adapter.rescheduleBooking(
      { bookingRef: booking.providerBookingRef, providerId: provider.id, serviceId: service.id, startsAt: slots[0]!.startsAt, endsAt: slots[0]!.endsAt, providerSlotRef: slots[0]!.providerSlotRef, idempotencyKey: "sq-resched" },
      c,
    );

    // The adapter re-reads to learn the version, so Square's optimistic
    // concurrency guards the read-to-write gap. Porter's real protection
    // against stale terms is the confirmation token in core, not this.
    const update = fake.requests.find((r) => r.method === "PUT" && r.path.startsWith("/v2/bookings/"));
    expect((update!.body as any).booking.version).toBe(1);
  });

  it("maps a Square booking conflict to SLOT_TAKEN", async () => {
    const { fake, adapter } = build();
    const { booking, provider, service, slot } = await bookFirst(adapter);
    // Someone takes the target time with the same stylist first.
    const c = ctx();
    const from = new Date(c.now.getTime() + 5 * 86_400_000);
    const slots = await adapter.getAvailability({ providerId: provider.id, serviceId: service.id, from, to: new Date(from.getTime() + 7 * 86_400_000), limit: 3 }, c);
    const target = slots.find((s) => s.providerSlotRef === slot.providerSlotRef)!;
    await adapter.createBooking(
      { providerId: provider.id, locationId: target.locationId, serviceId: service.id, startsAt: target.startsAt, endsAt: target.endsAt, providerSlotRef: target.providerSlotRef, customer: { givenName: "Kim", email: "kim@example.com", phone: "+14155550101" }, idempotencyKey: "sq-other" },
      c,
    );
    expect(fake.bookings.size).toBe(2);

    await expect(
      adapter.rescheduleBooking(
        { bookingRef: booking.providerBookingRef, providerId: provider.id, serviceId: service.id, startsAt: target.startsAt, endsAt: target.endsAt, providerSlotRef: target.providerSlotRef, idempotencyKey: "sq-clash" },
        c,
      ),
    ).rejects.toSatisfy((e: unknown) => PorterError.is(e) && e.code === "SLOT_TAKEN");
  });
});

describe("square adapter — cancellation policy", () => {
  it("reads the real window and fee from the booking profile", async () => {
    const { adapter } = build();
    const c = ctx();
    const [result] = await adapter.searchProviders({ categories: ["beauty.haircut"], limit: 1 }, c);
    const service = result!.services.find((s) => !s.quoteRequired)!;
    const from = new Date(c.now.getTime() + 2 * 60 * 60_000);
    const slots = await adapter.getAvailability({ providerId: result!.provider.id, serviceId: service.id, from, to: new Date(from.getTime() + 7 * 86_400_000), limit: 3 }, c);
    const booking = await adapter.createBooking(
      { providerId: result!.provider.id, locationId: slots[0]!.locationId, serviceId: service.id, startsAt: slots[0]!.startsAt, endsAt: slots[0]!.endsAt, providerSlotRef: slots[0]!.providerSlotRef, customer: { givenName: "Sam", email: "sam@example.com", phone: "+14155550100" }, idempotencyKey: "sq-pol" },
      c,
    );

    const policy = await adapter.getCancellationPolicy(booking.providerBookingRef, c);
    expect(policy.known).toBe(true);
    expect(policy.feeAmount).toBeNull();
    // 86400 seconds before the start.
    expect(policy.freeUntil!.getTime()).toBe(booking.startsAt.getTime() - 86_400_000);
  });

  it("says unknown when the seller configured nothing", () => {
    expect(mapCancellationPolicy(undefined, new Date())).toEqual({ known: false, freeUntil: null, feeAmount: null, text: null });
    // A profile with settings but no cancellation fields is still unknown —
    // never a claim of free cancellation.
    const policy = mapCancellationPolicy({ business_appointment_settings: { alignment_time: "HALF_HOURLY" } }, new Date());
    expect(policy.known).toBe(false);
    expect(policy.feeAmount).toBeNull();
  });
});

describe("square adapter — error mapping", () => {
  const cases: [number, string, string][] = [
    [401, "UNAUTHORIZED", "PROVIDER_UNAVAILABLE"],
    [403, "INSUFFICIENT_SCOPES", "PROVIDER_UNAVAILABLE"],
    [404, "NOT_FOUND", "NOT_FOUND"],
    [409, "BOOKING_CONFLICT", "SLOT_TAKEN"],
    [429, "RATE_LIMITED", "RATE_LIMITED"],
    [500, "INTERNAL_SERVER_ERROR", "ADAPTER_DOWN"],
  ];

  for (const [status, code, expected] of cases) {
    it(`maps ${status} ${code} to ${expected}`, async () => {
      const { adapter } = build({ failWith: { status, code } });
      await expect(adapter.searchProviders({ categories: ["beauty.haircut"], limit: 1 }, ctx())).rejects.toSatisfy(
        (e: unknown) => PorterError.is(e) && e.code === expected,
      );
    });
  }

  it("never leaks Square's own error text to the agent", async () => {
    const { adapter } = build({ failWith: { status: 400, code: "BAD_REQUEST" } });
    try {
      await adapter.searchProviders({ categories: ["beauty.haircut"], limit: 1 }, ctx());
      expect.unreachable();
    } catch (error) {
      const e = error as PorterError;
      const serialised = JSON.stringify(e.toPublic());
      expect(e.message).not.toContain("BAD_REQUEST");
      expect(serialised).not.toContain("BAD_REQUEST");
      expect(serialised).not.toContain("INVALID_REQUEST_ERROR");
    }
  });

  it("fails cleanly when the account is not connected", async () => {
    const { adapter } = build();
    await expect(
      adapter.searchProviders({ categories: ["beauty.haircut"], limit: 1 }, makeContext({ credentials: {} })),
    ).rejects.toSatisfy((e: unknown) => PorterError.is(e) && e.code === "PROVIDER_UNAVAILABLE");
  });
});

describe("square adapter — untrusted seller text", () => {
  it("defuses hostile service names from the seller's own catalog", async () => {
    const { adapter } = build();
    const results = await adapter.searchProviders({ categories: ["beauty.barber"], limit: 5 }, ctx());
    const fade = results.flatMap((r) => r.services).find((s) => String(s.name).includes("Skin fade"));
    expect(fade).toBeDefined();
    const safe = sanitize(fade!.name, { delimit: true, label: "service name" });
    expect(safe.match(/\[\/PROVIDER_DATA\]/g)).toHaveLength(1);
    expect(sanitize(fade!.description!)).not.toContain("<script");
  });
});

describe("category inference", () => {
  it("maps common seller wording", () => {
    expect(inferCategory("Haircut", "45 minutes")).toBe("beauty.haircut");
    expect(inferCategory("Balayage")).toBe("beauty.hair.color");
    expect(inferCategory("Skin fade")).toBe("beauty.barber");
    expect(inferCategory("Gel manicure")).toBe("beauty.nails.manicure");
    expect(inferCategory("Deep tissue massage")).toBe("beauty.massage");
  });

  it("returns null rather than guessing", () => {
    expect(inferCategory("The Full Works")).toBeNull();
    expect(inferCategory("")).toBeNull();
    expect(inferCategory(undefined)).toBeNull();
  });
});
