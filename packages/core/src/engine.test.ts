import { beforeEach, describe, expect, it } from "vitest";
import { PorterError } from "@porter/shared";
import { createMockAdapter } from "@porter/adapter-mock";
import { TEST_CUSTOMER, createHarness, firstBookableSlot, type Harness } from "./testing.js";
import type { ConfirmationEnvelope } from "./confirmation.js";

function isEnvelope(v: unknown): v is ConfirmationEnvelope {
  return typeof v === "object" && v !== null && (v as any).status === "confirmation_required";
}

describe("BookingEngine — two-phase confirmation", () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });

  it("returns a summary and books nothing on the first call", async () => {
    const { slot } = await firstBookableSlot(h);
    const result = await h.engine.createBooking(
      h.actor,
      { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "k1" },
      h.signal,
    );

    expect(isEnvelope(result)).toBe(true);
    const env = result as ConfirmationEnvelope;
    expect(env.action).toBe("book");
    expect(env.confirmationToken.length).toBeGreaterThan(0);
    expect(env.summary.startsAt).toBe(slot.starts_at);

    // Nothing was stored, so nothing was booked.
    const { bookings } = await h.engine.listMyBookings(h.actor);
    expect(bookings).toHaveLength(0);
  });

  it("carries cost, frequency, cancellation terms and penalties", async () => {
    // The Muse Connector Policies forbid finalising a financial commitment
    // without clear notice of all four.
    const { slot } = await firstBookableSlot(h);
    const env = (await h.engine.createBooking(
      h.actor,
      { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "k1" },
      h.signal,
    )) as ConfirmationEnvelope;

    expect(env.money).toBeDefined();
    expect(env.money.formatted).toBeTruthy();
    expect(env.recurrence).toEqual({ kind: "one_off" });
    expect(typeof env.nonRefundable).toBe("boolean");
    expect(env.cancellationPolicy).toBeDefined();
    expect(typeof env.cancellationPolicy.known).toBe("boolean");
    expect(env.humanSummary).toContain("Book");
  });

  it("commits only when the token comes back", async () => {
    const { slot } = await firstBookableSlot(h);
    const env = (await h.engine.createBooking(
      h.actor,
      { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "k1" },
      h.signal,
    )) as ConfirmationEnvelope;

    const done = await h.engine.createBooking(
      h.actor,
      { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "k1", confirmation_token: env.confirmationToken },
      h.signal,
    );
    expect(isEnvelope(done)).toBe(false);
    expect((done as any).status).toBe("ok");
    expect((done as any).booking.starts_at).toBe(slot.starts_at);

    const { bookings } = await h.engine.listMyBookings(h.actor);
    expect(bookings).toHaveLength(1);
  });

  it("rejects a confirmation token reused for a different appointment", async () => {
    const { slot, slots } = await firstBookableSlot(h);
    const env = (await h.engine.createBooking(
      h.actor,
      { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "k1" },
      h.signal,
    )) as ConfirmationEnvelope;

    await h.engine.createBooking(
      h.actor,
      { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "k1", confirmation_token: env.confirmationToken },
      h.signal,
    );

    // Another request id cannot transfer consent to a different appointment.
    await expect(
      h.engine.createBooking(
        h.actor,
        { slot_id: slots[1]!.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "k2", confirmation_token: env.confirmationToken },
        h.signal,
      ),
    ).rejects.toSatisfy((e: unknown) => PorterError.is(e) && e.code === "CONFIRMATION_STALE");
  });

  it("rejects an expired confirmation token", async () => {
    const { slot } = await firstBookableSlot(h);
    const env = (await h.engine.createBooking(
      h.actor,
      { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "k1" },
      h.signal,
    )) as ConfirmationEnvelope;

    h.clock.advance(11 * 60_000);
    await expect(
      h.engine.createBooking(
        h.actor,
        { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "k1", confirmation_token: env.confirmationToken },
        h.signal,
      ),
    ).rejects.toSatisfy((e: unknown) => PorterError.is(e) && e.code === "CONFIRMATION_EXPIRED");
  });

  it("rejects another user's confirmation token", async () => {
    const { slot } = await firstBookableSlot(h);
    const env = (await h.engine.createBooking(
      h.actor,
      { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "k1" },
      h.signal,
    )) as ConfirmationEnvelope;

    await expect(
      h.engine.createBooking(
        { id: "user_someone_else" },
        { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "k1", confirmation_token: env.confirmationToken },
        h.signal,
      ),
    ).rejects.toSatisfy((e: unknown) => PorterError.is(e) && e.code === "UNAUTHENTICATED");
  });

  it("rejects a forged slot id", async () => {
    await expect(
      h.engine.createBooking(
        h.actor,
        { slot_id: "not.a.real.token", customer_details: TEST_CUSTOMER, idempotency_key: "k1" },
        h.signal,
      ),
    ).rejects.toSatisfy((e: unknown) => PorterError.is(e) && e.code === "INVALID_REQUEST");
  });
});

describe("BookingEngine — disclosure before commitment", () => {
  it("shows the real cancellation policy in the booking summary", async () => {
    // The Muse Connector Policies forbid finalising a financial commitment
    // without notice of the cancellation terms. Those terms have to appear in
    // the summary the user agrees to, when no booking exists yet to look up.
    const h = createHarness();
    const { slot } = await firstBookableSlot(h, "haircut");
    const env = (await h.engine.createBooking(
      h.actor,
      { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "k1" },
      h.signal,
    )) as ConfirmationEnvelope;

    // Shear Genius publishes one: free until 24 hours before, then $25.
    expect(env.cancellationPolicy.known).toBe(true);
    expect(env.cancellationPolicy.feeAmount).toBe(2500);
    expect(env.cancellationPolicy.freeUntil).not.toBeNull();
    expect(env.humanSummary).not.toContain("not published");
  });

  it("still says unknown when the business publishes nothing", async () => {
    const h = createHarness();
    // Volt Electric publishes no policy.
    const { slot } = await firstBookableSlot(h, "home.electrical.install");
    const env = (await h.engine.createBooking(
      h.actor,
      { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "k1" },
      h.signal,
    )) as ConfirmationEnvelope;
    expect(env.cancellationPolicy.known).toBe(false);
    expect(env.humanSummary).toContain("not published");
  });
});

describe("BookingEngine — availability accuracy", () => {
  it("fails cleanly with alternatives when the slot goes between summary and commit", async () => {
    const h = createHarness();
    const { slot, provider, service } = await firstBookableSlot(h);
    const env = (await h.engine.createBooking(
      h.actor,
      { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "k1" },
      h.signal,
    )) as ConfirmationEnvelope;

    // Someone else takes the slot in between.
    h.adapter.takeSlotExternally(provider.provider_id, service.service_id, new Date(slot.starts_at));

    try {
      await h.engine.createBooking(
        h.actor,
        { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "k1", confirmation_token: env.confirmationToken },
        h.signal,
      );
      expect.unreachable("should have refused");
    } catch (error) {
      expect(PorterError.is(error)).toBe(true);
      const e = error as PorterError;
      expect(e.code).toBe("SLOT_TAKEN");
      // The agent gets something to offer the user rather than a dead end.
      expect(Array.isArray(e.details.alternatives)).toBe(true);
      expect((e.details.alternatives as unknown[]).length).toBeGreaterThan(0);
    }

    const { bookings } = await h.engine.listMyBookings(h.actor);
    expect(bookings).toHaveLength(0);
  });
});

describe("BookingEngine — idempotency", () => {
  it("replays the stored response instead of booking twice", async () => {
    const h = createHarness();
    const { slot } = await firstBookableSlot(h);
    const env = (await h.engine.createBooking(
      h.actor,
      { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "same-key" },
      h.signal,
    )) as ConfirmationEnvelope;

    const args = { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "same-key", confirmation_token: env.confirmationToken };
    const first = (await h.engine.createBooking(h.actor, args, h.signal)) as any;
    const second = (await h.engine.createBooking(h.actor, args, h.signal)) as any;

    expect(second.booking.booking_id).toBe(first.booking.booking_id);
    const { bookings } = await h.engine.listMyBookings(h.actor);
    expect(bookings).toHaveLength(1);
  });

  it("hard-errors when the same key is reused for a different request", async () => {
    const h = createHarness();
    const { slot, slots } = await firstBookableSlot(h);

    const env1 = (await h.engine.createBooking(h.actor, { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "reused" }, h.signal)) as ConfirmationEnvelope;
    await h.engine.createBooking(h.actor, { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "reused", confirmation_token: env1.confirmationToken }, h.signal);

    const env2 = (await h.engine.createBooking(h.actor, { slot_id: slots[1]!.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "k-other" }, h.signal)) as ConfirmationEnvelope;
    await expect(
      h.engine.createBooking(h.actor, { slot_id: slots[1]!.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "reused", confirmation_token: env2.confirmationToken }, h.signal),
    ).rejects.toSatisfy((e: unknown) => PorterError.is(e) && e.code === "IDEMPOTENCY_CONFLICT");
  });

  it("does not burn the key when the call fails", async () => {
    const h = createHarness();
    const { slot, provider, service } = await firstBookableSlot(h);
    const env = (await h.engine.createBooking(h.actor, { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "retry-me" }, h.signal)) as ConfirmationEnvelope;

    h.adapter.takeSlotExternally(provider.provider_id, service.service_id, new Date(slot.starts_at));
    await expect(
      h.engine.createBooking(h.actor, { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "retry-me", confirmation_token: env.confirmationToken }, h.signal),
    ).rejects.toBeDefined();

    // The key is free again, so a retry is possible rather than permanently stuck.
    const record = await h.store.idempotency.get(h.actor.id, "create_booking", "retry-me");
    expect(record).toBeNull();
  });
});

describe("BookingEngine — cancellation", () => {
  async function bookOne(h: Harness, category = "massage") {
    const { slot } = await firstBookableSlot(h, category);
    const env = (await h.engine.createBooking(h.actor, { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "b1" }, h.signal)) as ConfirmationEnvelope;
    const done = (await h.engine.createBooking(h.actor, { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "b1", confirmation_token: env.confirmationToken }, h.signal)) as any;
    return done.booking.booking_id as string;
  }

  it("returns the fee before cancelling anything", async () => {
    const h = createHarness();
    const bookingId = await bookOne(h);

    const env = (await h.engine.cancelBooking(h.actor, { booking_id: bookingId, idempotency_key: "c1" }, h.signal)) as ConfirmationEnvelope;
    expect(env.action).toBe("cancel");
    expect(env.cancellationPolicy.known).toBe(true);
    // Stillwater charges a fee on every cancellation.
    expect(env.money.kind).toBe("fee");
    expect(env.money.amount).toBeGreaterThan(0);

    // Still confirmed: quoting the fee must not cancel.
    const { bookings } = await h.engine.listMyBookings(h.actor);
    expect(bookings[0]!.status).toBe("confirmed");
  });

  it("cancels and reports the fee actually charged", async () => {
    const h = createHarness();
    const bookingId = await bookOne(h);
    const env = (await h.engine.cancelBooking(h.actor, { booking_id: bookingId, idempotency_key: "c1" }, h.signal)) as ConfirmationEnvelope;
    const result = (await h.engine.cancelBooking(h.actor, { booking_id: bookingId, idempotency_key: "c1", confirmation_token: env.confirmationToken }, h.signal)) as any;

    expect(result.status).toBe("ok");
    expect(result.booking.status).toBe("cancelled");
    expect(result.fee_charged.amount).toBe(env.money.amount);
  });

  it("says a policy is unknown rather than inventing a zero fee", async () => {
    const h = createHarness();
    const bookingId = await bookOne(h, "home.electrical.install"); // Volt Electric: unknown policy
    const env = (await h.engine.cancelBooking(h.actor, { booking_id: bookingId, idempotency_key: "c1" }, h.signal)) as ConfirmationEnvelope;
    expect(env.cancellationPolicy.known).toBe(false);
    expect(env.cancellationPolicy.feeAmount).toBeNull();
    expect(env.humanSummary).toContain("not published");
  });
});

describe("BookingEngine — capability degradation", () => {
  it("reports an unsupported capability instead of failing obscurely", async () => {
    const adapter = createMockAdapter({ seed: 42, capabilityOverrides: { messaging: false } });
    // The capability flag and the method must agree, so drop the method too.
    delete (adapter as any).messageProvider;
    const h = createHarness({ adapter });

    const { slot } = await firstBookableSlot(h);
    const env = (await h.engine.createBooking(h.actor, { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "b1" }, h.signal)) as ConfirmationEnvelope;
    const done = (await h.engine.createBooking(h.actor, { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "b1", confirmation_token: env.confirmationToken }, h.signal)) as any;

    await expect(
      h.engine.messageProvider(h.actor, { booking_id: done.booking.booking_id, message: "running late" }, h.signal),
    ).rejects.toSatisfy((e: unknown) => PorterError.is(e) && e.code === "UNSUPPORTED_CAPABILITY");
  });
});

describe("BookingEngine — data deletion", () => {
  it("purges bookings and idempotency records on request", async () => {
    // Terms 4.3(f): delete or render inaccessible on revocation or request.
    const h = createHarness();
    const { slot } = await firstBookableSlot(h);
    const env = (await h.engine.createBooking(h.actor, { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "b1" }, h.signal)) as ConfirmationEnvelope;
    await h.engine.createBooking(h.actor, { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "b1", confirmation_token: env.confirmationToken }, h.signal);

    const deleted = await h.engine.deleteUserData(h.actor);
    expect(deleted.bookings).toBe(1);
    expect(deleted.idempotency).toBeGreaterThanOrEqual(1);

    const { bookings } = await h.engine.listMyBookings(h.actor);
    expect(bookings).toHaveLength(0);

    // The audit log survives, because it holds no personal data. Terms 4.3(g).
    expect(h.store.auditRows.length).toBeGreaterThan(0);
  });
});
