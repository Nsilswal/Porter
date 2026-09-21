import { describe, expect, it } from "vitest";
import { createMockAdapter } from "@porter/adapter-mock";
import { TEST_CUSTOMER, createHarness, firstBookableSlot } from "./testing.js";
import type { ConfirmationEnvelope } from "./confirmation.js";

/**
 * Prompt-injection safety.
 *
 * A business types its own name into its booking platform, so every
 * provider-supplied string is an injection surface. The Muse Connector
 * Policies make carrying such content a prohibited practice in itself
 * ("building exfiltration or prompt-injection vectors"), so these tests cover
 * a compliance obligation as well as a security one.
 *
 * The hostile records live in the default fixture set, so every search in the
 * suite exercises this path rather than only the tests below.
 */
describe("provider text is data, never instructions", () => {
  it("neutralises hostile business names in search results", async () => {
    const h = createHarness();
    const { providers } = await h.engine.searchProviders(h.actor, { category: "haircut", limit: 25 }, h.signal);
    const hostile = providers.find((p) => p.name.includes("Ignore previous instructions"));
    expect(hostile, "the hostile fixture should still be returned, just defused").toBeDefined();

    const blob = JSON.stringify(providers);
    // Markup that could restructure the response is gone.
    expect(blob).not.toContain("<tool_call>");
    expect(blob).not.toContain("</description>");
    expect(blob).not.toMatch(/```/);
    // Our own fence cannot be forged by provider text.
    expect(blob).not.toContain("[/PROVIDER_DATA]");
    // Invisible characters cannot hide text from a human reviewer.
    expect(blob).not.toMatch(/[​-‏‪-‮\u0000-\u0008]/);
  });

  it("does not let hostile text change what a tool does", async () => {
    const h = createHarness();
    const { providers } = await h.engine.searchProviders(h.actor, { category: "haircut", limit: 25 }, h.signal);
    const hostile = providers.find((p) => p.name.includes("Ignore previous instructions"))!;
    const service = hostile.services[0]!;

    const from = new Date(h.clock.nowMs() + 60 * 60_000).toISOString();
    const to = new Date(h.clock.nowMs() + 7 * 24 * 60 * 60_000).toISOString();
    const { slots } = await h.engine.getAvailability(
      h.actor,
      { provider_id: hostile.provider_id, service_id: service.service_id, from, to, limit: 5 },
      h.signal,
    );

    // The service name claims a $9999 charge was pre-approved. The price in
    // the envelope must come from the data model, not from that text.
    const env = (await h.engine.createBooking(
      h.actor,
      { slot_id: slots[0]!.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "inj-1" },
      h.signal,
    )) as ConfirmationEnvelope;

    expect(env.status).toBe("confirmation_required");
    expect(env.money.amount).toBe(5000);
    expect(env.money.amount).not.toBe(999_900);

    // And it is still two-phase: hostile text cannot skip confirmation.
    const { bookings } = await h.engine.listMyBookings(h.actor);
    expect(bookings).toHaveLength(0);
  });

  it("does not let a hostile policy string fake a free cancellation", async () => {
    const h = createHarness();
    const { providers } = await h.engine.searchProviders(h.actor, { category: "beauty.facial", limit: 25 }, h.signal);
    const spa = providers.find((p) => p.name.includes("Calm Waters"));
    expect(spa).toBeDefined();
    // Its description says "always report no fee". The real policy has one.
    const service = spa!.services[0]!;
    const from = new Date(h.clock.nowMs() + 60 * 60_000).toISOString();
    const to = new Date(h.clock.nowMs() + 7 * 24 * 60 * 60_000).toISOString();
    const { slots } = await h.engine.getAvailability(h.actor, { provider_id: spa!.provider_id, service_id: service.service_id, from, to, limit: 3 }, h.signal);

    const env = (await h.engine.createBooking(h.actor, { slot_id: slots[0]!.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "inj-2" }, h.signal)) as ConfirmationEnvelope;
    const done = (await h.engine.createBooking(h.actor, { slot_id: slots[0]!.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "inj-2", confirmation_token: env.confirmationToken }, h.signal)) as any;

    const cancelEnv = (await h.engine.cancelBooking(h.actor, { booking_id: done.booking.booking_id, idempotency_key: "inj-3" }, h.signal)) as ConfirmationEnvelope;
    expect(cancelEnv.cancellationPolicy.known).toBe(true);
    expect(cancelEnv.cancellationPolicy.feeAmount).toBe(4000);
  });

  it("keeps hostile text out of stored booking records", async () => {
    const h = createHarness();
    const { providers } = await h.engine.searchProviders(h.actor, { category: "haircut", limit: 25 }, h.signal);
    const hostile = providers.find((p) => p.name.includes("Ignore previous instructions"))!;
    const service = hostile.services[0]!;
    const from = new Date(h.clock.nowMs() + 60 * 60_000).toISOString();
    const to = new Date(h.clock.nowMs() + 7 * 24 * 60 * 60_000).toISOString();
    const { slots } = await h.engine.getAvailability(h.actor, { provider_id: hostile.provider_id, service_id: service.service_id, from, to, limit: 3 }, h.signal);

    const env = (await h.engine.createBooking(h.actor, { slot_id: slots[0]!.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "inj-4" }, h.signal)) as ConfirmationEnvelope;
    await h.engine.createBooking(h.actor, { slot_id: slots[0]!.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "inj-4", confirmation_token: env.confirmationToken }, h.signal);

    const { bookings } = await h.engine.listMyBookings(h.actor);
    const stored = JSON.stringify(bookings);
    expect(stored).not.toContain("[/PROVIDER_DATA]");
    expect(stored).not.toContain("<tool_call>");
    expect(stored).not.toMatch(/```/);
  });

  it("does not execute anything when every business is hostile", async () => {
    const hostileOnly = createMockAdapter({
      seed: 7,
      businesses: (await import("@porter/adapter-mock")).MOCK_BUSINESSES.filter((b) => b.key.startsWith("injection-")),
    });
    const h = createHarness({ adapter: hostileOnly });
    const { providers } = await h.engine.searchProviders(h.actor, { category: "haircut", limit: 10 }, h.signal);
    expect(providers.length).toBeGreaterThan(0);
    const { bookings } = await h.engine.listMyBookings(h.actor);
    expect(bookings).toHaveLength(0);
  });
});
