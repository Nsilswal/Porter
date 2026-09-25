import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "@porter/shared";
import { BookingEngine, type BookingResult } from "./engine.js";
import { createSigner } from "./tokens.js";
import { TEST_CUSTOMER, createHarness, firstBookableSlot, type Harness } from "./testing.js";
import type { ConfirmationEnvelope } from "./confirmation.js";

afterEach(() => vi.restoreAllMocks());

async function book(h: Harness) {
  const { slot, slots } = await firstBookableSlot(h);
  const request = { slot_id: slot.slot_id, customer_details: TEST_CUSTOMER, idempotency_key: "book" };
  const confirmation = await h.engine.createBooking(h.actor, request, h.signal) as ConfirmationEnvelope;
  const booked = await h.engine.createBooking(h.actor, { ...request, confirmation_token: confirmation.confirmationToken }, h.signal) as BookingResult;
  return { bookingId: booked.booking.booking_id, slots };
}

async function payment(h: Harness, bookingId: string, key: string) {
  const request = { booking_id: bookingId, idempotency_key: key };
  const confirmation = await h.engine.payOrDeposit(h.actor, request, h.signal) as ConfirmationEnvelope;
  return { ...request, confirmation_token: confirmation.confirmationToken };
}

function anotherEngine(h: Harness) {
  return new BookingEngine({
    adapters: [h.adapter], store: h.store, clock: h.clock, log: silentLogger,
    signer: createSigner("test-signing-secret-that-is-long-enough-000"), payments: h.payments,
  });
}

function gate() {
  let open!: () => void;
  const waiting = new Promise<void>((resolve) => { open = resolve; });
  return { waiting, open };
}

describe("booking mutation serialization", () => {
  it("does not reveal another account's booking through guard errors", async () => {
    const h = createHarness();
    const { bookingId } = await book(h);
    const request = await payment(h, bookingId, "payment");
    const acquire = vi.spyOn(h.store.bookingMutations, "acquire");
    await expect(h.engine.payOrDeposit({ id: "another-user" }, request, h.signal)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(acquire).not.toHaveBeenCalled();
    expect(h.payments.charges).toHaveLength(0);
  });

  it("allows only one concurrent charge across engines and distinct request ids", async () => {
    const h = createHarness();
    const { bookingId } = await book(h);
    const requests = await Promise.all([payment(h, bookingId, "payment-one"), payment(h, bookingId, "payment-two")]);
    const engines = [h.engine, anotherEngine(h)];
    const charge = vi.spyOn(h.payments, "charge");
    const outcomes = await Promise.allSettled(requests.map((request, index) => engines[index]!.payOrDeposit(h.actor, request, h.signal)));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({ reason: { code: "IDEMPOTENCY_UNCERTAIN" } });
    expect(charge).toHaveBeenCalledTimes(1);
  });

  it("blocks payment while cancellation owns the booking, then rechecks cancellation status", async () => {
    const h = createHarness();
    const { bookingId } = await book(h);
    const pay = await payment(h, bookingId, "payment");
    const cancel = { booking_id: bookingId, idempotency_key: "cancel" };
    const confirmation = await h.engine.cancelBooking(h.actor, cancel, h.signal) as ConfirmationEnvelope;
    const entered = gate();
    const resume = gate();
    const original = h.adapter.cancelBooking.bind(h.adapter);
    vi.spyOn(h.adapter, "cancelBooking").mockImplementation(async (...args) => {
      entered.open();
      await resume.waiting;
      return original(...args);
    });
    const running = h.engine.cancelBooking(h.actor, { ...cancel, confirmation_token: confirmation.confirmationToken }, h.signal);
    await entered.waiting;
    try {
      await expect(anotherEngine(h).payOrDeposit(h.actor, pay, h.signal)).rejects.toMatchObject({ code: "IDEMPOTENCY_UNCERTAIN" });
    } finally {
      resume.open();
      await running;
    }
    await expect(h.engine.payOrDeposit(h.actor, pay, h.signal)).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
    expect(h.payments.charges.filter((charge) => charge.kind !== "cancellation_fee")).toHaveLength(0);
  });

  it("blocks payment during rescheduling and invalidates consent to the old appointment afterward", async () => {
    const h = createHarness();
    const { bookingId, slots } = await book(h);
    const pay = await payment(h, bookingId, "payment");
    const move = { booking_id: bookingId, new_slot_id: slots[1]!.slot_id, idempotency_key: "move" };
    const confirmation = await h.engine.rescheduleBooking(h.actor, move, h.signal) as ConfirmationEnvelope;
    const entered = gate();
    const resume = gate();
    const original = h.adapter.rescheduleBooking.bind(h.adapter);
    vi.spyOn(h.adapter, "rescheduleBooking").mockImplementation(async (...args) => {
      entered.open();
      await resume.waiting;
      return original(...args);
    });
    const running = h.engine.rescheduleBooking(h.actor, { ...move, confirmation_token: confirmation.confirmationToken }, h.signal);
    await entered.waiting;
    try {
      await expect(anotherEngine(h).payOrDeposit(h.actor, pay, h.signal)).rejects.toMatchObject({ code: "IDEMPOTENCY_UNCERTAIN" });
    } finally {
      resume.open();
      await running;
    }
    await expect(h.engine.payOrDeposit(h.actor, pay, h.signal)).rejects.toMatchObject({ code: "CONFIRMATION_STALE" });
    expect(h.payments.charges).toHaveLength(0);
  });

  it("rejects an older reschedule confirmation after the source booking has moved", async () => {
    const h = createHarness();
    const { bookingId, slots } = await book(h);
    const first = { booking_id: bookingId, new_slot_id: slots[1]!.slot_id, idempotency_key: "first-move" };
    const second = { booking_id: bookingId, new_slot_id: slots[2]!.slot_id, idempotency_key: "second-move" };
    const firstConfirmation = await h.engine.rescheduleBooking(h.actor, first, h.signal) as ConfirmationEnvelope;
    const secondConfirmation = await h.engine.rescheduleBooking(h.actor, second, h.signal) as ConfirmationEnvelope;
    const write = vi.spyOn(h.adapter, "rescheduleBooking");
    await h.engine.rescheduleBooking(h.actor, { ...first, confirmation_token: firstConfirmation.confirmationToken }, h.signal);
    await expect(h.engine.rescheduleBooking(h.actor, { ...second, confirmation_token: secondConfirmation.confirmationToken }, h.signal))
      .rejects.toMatchObject({ code: "CONFIRMATION_STALE" });
    expect(write).toHaveBeenCalledTimes(1);
    expect((await h.store.bookings.get(h.actor.id, bookingId))?.startsAt.toISOString()).toBe(slots[1]!.starts_at);
  });

  it.each(["timeout", "bank authentication"])("retains the booking guard after %s and blocks a new key", async (failure) => {
    const h = createHarness();
    const { bookingId } = await book(h);
    const first = await payment(h, bookingId, "first");
    const second = await payment(h, bookingId, "second");
    const charge = vi.spyOn(h.payments, "charge");
    if (failure === "timeout") charge.mockRejectedValueOnce(new Error("Acknowledgment lost"));
    else h.payments.setNextResult({ status: "requires_action" });
    await expect(h.engine.payOrDeposit(h.actor, first, h.signal)).rejects.toMatchObject({ code: "IDEMPOTENCY_UNCERTAIN" });
    h.clock.advance(31 * 86_400_000);
    await expect(anotherEngine(h).payOrDeposit(h.actor, second, h.signal)).rejects.toMatchObject({ code: "IDEMPOTENCY_UNCERTAIN" });
    expect(charge).toHaveBeenCalledTimes(1);
  });

  it("cleans a guard left after durable completion by replaying the completed request", async () => {
    const h = createHarness();
    const { bookingId } = await book(h);
    const request = await payment(h, bookingId, "payment");
    vi.spyOn(h.store.bookingMutations, "release").mockRejectedValueOnce(new Error("Cleanup failed"));
    await expect(h.engine.payOrDeposit(h.actor, request, h.signal)).rejects.toMatchObject({ code: "IDEMPOTENCY_UNCERTAIN" });
    expect((await h.store.idempotency.get(h.actor.id, "pay_or_deposit", request.idempotency_key))?.state).toBe("completed");
    expect(await anotherEngine(h).payOrDeposit(h.actor, request, h.signal)).toMatchObject({ status: "ok" });
    expect(await h.store.bookingMutations.acquire(h.actor.id, bookingId, "another", "another")).toBe(true);
    expect(h.payments.charges).toHaveLength(1);
  });

  it("releases prewrite guards before their reservations can be reused", async () => {
    const h = createHarness({ noPaymentMethod: true });
    const { bookingId } = await book(h);
    const request = await payment(h, bookingId, "payment");
    const original = h.store.bookingMutations.release.bind(h.store.bookingMutations);
    vi.spyOn(h.store.bookingMutations, "release").mockImplementation(async (...args) => {
      expect((await h.store.idempotency.get(h.actor.id, "pay_or_deposit", request.idempotency_key))?.state).toBe("in_flight");
      return original(...args);
    });
    await expect(h.engine.payOrDeposit(h.actor, request, h.signal)).rejects.toMatchObject({ code: "PAYMENT_REQUIRED" });
    expect(await h.store.idempotency.get(h.actor.id, "pay_or_deposit", request.idempotency_key)).toBeNull();
    expect(await h.store.bookingMutations.acquire(h.actor.id, bookingId, "another", "another")).toBe(true);
    expect(h.payments.charges).toHaveLength(0);
  });

  it("keeps the reservation when prewrite guard cleanup fails", async () => {
    const h = createHarness({ noPaymentMethod: true });
    const { bookingId } = await book(h);
    const first = await payment(h, bookingId, "first");
    const second = await payment(h, bookingId, "second");
    vi.spyOn(h.store.bookingMutations, "release").mockRejectedValueOnce(new Error("Cleanup failed"));
    await expect(h.engine.payOrDeposit(h.actor, first, h.signal)).rejects.toMatchObject({ code: "IDEMPOTENCY_UNCERTAIN" });
    expect((await h.store.idempotency.get(h.actor.id, "pay_or_deposit", first.idempotency_key))?.state).toBe("in_flight");
    await expect(anotherEngine(h).payOrDeposit(h.actor, second, h.signal)).rejects.toMatchObject({ code: "IDEMPOTENCY_UNCERTAIN" });
    expect(h.payments.charges).toHaveLength(0);
  });
});
