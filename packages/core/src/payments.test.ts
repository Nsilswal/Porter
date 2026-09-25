import { describe, expect, it } from "vitest";
import { PorterError } from "@porter/shared";
import { TEST_CUSTOMER, createHarness, firstBookableSlot, type Harness } from "./testing.js";
import type { ConfirmationEnvelope } from "./confirmation.js";
import { outstanding } from "./engine.js";
import type { StoredBooking } from "./ports.js";

const isEnvelope = (v: unknown): v is ConfirmationEnvelope =>
  typeof v === "object" && v !== null && (v as any).status === "confirmation_required";

/** Book something. "massage" has a deposit in the fixtures; "haircut" does not. */
async function book(h: Harness, category = "massage", key = "b1") {
  const { slot } = await firstBookableSlot(h, category);
  const env = (await h.engine.createBooking(h.actor, { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: key }, h.signal)) as ConfirmationEnvelope;
  const done = (await h.engine.createBooking(
    h.actor,
    { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: key, confirmation_token: env.confirmationToken },
    h.signal,
  )) as any;
  return done.booking.booking_id as string;
}

describe("outstanding balance", () => {
  const base: StoredBooking = {
    id: "bk1", userId: "u", adapterId: "mock", providerBookingRef: "r", status: "confirmed",
    startsAt: new Date(), endsAt: new Date(), providerId: "p", locationId: "l", serviceId: "s",
    providerName: "Biz", serviceName: "Svc", priceMinor: 12000, currency: "USD",
    depositMinor: 3000, paidMinor: 0, createdAt: new Date(), updatedAt: new Date(),
  };

  it("asks for the deposit first when one is owed", () => {
    expect(outstanding(base)).toEqual({ kind: "deposit", amount: { amount: 3000, currency: "USD" } });
  });

  it("asks for the balance once the deposit is paid", () => {
    expect(outstanding({ ...base, paidMinor: 3000 })).toEqual({ kind: "total", amount: { amount: 9000, currency: "USD" } });
  });

  it("asks for nothing once it is paid in full", () => {
    expect(outstanding({ ...base, paidMinor: 12000 })).toBeNull();
  });

  it("asks for nothing when there is no price yet", () => {
    expect(outstanding({ ...base, priceMinor: null })).toBeNull();
  });
});

describe("pay_or_deposit", () => {
  it("quotes the deposit first and charges nothing", async () => {
    const h = createHarness();
    const bookingId = await book(h);
    const env = (await h.engine.payOrDeposit(h.actor, { booking_id: bookingId, idempotency_key: "p1" }, h.signal)) as ConfirmationEnvelope;

    expect(isEnvelope(env)).toBe(true);
    expect(env.money.kind).toBe("deposit");
    expect(env.money.amount).toBe(3000);
    // Quoting must not move money.
    expect(h.payments.charges).toHaveLength(0);
  });

  it("charges the deposit on commit, then the balance", async () => {
    const h = createHarness();
    const bookingId = await book(h);

    const depositEnv = (await h.engine.payOrDeposit(h.actor, { booking_id: bookingId, idempotency_key: "p1" }, h.signal)) as ConfirmationEnvelope;
    const deposit = (await h.engine.payOrDeposit(h.actor, { booking_id: bookingId, idempotency_key: "p1", confirmation_token: depositEnv.confirmationToken }, h.signal)) as any;
    expect(deposit.kind).toBe("deposit");
    expect(deposit.amount.amount).toBe(3000);
    expect(deposit.amount_outstanding).toBe(9000);

    const balanceEnv = (await h.engine.payOrDeposit(h.actor, { booking_id: bookingId, idempotency_key: "p2" }, h.signal)) as ConfirmationEnvelope;
    expect(balanceEnv.money.amount).toBe(9000);
    const balance = (await h.engine.payOrDeposit(h.actor, { booking_id: bookingId, idempotency_key: "p2", confirmation_token: balanceEnv.confirmationToken }, h.signal)) as any;
    expect(balance.kind).toBe("total");
    expect(balance.amount_outstanding).toBe(0);

    expect(h.payments.charges.map((c) => c.amount.amount)).toEqual([3000, 9000]);
  });

  it("refuses once nothing is outstanding", async () => {
    const h = createHarness();
    const bookingId = await book(h);
    for (const key of ["p1", "p2"]) {
      const env = (await h.engine.payOrDeposit(h.actor, { booking_id: bookingId, idempotency_key: key }, h.signal)) as ConfirmationEnvelope;
      await h.engine.payOrDeposit(h.actor, { booking_id: bookingId, idempotency_key: key, confirmation_token: env.confirmationToken }, h.signal);
    }
    await expect(h.engine.payOrDeposit(h.actor, { booking_id: bookingId, idempotency_key: "p3" }, h.signal)).rejects.toSatisfy(
      (e: unknown) => PorterError.is(e) && e.code === "PAYMENT_REQUIRED",
    );
  });

  it("is replay-safe: a repeated key charges once", async () => {
    const h = createHarness();
    const bookingId = await book(h);
    const env = (await h.engine.payOrDeposit(h.actor, { booking_id: bookingId, idempotency_key: "same" }, h.signal)) as ConfirmationEnvelope;
    const args = { booking_id: bookingId, idempotency_key: "same", confirmation_token: env.confirmationToken };

    const first = (await h.engine.payOrDeposit(h.actor, args, h.signal)) as any;
    const second = (await h.engine.payOrDeposit(h.actor, args, h.signal)) as any;

    expect(second.payment_id).toBe(first.payment_id);
    expect(h.payments.charges).toHaveLength(1);
    const records = await h.store.payments.listForBooking(h.actor.id, bookingId);
    expect(records).toHaveLength(1);
  });

  it("tells the agent when the bank wants the cardholder to authenticate", async () => {
    // The case that matters for an agent: nobody is at a checkout page.
    const h = createHarness();
    const bookingId = await book(h);
    const env = (await h.engine.payOrDeposit(h.actor, { booking_id: bookingId, idempotency_key: "p1" }, h.signal)) as ConfirmationEnvelope;
    h.payments.setNextResult({ status: "requires_action", actionUrl: "https://bank.example/auth/123" });

    try {
      await h.engine.payOrDeposit(h.actor, { booking_id: bookingId, idempotency_key: "p1", confirmation_token: env.confirmationToken }, h.signal);
      expect.unreachable();
    } catch (error) {
      const e = error as PorterError;
      expect(e.code).toBe("IDEMPOTENCY_UNCERTAIN");
      expect(e.details.reason).toBe("authentication_required");
      expect(e.details.approval_url).toBe("https://bank.example/auth/123");
      // The message must tell the agent what to ask the user to do.
      expect(e.message).toMatch(/approve|bank/i);
    }
    // Nothing was collected.
    const booking = (await h.engine.listMyBookings(h.actor)).bookings[0]!;
    expect(booking.booking_id).toBe(bookingId);
  });

  it("explains a decline in words a person understands", async () => {
    const h = createHarness();
    const bookingId = await book(h);
    const env = (await h.engine.payOrDeposit(h.actor, { booking_id: bookingId, idempotency_key: "p1" }, h.signal)) as ConfirmationEnvelope;
    h.payments.setNextResult({ status: "failed", reason: "insufficient_funds" });

    await expect(
      h.engine.payOrDeposit(h.actor, { booking_id: bookingId, idempotency_key: "p1", confirmation_token: env.confirmationToken }, h.signal),
    ).rejects.toSatisfy((e: unknown) => PorterError.is(e) && e.message.includes("enough funds"));
  });

  it("refuses when there is no payment method saved", async () => {
    const h = createHarness({ noPaymentMethod: true });
    const bookingId = await book(h);
    const env = (await h.engine.payOrDeposit(h.actor, { booking_id: bookingId, idempotency_key: "p1" }, h.signal)) as ConfirmationEnvelope;
    await expect(
      h.engine.payOrDeposit(h.actor, { booking_id: bookingId, idempotency_key: "p1", confirmation_token: env.confirmationToken }, h.signal),
    ).rejects.toSatisfy((e: unknown) => PorterError.is(e) && e.details.reason === "no_payment_method");
  });

  it("sends the business's payout account when Porter knows it", async () => {
    const h = createHarness();
    const bookingId = await book(h);
    const booking = (await h.engine.listMyBookings(h.actor)).bookings[0]!;
    void booking;
    const stored = await h.store.bookings.get(h.actor.id, bookingId);
    h.payouts.set(stored!.adapterId, stored!.providerId, "acct_business_1");

    const env = (await h.engine.payOrDeposit(h.actor, { booking_id: bookingId, idempotency_key: "p1" }, h.signal)) as ConfirmationEnvelope;
    await h.engine.payOrDeposit(h.actor, { booking_id: bookingId, idempotency_key: "p1", confirmation_token: env.confirmationToken }, h.signal);

    expect(h.payments.charges[0]!.destinationAccountRef).toBe("acct_business_1");
  });

  it("sends no personal data to the payment gateway", async () => {
    const h = createHarness();
    const bookingId = await book(h);
    const env = (await h.engine.payOrDeposit(h.actor, { booking_id: bookingId, idempotency_key: "p1" }, h.signal)) as ConfirmationEnvelope;
    await h.engine.payOrDeposit(h.actor, { booking_id: bookingId, idempotency_key: "p1", confirmation_token: env.confirmationToken }, h.signal);

    const blob = JSON.stringify(h.payments.charges);
    expect(blob).not.toContain(TEST_CUSTOMER.email);
    expect(blob).not.toContain(TEST_CUSTOMER.phone);
    expect(blob).not.toContain(TEST_CUSTOMER.addressLine1);
  });
});

describe("cancellation fees", () => {
  it("charges the fee it quoted, and says so", async () => {
    const h = createHarness();
    const bookingId = await book(h); // Stillwater charges a fee on every cancellation
    const env = (await h.engine.cancelBooking(h.actor, { booking_id: bookingId, idempotency_key: "c1" }, h.signal)) as ConfirmationEnvelope;
    expect(env.money.kind).toBe("fee");

    const result = (await h.engine.cancelBooking(h.actor, { booking_id: bookingId, idempotency_key: "c1", confirmation_token: env.confirmationToken }, h.signal)) as any;
    expect(result.fee_charged.amount).toBe(env.money.amount);
    expect(result.fee_uncollected).toBeNull();

    const fee = h.payments.charges.find((c) => c.kind === "cancellation_fee");
    expect(fee!.amount.amount).toBe(env.money.amount);
  });

  it("still cancels when the fee cannot be collected, and reports the debt", async () => {
    const h = createHarness();
    const bookingId = await book(h);
    const env = (await h.engine.cancelBooking(h.actor, { booking_id: bookingId, idempotency_key: "c1" }, h.signal)) as ConfirmationEnvelope;
    h.payments.setNextResult({ status: "failed", reason: "card_declined" });

    const result = (await h.engine.cancelBooking(h.actor, { booking_id: bookingId, idempotency_key: "c1", confirmation_token: env.confirmationToken }, h.signal)) as any;

    // The user asked to cancel and confirmed. Taking the fee and failing to
    // cancel would be the worse outcome, so the cancellation stands.
    expect(result.booking.status).toBe("cancelled");
    expect(result.fee_charged).toBeNull();
    expect(result.fee_uncollected.amount).toBe(env.money.amount);
    expect(result.fee_uncollected.reason).toBe("PAYMENT_REQUIRED");
  });

  it("refunds a deposit when no fee is due", async () => {
    const h = createHarness();
    // Shear Genius is free to cancel outside 24 hours, so the appointment has
    // to be far enough out for that window still to be open.
    const { provider, service } = await firstBookableSlot(h, "beauty.hair.color");
    const { slots } = await h.engine.getAvailability(
      h.actor,
      {
        provider_id: provider.provider_id,
        service_id: service.service_id,
        from: new Date(h.clock.nowMs() + 4 * 86_400_000).toISOString(),
        to: new Date(h.clock.nowMs() + 14 * 86_400_000).toISOString(),
        limit: 5,
      },
      h.signal,
    );
    const far = slots[0]!;
    const env0 = (await h.engine.createBooking(h.actor, { slot_id: far.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "b-color" }, h.signal)) as ConfirmationEnvelope;
    const created = (await h.engine.createBooking(h.actor, { slot_id: far.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "b-color", confirmation_token: env0.confirmationToken }, h.signal)) as any;
    const bookingId = created.booking.booking_id as string;
    const payEnv = (await h.engine.payOrDeposit(h.actor, { booking_id: bookingId, idempotency_key: "p1" }, h.signal)) as ConfirmationEnvelope;
    await h.engine.payOrDeposit(h.actor, { booking_id: bookingId, idempotency_key: "p1", confirmation_token: payEnv.confirmationToken }, h.signal);
    expect(h.payments.charges).toHaveLength(1);

    const env = (await h.engine.cancelBooking(h.actor, { booking_id: bookingId, idempotency_key: "c1" }, h.signal)) as ConfirmationEnvelope;
    const result = (await h.engine.cancelBooking(h.actor, { booking_id: bookingId, idempotency_key: "c1", confirmation_token: env.confirmationToken }, h.signal)) as any;

    expect(result.fee_charged).toBeNull();
    expect(h.payments.refunds).toHaveLength(1);
    const records = await h.store.payments.listForBooking(h.actor.id, bookingId);
    expect(records[0]!.status).toBe("refunded");
  });
});

describe("audit trail and deletion", () => {
  it("records every write, including payments", async () => {
    const h = createHarness();
    const bookingId = await book(h);
    const env = (await h.engine.payOrDeposit(h.actor, { booking_id: bookingId, idempotency_key: "p1" }, h.signal)) as ConfirmationEnvelope;
    await h.engine.payOrDeposit(h.actor, { booking_id: bookingId, idempotency_key: "p1", confirmation_token: env.confirmationToken }, h.signal);

    const { entries } = await h.engine.getAuditTrail(h.actor);
    const tools = entries.map((e) => `${e.tool}:${e.action}`);
    expect(tools).toContain("create_booking:commit");
    expect(tools).toContain("pay_or_deposit:quote");
    expect(tools).toContain("pay_or_deposit:commit");

    // Readable back as a trail without holding any personal data.
    expect(JSON.stringify(entries)).not.toContain(TEST_CUSTOMER.email);
    expect(entries.every((e) => typeof e.latency_ms === "number")).toBe(true);
  });

  it("purges payments and the saved payment method on deletion", async () => {
    const h = createHarness();
    const bookingId = await book(h);
    const env = (await h.engine.payOrDeposit(h.actor, { booking_id: bookingId, idempotency_key: "p1" }, h.signal)) as ConfirmationEnvelope;
    await h.engine.payOrDeposit(h.actor, { booking_id: bookingId, idempotency_key: "p1", confirmation_token: env.confirmationToken }, h.signal);

    const deleted = await h.engine.deleteUserData(h.actor);
    expect(deleted.payments).toBe(1);
    expect(await h.store.paymentProfiles.get(h.actor.id)).toBeNull();
    expect(await h.store.payments.listForUser(h.actor.id)).toHaveLength(0);
    // The audit log survives: it holds no personal data. Terms 4.3(g).
    expect(h.store.auditRows.length).toBeGreaterThan(0);
  });
});

describe("milestone 4 exit criterion", () => {
  it("a paid booking with a deposit, confirmed, fully audited, replay-safe", async () => {
    const h = createHarness();

    // 1. book, with the user confirming the terms
    const { slot } = await firstBookableSlot(h, "massage");
    const bookEnv = (await h.engine.createBooking(h.actor, { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "exit-book" }, h.signal)) as ConfirmationEnvelope;
    expect(bookEnv.money.kind).toBe("deposit");
    const booked = (await h.engine.createBooking(h.actor, { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "exit-book", confirmation_token: bookEnv.confirmationToken }, h.signal)) as any;
    const bookingId = booked.booking.booking_id;

    // 2. pay the deposit, again only after confirming
    const payEnv = (await h.engine.payOrDeposit(h.actor, { booking_id: bookingId, idempotency_key: "exit-pay" }, h.signal)) as ConfirmationEnvelope;
    expect(payEnv.money.kind).toBe("deposit");
    expect(payEnv.nonRefundable).toBe(true);
    const paid = (await h.engine.payOrDeposit(h.actor, { booking_id: bookingId, idempotency_key: "exit-pay", confirmation_token: payEnv.confirmationToken }, h.signal)) as any;
    expect(paid.amount.amount).toBe(3000);

    // 3. replaying the whole call charges nothing further
    const replay = (await h.engine.payOrDeposit(h.actor, { booking_id: bookingId, idempotency_key: "exit-pay", confirmation_token: payEnv.confirmationToken }, h.signal)) as any;
    expect(replay.payment_id).toBe(paid.payment_id);
    expect(h.payments.charges).toHaveLength(1);

    // 4. the whole thing is auditable, with no personal data in the log
    const { entries } = await h.engine.getAuditTrail(h.actor);
    expect(entries.filter((e) => e.action === "commit").length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(entries)).not.toContain(TEST_CUSTOMER.phone);

    // 5. and the payment is visible to the user
    const { payments } = await h.engine.listPayments(h.actor, bookingId);
    expect(payments).toHaveLength(1);
    expect(payments[0]!.kind).toBe("deposit");
    expect(payments[0]!.status).toBe("succeeded");
  });
});
