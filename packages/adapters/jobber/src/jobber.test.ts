import { describe, expect, it } from "vitest";
import { makeContext, runAdapterConformance } from "@porter/adapter-contract";
import { PorterError } from "@porter/shared";
import { createJobberAdapter } from "./index.js";
import { FakeJobber, JOBBER_TEST_TOKEN } from "./testing/fake-jobber.js";
import { mapRequestStatus } from "./map.js";

const ctx = () => makeContext({ credentials: { accessToken: JOBBER_TEST_TOKEN } });

function build(options: ConstructorParameters<typeof FakeJobber>[0] = {}) {
  const fake = new FakeJobber(options);
  return { fake, adapter: createJobberAdapter({ http: fake }) };
}

const CUSTOMER = {
  givenName: "Sam",
  phone: "555-0100",
  addressLine1: "12 Oak St",
  city: "Oakland",
  postalCode: "94610",
};

// The same suite, unchanged, against a platform with a completely different
// shape from Square's. This is the real test of whether the interface holds.
runAdapterConformance("jobber", {
  makeAdapter: () => build().adapter,
  searchCategory: "home.plumbing.drain",
  customer: CUSTOMER,
  credentials: { accessToken: JOBBER_TEST_TOKEN },
  makeFailingAdapter: () => build({ failWith: { status: 500, message: "boom" } }).adapter,
});

describe("jobber adapter — request-based model", () => {
  it("declares the capabilities its platform actually has", () => {
    const { adapter } = build();
    // No slot hold and no published cancellation policy. Core degrades on
    // both rather than pretending otherwise.
    expect(adapter.capabilities.slotHold).toBe(false);
    expect(adapter.capabilities.cancellationPolicy).toBe(false);
    expect(adapter.capabilities.messaging).toBe(false);
    expect(adapter.capabilities.quoting).toBe(true);
    expect(adapter.holdSlot).toBeUndefined();
    expect(adapter.messageProvider).toBeUndefined();
  });

  it("requires an address, because someone has to drive to it", () => {
    const { adapter } = build();
    for (const field of ["addressLine1", "city", "postalCode"]) {
      expect(adapter.capabilities.requiredCustomerFields).toContain(field);
    }
  });

  it("offers arrival windows rather than exact appointment times", async () => {
    const { adapter } = build();
    const c = ctx();
    const [result] = await adapter.searchProviders({ categories: ["home.plumbing.drain"], limit: 1 }, c);
    const service = result!.services.find((s) => !s.quoteRequired)!;
    const slots = await adapter.getAvailability(
      { providerId: result!.provider.id, serviceId: service.id, from: c.now, to: new Date(c.now.getTime() + 14 * 86_400_000), limit: 10 },
      c,
    );
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(slot.providerSlotRef).toMatch(/^window:/);
      // A window is hours wide, not the length of the work.
      const hours = (slot.endsAt.getTime() - slot.startsAt.getTime()) / 3_600_000;
      expect(hours).toBeGreaterThanOrEqual(4);
    }
  });

  it("does not offer same-day work", async () => {
    const { adapter } = build();
    const c = ctx();
    const [result] = await adapter.searchProviders({ categories: ["home.plumbing.drain"], limit: 1 }, c);
    const service = result!.services[0]!;
    const slots = await adapter.getAvailability(
      { providerId: result!.provider.id, serviceId: service.id, from: c.now, to: new Date(c.now.getTime() + 7 * 86_400_000), limit: 10 },
      c,
    );
    for (const slot of slots) {
      expect(slot.startsAt.getTime()).toBeGreaterThanOrEqual(c.now.getTime() + 24 * 3_600_000);
    }
  });

  it("skips weekends", async () => {
    const { adapter } = build();
    const c = ctx();
    const [result] = await adapter.searchProviders({ categories: ["home.plumbing.drain"], limit: 1 }, c);
    const slots = await adapter.getAvailability(
      { providerId: result!.provider.id, serviceId: result!.services[0]!.id, from: c.now, to: new Date(c.now.getTime() + 21 * 86_400_000), limit: 40 },
      c,
    );
    for (const slot of slots) {
      expect([0, 6]).not.toContain(slot.startsAt.getUTCDay());
    }
  });

  it("creates a booking that is pending, not confirmed", async () => {
    const { adapter } = build();
    const c = ctx();
    const [result] = await adapter.searchProviders({ categories: ["home.plumbing.drain"], limit: 1 }, c);
    const service = result!.services.find((s) => !s.quoteRequired)!;
    const slots = await adapter.getAvailability({ providerId: result!.provider.id, serviceId: service.id, from: c.now, to: new Date(c.now.getTime() + 14 * 86_400_000), limit: 5 }, c);

    const booking = await adapter.createBooking(
      { providerId: result!.provider.id, locationId: slots[0]!.locationId, serviceId: service.id, startsAt: slots[0]!.startsAt, endsAt: slots[0]!.endsAt, customer: CUSTOMER, idempotencyKey: "jb-1" },
      c,
    );
    // The business still has to schedule it. Saying "confirmed" would be a lie.
    expect(booking.status).toBe("pending");
  });

  it("creates the client and property before the request", async () => {
    const { fake, adapter } = build();
    const c = ctx();
    const [result] = await adapter.searchProviders({ categories: ["home.plumbing.drain"], limit: 1 }, c);
    const service = result!.services.find((s) => !s.quoteRequired)!;
    const slots = await adapter.getAvailability({ providerId: result!.provider.id, serviceId: service.id, from: c.now, to: new Date(c.now.getTime() + 14 * 86_400_000), limit: 5 }, c);
    await adapter.createBooking(
      { providerId: result!.provider.id, locationId: slots[0]!.locationId, serviceId: service.id, startsAt: slots[0]!.startsAt, endsAt: slots[0]!.endsAt, customer: CUSTOMER, idempotencyKey: "jb-2" },
      c,
    );

    const order = fake.operations.map((o) => o.name);
    expect(order.indexOf("PorterClientCreate")).toBeLessThan(order.indexOf("PorterPropertyCreate"));
    expect(order.indexOf("PorterPropertyCreate")).toBeLessThan(order.indexOf("PorterRequestCreate"));
  });

  it("sends only the customer fields it declared", async () => {
    const { fake, adapter } = build();
    const c = ctx();
    const [result] = await adapter.searchProviders({ categories: ["home.plumbing.drain"], limit: 1 }, c);
    const service = result!.services.find((s) => !s.quoteRequired)!;
    const slots = await adapter.getAvailability({ providerId: result!.provider.id, serviceId: service.id, from: c.now, to: new Date(c.now.getTime() + 14 * 86_400_000), limit: 5 }, c);
    await adapter.createBooking(
      { providerId: result!.provider.id, locationId: slots[0]!.locationId, serviceId: service.id, startsAt: slots[0]!.startsAt, endsAt: slots[0]!.endsAt, customer: CUSTOMER, idempotencyKey: "jb-3" },
      c,
    );

    const client = fake.operations.find((o) => o.name === "PorterClientCreate")!;
    const input = (client.variables.input ?? {}) as Record<string, unknown>;
    // No address on the client record: the address belongs to the property.
    expect(input).not.toHaveProperty("address");
    expect(input).toHaveProperty("firstName");

    const property = fake.operations.find((o) => o.name === "PorterPropertyCreate")!;
    const address = ((property.variables.input as any).address ?? {}) as Record<string, unknown>;
    expect(address.street1).toBe("12 Oak St");
    // Nothing the adapter did not declare an interest in.
    expect(address).not.toHaveProperty("email");
  });

  it("reports the cancellation policy as unknown", async () => {
    const { adapter } = build();
    const c = ctx();
    const [result] = await adapter.searchProviders({ categories: ["home.plumbing.drain"], limit: 1 }, c);
    const service = result!.services.find((s) => !s.quoteRequired)!;
    const slots = await adapter.getAvailability({ providerId: result!.provider.id, serviceId: service.id, from: c.now, to: new Date(c.now.getTime() + 14 * 86_400_000), limit: 5 }, c);
    const booking = await adapter.createBooking(
      { providerId: result!.provider.id, locationId: slots[0]!.locationId, serviceId: service.id, startsAt: slots[0]!.startsAt, endsAt: slots[0]!.endsAt, customer: CUSTOMER, idempotencyKey: "jb-4" },
      c,
    );
    const policy = await adapter.getCancellationPolicy(booking.providerBookingRef, c);
    // Jobber publishes none. Claiming free cancellation would be a false
    // statement about someone else's business.
    expect(policy.known).toBe(false);
    expect(policy.feeAmount).toBeNull();
  });

  it("does not re-offer a window it has already requested", async () => {
    const { adapter } = build();
    const c = ctx();
    const [result] = await adapter.searchProviders({ categories: ["home.plumbing.drain"], limit: 1 }, c);
    const service = result!.services.find((s) => !s.quoteRequired)!;
    const before = await adapter.getAvailability({ providerId: result!.provider.id, serviceId: service.id, from: c.now, to: new Date(c.now.getTime() + 14 * 86_400_000), limit: 10 }, c);
    await adapter.createBooking(
      { providerId: result!.provider.id, locationId: before[0]!.locationId, serviceId: service.id, startsAt: before[0]!.startsAt, endsAt: before[0]!.endsAt, customer: CUSTOMER, idempotencyKey: "jb-5" },
      c,
    );
    const after = await adapter.getAvailability({ providerId: result!.provider.id, serviceId: service.id, from: c.now, to: new Date(c.now.getTime() + 14 * 86_400_000), limit: 10 }, c);
    expect(after.map((s) => s.startsAt.toISOString())).not.toContain(before[0]!.startsAt.toISOString());
  });

  it("gives a quote without inventing a price", async () => {
    const { adapter } = build();
    const c = ctx();
    const [result] = await adapter.searchProviders({ categories: ["home.plumbing.leak"], limit: 1 }, c);
    const quote = await adapter.getQuote!(
      { providerId: result!.provider.id, jobDescription: "Water under the kitchen sink since last night", address: CUSTOMER, category: "home.plumbing.leak" },
      c,
    );
    // Jobber quotes are written by the business after they see the job.
    expect(quote.price).toBeUndefined();
    expect(String(quote.summary)).toContain("confirm a price");
    expect(quote.offeredSlots!.length).toBeGreaterThan(0);
  });
});

describe("jobber adapter — GraphQL handling", () => {
  it("sends the API version header on every call", async () => {
    const { adapter } = build();
    await expect(
      adapter.searchProviders({ categories: ["home.plumbing.drain"], limit: 1 }, makeContext({ credentials: { accessToken: JOBBER_TEST_TOKEN } })),
    ).resolves.toBeDefined();
  });

  it("treats a 200 with an errors array as a failure", async () => {
    const { adapter } = build();
    const c = ctx();
    // Archiving something that does not exist returns 200 + errors.
    await expect(adapter.cancelBooking({ bookingRef: "REQ_NOPE", providerId: "jobber:ACC_JOBBER_1", idempotencyKey: "x" }, c)).rejects.toSatisfy(
      (e: unknown) => PorterError.is(e) && e.code === "NOT_FOUND",
    );
  });

  it("surfaces userErrors as INVALID_REQUEST without repeating Jobber's text", async () => {
    const { adapter } = build({ userErrorOn: "requestCreate" });
    const c = ctx();
    const [result] = await adapter.searchProviders({ categories: ["home.plumbing.drain"], limit: 1 }, c);
    const service = result!.services.find((s) => !s.quoteRequired)!;
    const slots = await adapter.getAvailability({ providerId: result!.provider.id, serviceId: service.id, from: c.now, to: new Date(c.now.getTime() + 14 * 86_400_000), limit: 5 }, c);

    try {
      await adapter.createBooking(
        { providerId: result!.provider.id, locationId: slots[0]!.locationId, serviceId: service.id, startsAt: slots[0]!.startsAt, endsAt: slots[0]!.endsAt, customer: CUSTOMER, idempotencyKey: "jb-err" },
        c,
      );
      expect.unreachable();
    } catch (error) {
      const e = error as PorterError;
      expect(e.code).toBe("INVALID_REQUEST");
      expect(e.message).not.toContain("Property required");
      // The offending field names are useful and are not provider prose.
      expect(e.details.fields).toContain("propertyId");
    }
  });

  it("maps throttling to RATE_LIMITED with a retry hint", async () => {
    const { adapter } = build({ failWith: { status: 429, message: "Throttled", code: "THROTTLED" } });
    try {
      await adapter.searchProviders({ categories: ["home.plumbing.drain"], limit: 1 }, ctx());
      expect.unreachable();
    } catch (error) {
      const e = error as PorterError;
      expect(e.code).toBe("RATE_LIMITED");
      expect(e.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it("maps an expired token to PROVIDER_UNAVAILABLE", async () => {
    const { adapter } = build();
    await expect(
      adapter.searchProviders({ categories: ["home.plumbing.drain"], limit: 1 }, makeContext({ credentials: { accessToken: "wrong" } })),
    ).rejects.toSatisfy((e: unknown) => PorterError.is(e) && e.code === "PROVIDER_UNAVAILABLE");
  });

  it("warns when the query budget runs low", async () => {
    const warnings: string[] = [];
    const { adapter } = build({ lowBudget: true });
    const c = makeContext({
      credentials: { accessToken: JOBBER_TEST_TOKEN },
      log: { debug() {}, info() {}, warn: (m: string) => warnings.push(m), error() {}, child() { return this; } } as any,
    });
    await adapter.searchProviders({ categories: ["home.plumbing.drain"], limit: 1 }, c);
    // Jobber throttles on a points budget, so this must surface before calls
    // start failing outright.
    expect(warnings).toContain("jobber_query_budget_low");
  });
});

describe("request status mapping", () => {
  it("maps Jobber's lifecycle onto Porter's", () => {
    expect(mapRequestStatus("requires_scheduling")).toBe("pending");
    expect(mapRequestStatus("scheduled")).toBe("confirmed");
    expect(mapRequestStatus("converted")).toBe("confirmed");
    expect(mapRequestStatus("completed")).toBe("completed");
    expect(mapRequestStatus("archived")).toBe("cancelled");
    // An unknown status is pending, never confirmed: the safe direction.
    expect(mapRequestStatus(undefined)).toBe("pending");
  });
});
