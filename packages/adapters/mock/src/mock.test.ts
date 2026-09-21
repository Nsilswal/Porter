import { describe, expect, it } from "vitest";
import { runAdapterConformance, makeContext } from "@porter/adapter-contract";
import { PorterError } from "@porter/shared";
import { createMockAdapter } from "./index.js";

runAdapterConformance("mock", {
  makeAdapter: () => createMockAdapter({ seed: 42 }),
  searchCategory: "beauty.haircut",
  customer: { givenName: "Sam", phone: "555-0100" },
  makeFailingAdapter: () => createMockAdapter({ seed: 42, failureRate: 1, failureMode: "transport" }),
});

describe("mock adapter behaviour", () => {
  it("is deterministic for a given seed", async () => {
    const a = createMockAdapter({ seed: 99 });
    const b = createMockAdapter({ seed: 99 });
    const ctx = makeContext();
    const [ra] = await a.searchProviders({ categories: ["beauty.haircut"], limit: 1 }, ctx);
    const [rb] = await b.searchProviders({ categories: ["beauty.haircut"], limit: 1 }, ctx);
    expect(ra!.nextAvailable?.startsAt.toISOString()).toBe(rb!.nextAvailable?.startsAt.toISOString());
  });

  it("produces different availability for different seeds", async () => {
    const ctx = makeContext();
    const a = createMockAdapter({ seed: 1 });
    const b = createMockAdapter({ seed: 2 });
    const sa = await a.getAvailability({ providerId: "mock:shear-genius", serviceId: "mock:shear-genius:cut", from: new Date("2026-10-05T00:00:00Z"), to: new Date("2026-10-06T00:00:00Z"), limit: 20 }, ctx);
    const sb = await b.getAvailability({ providerId: "mock:shear-genius", serviceId: "mock:shear-genius:cut", from: new Date("2026-10-05T00:00:00Z"), to: new Date("2026-10-06T00:00:00Z"), limit: 20 }, ctx);
    expect(sa.map((s) => s.startsAt.getTime())).not.toEqual(sb.map((s) => s.startsAt.getTime()));
  });

  it("reports an unknown cancellation policy rather than a zero fee", async () => {
    const adapter = createMockAdapter({ seed: 42 });
    const ctx = makeContext();
    const slots = await adapter.getAvailability({ providerId: "mock:volt-electric", serviceId: "mock:volt-electric:lighting", from: new Date("2026-10-05T00:00:00Z"), to: new Date("2026-10-19T00:00:00Z"), limit: 5 }, ctx);
    const booking = await adapter.createBooking(
      { providerId: "mock:volt-electric", locationId: "mock:volt-electric:loc", serviceId: "mock:volt-electric:lighting", startsAt: slots[0]!.startsAt, endsAt: slots[0]!.endsAt, customer: { givenName: "Sam", phone: "555-0100" }, idempotencyKey: "p1" },
      ctx,
    );
    const policy = await adapter.getCancellationPolicy(booking.providerBookingRef, ctx);
    expect(policy.known).toBe(false);
    expect(policy.feeAmount).toBeNull();
  });

  it("surfaces configured failure modes as PorterError", async () => {
    const adapter = createMockAdapter({ seed: 42, failureRate: 1, failureMode: "rate_limited" });
    await expect(adapter.searchProviders({ categories: ["beauty.haircut"], limit: 1 }, makeContext())).rejects.toSatisfy(
      (e: unknown) => PorterError.is(e) && e.code === "RATE_LIMITED",
    );
  });

  it("respects configured latency", async () => {
    const adapter = createMockAdapter({ seed: 42, latencyMs: 60 });
    const started = Date.now();
    await adapter.searchProviders({ categories: ["beauty.haircut"], limit: 1 }, makeContext());
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
  });
});
