import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger, untrusted } from "@porter/shared";
import { BookingEngine, type BookingResult, type CreateBookingArgs } from "./engine.js";
import { Idempotency } from "./idempotency.js";
import { createSigner } from "./tokens.js";
import { TEST_CUSTOMER, createHarness, firstBookableSlot, type Harness } from "./testing.js";
import type { ConfirmationEnvelope } from "./confirmation.js";

afterEach(() => vi.restoreAllMocks());

async function prepare(h: Harness, overrides: Partial<CreateBookingArgs> = {}, category = "haircut") {
  const { slot } = await firstBookableSlot(h, category);
  const request: CreateBookingArgs = {
    slot_id: slot.slot_id,
    customer_details: TEST_CUSTOMER,
    idempotency_key: "mutation-key",
    ...overrides,
  };
  const envelope = await h.engine.createBooking(h.actor, request, h.signal) as ConfirmationEnvelope;
  return { envelope, request: { ...request, confirmation_token: envelope.confirmationToken } };
}

function restart(h: Harness): BookingEngine {
  return new BookingEngine({
    adapters: [h.adapter], store: h.store, clock: h.clock, log: silentLogger,
    signer: createSigner("test-signing-secret-that-is-long-enough-000"),
    payments: h.payments,
  });
}

describe("confirmation binds the actual request", () => {
  it.each([
    ["customer", { customer_details: { ...TEST_CUSTOMER, email: "someone-else@example.com" } }],
    ["notes", { notes: "Different instructions" }],
    ["quote", { quote_id: "another-quote" }],
  ])("rejects changed %s before any provider mutation", async (_field, change) => {
    const h = createHarness();
    const { request } = await prepare(h);
    const write = vi.spyOn(h.adapter, "createBooking");
    await expect(h.engine.createBooking(h.actor, { ...request, ...change }, h.signal))
      .rejects.toMatchObject({ code: "CONFIRMATION_STALE" });
    expect(write).not.toHaveBeenCalled();
    expect(await h.store.idempotency.get(h.actor.id, "create_booking", request.idempotency_key)).toBeNull();
  });

  it("does not put customer details in the readable signed token", async () => {
    const h = createHarness();
    const { envelope } = await prepare(h, { notes: "Private instructions" });
    const token = Buffer.from(envelope.confirmationToken.split(".")[0]!, "base64url").toString("utf8");
    expect(token).not.toContain(TEST_CUSTOMER.email);
    expect(token).not.toContain(TEST_CUSTOMER.phone);
    expect(token).not.toContain("Private instructions");
    expect(JSON.parse(token).data.requestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(["duration", "staff reference", "price"])("requires fresh consent when %s changes", async (field) => {
    const h = createHarness();
    const { request } = await prepare(h, {}, "massage");
    const check = h.adapter.checkSlot.bind(h.adapter);
    vi.spyOn(h.adapter, "checkSlot").mockImplementation(async (...args) => {
      const slot = await check(...args);
      if (!slot) return slot;
      return {
        ...slot,
        ...(field === "duration" ? { endsAt: new Date(slot.endsAt.getTime() + 60_000) } : {}),
        ...(field === "staff reference" ? { providerSlotRef: "changed-staff" } : {}),
        ...(field === "price" ? { price: { amount: 13000, currency: "USD" } } : {}),
      };
    });
    const write = vi.spyOn(h.adapter, "createBooking");
    await expect(h.engine.createBooking(h.actor, request, h.signal)).rejects.toMatchObject({ code: "CONFIRMATION_STALE" });
    expect(write).not.toHaveBeenCalled();
  });

  it.each(["deadline", "text", "currency", "known"])("requires fresh consent when cancellation policy %s changes", async (field) => {
    const h = createHarness();
    const { request } = await prepare(h);
    const policy = h.adapter.getServiceCancellationPolicy.bind(h.adapter);
    vi.spyOn(h.adapter, "getServiceCancellationPolicy").mockImplementation(async (...args) => {
      const previous = await policy(...args);
      return {
        ...previous,
        ...(field === "deadline" ? { freeUntil: new Date(previous.freeUntil!.getTime() - 60_000) } : {}),
        ...(field === "text" ? { text: untrusted("Additional cancellation conditions apply") } : {}),
        ...(field === "currency" ? { feeAmount: { amount: previous.feeAmount!.amount, currency: "CAD" } } : {}),
        ...(field === "known" ? { known: false } : {}),
      };
    });
    const write = vi.spyOn(h.adapter, "createBooking");
    await expect(h.engine.createBooking(h.actor, request, h.signal)).rejects.toMatchObject({ code: "CONFIRMATION_STALE" });
    expect(write).not.toHaveBeenCalled();
  });

  it("cannot transfer cancellation consent between otherwise identical bookings", async () => {
    const h = createHarness();
    const { request } = await prepare(h);
    const booked = await h.engine.createBooking(h.actor, request, h.signal) as BookingResult;
    const stored = (await h.store.bookings.get(h.actor.id, booked.booking.booking_id))!;
    await h.store.bookings.put({ ...stored, id: "different-booking", providerBookingRef: "different-provider-booking" });
    const envelope = await h.engine.cancelBooking(h.actor, { booking_id: stored.id, reason: "Travel", idempotency_key: "cancel" }, h.signal) as ConfirmationEnvelope;
    const write = vi.spyOn(h.adapter, "cancelBooking");
    for (const change of [{ booking_id: "different-booking", reason: "Travel" }, { booking_id: stored.id, reason: "Different reason" }]) {
      await expect(h.engine.cancelBooking(h.actor, { ...change, idempotency_key: "cancel", confirmation_token: envelope.confirmationToken }, h.signal))
        .rejects.toMatchObject({ code: "CONFIRMATION_STALE" });
    }
    expect(write).not.toHaveBeenCalled();
  });
});

describe("durable mutation outcomes", () => {
  it("replays completed requests after token expiry, retention expiry, and an engine restart without consulting the provider", async () => {
    const h = createHarness();
    const { request } = await prepare(h);
    const first = await h.engine.createBooking(h.actor, request, h.signal);
    h.clock.advance(31 * 86_400_000);
    const read = vi.spyOn(h.adapter, "searchProviders").mockRejectedValue(new Error("Provider unavailable"));
    const write = vi.spyOn(h.adapter, "createBooking");
    expect(await restart(h).createBooking(h.actor, request, h.signal)).toEqual(first);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it.each(["provider timeout", "booking persistence", "result persistence"])("preserves uncertainty after %s and never resends on retry", async (failure) => {
    const h = createHarness();
    const { request } = await prepare(h);
    const write = vi.spyOn(h.adapter, "createBooking");
    if (failure === "provider timeout") write.mockRejectedValueOnce(new Error("Acknowledgment lost"));
    if (failure === "booking persistence") vi.spyOn(h.store.bookings, "put").mockRejectedValueOnce(new Error("DB unavailable"));
    if (failure === "result persistence") vi.spyOn(h.store.idempotency, "complete").mockRejectedValueOnce(new Error("DB unavailable"));

    await expect(h.engine.createBooking(h.actor, request, h.signal)).rejects.toMatchObject({ code: "IDEMPOTENCY_UNCERTAIN" });
    const record = await h.store.idempotency.get(h.actor.id, "create_booking", request.idempotency_key);
    expect(record?.state).toBe("uncertain");
    expect(record?.operation).toMatchObject({ adapterId: h.adapter.id, providerOperation: "create" });
    expect(record?.operation?.idempotencyKey).toHaveLength(45);

    h.clock.advance(31 * 86_400_000);
    await expect(restart(h).createBooking(h.actor, request, h.signal)).rejects.toMatchObject({ code: "IDEMPOTENCY_UNCERTAIN" });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("does not send a provider write when the durable marker fails", async () => {
    const h = createHarness();
    const { request } = await prepare(h);
    vi.spyOn(h.store.idempotency, "markUncertain").mockRejectedValueOnce(new Error("DB unavailable"));
    const hold = vi.spyOn(h.adapter, "holdSlot");
    const write = vi.spyOn(h.adapter, "createBooking");
    await expect(h.engine.createBooking(h.actor, request, h.signal)).rejects.toMatchObject({ code: "IDEMPOTENCY_UNCERTAIN" });
    expect(hold).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect((await h.store.idempotency.get(h.actor.id, "create_booking", request.idempotency_key))?.state).toBe("in_flight");
  });

  it("releases failures before the write boundary for safe retry", async () => {
    const h = createHarness();
    const { request } = await prepare(h);
    vi.spyOn(h.adapter, "searchProviders").mockRejectedValueOnce(new Error("Temporary read failure"));
    const write = vi.spyOn(h.adapter, "createBooking");
    await expect(h.engine.createBooking(h.actor, request, h.signal)).rejects.toThrow("Temporary read failure");
    expect(await h.store.idempotency.get(h.actor.id, "create_booking", request.idempotency_key)).toBeNull();
    expect(await h.engine.createBooking(h.actor, request, h.signal)).toMatchObject({ status: "ok" });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("preserves expired in-flight reservations instead of resending them", async () => {
    const h = createHarness();
    const idem = new Idempotency(h.store.idempotency, h.store.keys, h.clock, { ttlMs: 1 });
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    const first = idem.run(h.actor.id, "create_booking", "slow", {}, async () => { await waiting; return "original"; });
    h.clock.advance(2);
    const duplicate = vi.fn(async () => "duplicate");
    await expect(idem.run(h.actor.id, "create_booking", "slow", {}, duplicate)).rejects.toMatchObject({ code: "IDEMPOTENCY_UNCERTAIN" });
    expect(duplicate).not.toHaveBeenCalled();
    finish();
    expect(await first).toBe("original");
  });

  it("namespaces provider keys by account even when callers choose identical keys", async () => {
    const h = createHarness();
    const first = await prepare(h, { idempotency_key: "same-caller-key" });
    const write = vi.spyOn(h.adapter, "createBooking");
    await h.engine.createBooking(h.actor, first.request, h.signal);
    const otherActor = { id: "another-user" };
    const second = await prepare({ ...h, actor: otherActor }, { idempotency_key: "same-caller-key" });
    await h.engine.createBooking(otherActor, second.request, h.signal);
    const keys = write.mock.calls.map(([request]) => request.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    expect(keys.every((key) => key.length === 45)).toBe(true);
  });

  it("does not allow an uncertain confirmation to cause another write under a new request id", async () => {
    const h = createHarness();
    const { request } = await prepare(h);
    const write = vi.spyOn(h.adapter, "createBooking").mockRejectedValueOnce(new Error("Acknowledgment lost"));
    await expect(h.engine.createBooking(h.actor, request, h.signal)).rejects.toMatchObject({ code: "IDEMPOTENCY_UNCERTAIN" });
    await expect(h.engine.createBooking(h.actor, { ...request, idempotency_key: "different-key" }, h.signal))
      .rejects.toMatchObject({ code: "CONFIRMATION_EXPIRED" });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("replays a settled payment even when nothing remains due", async () => {
    const h = createHarness();
    const { request } = await prepare(h);
    const booking = await h.engine.createBooking(h.actor, request, h.signal) as BookingResult;
    const payment = { booking_id: booking.booking.booking_id, idempotency_key: "payment" };
    const envelope = await h.engine.payOrDeposit(h.actor, payment, h.signal) as ConfirmationEnvelope;
    const commit = { ...payment, confirmation_token: envelope.confirmationToken };
    const first = await h.engine.payOrDeposit(h.actor, commit, h.signal);
    h.clock.advance(11 * 60_000);
    expect(await restart(h).payOrDeposit(h.actor, commit, h.signal)).toEqual(first);
    expect(h.payments.charges).toHaveLength(1);
  });

  it.each(["failed", "requires_action"] as const)("does not repeat a %s payment at the gateway", async (status) => {
    const h = createHarness();
    const { request } = await prepare(h);
    const booking = await h.engine.createBooking(h.actor, request, h.signal) as BookingResult;
    const payment = { booking_id: booking.booking.booking_id, idempotency_key: "payment" };
    const envelope = await h.engine.payOrDeposit(h.actor, payment, h.signal) as ConfirmationEnvelope;
    h.payments.setNextResult({ status, reason: "card_declined" });
    const commit = { ...payment, confirmation_token: envelope.confirmationToken };
    const code = status === "requires_action" ? "IDEMPOTENCY_UNCERTAIN" : "PAYMENT_REQUIRED";
    await expect(h.engine.payOrDeposit(h.actor, commit, h.signal)).rejects.toMatchObject({ code });
    h.clock.advance(11 * 60_000);
    await expect(restart(h).payOrDeposit(h.actor, commit, h.signal)).rejects.toMatchObject({ code });
    expect(h.payments.charges).toHaveLength(1);
    expect((await h.store.idempotency.get(h.actor.id, "pay_or_deposit", payment.idempotency_key))?.state).toBe(status === "requires_action" ? "uncertain" : "completed");
  });

  it("keeps the cancellation visible while an unacknowledged fee charge needs reconciliation", async () => {
    const h = createHarness();
    const { request } = await prepare(h, {}, "massage");
    const booked = await h.engine.createBooking(h.actor, request, h.signal) as BookingResult;
    const cancel = { booking_id: booked.booking.booking_id, idempotency_key: "cancel" };
    const envelope = await h.engine.cancelBooking(h.actor, cancel, h.signal) as ConfirmationEnvelope;
    const charge = vi.spyOn(h.payments, "charge").mockRejectedValueOnce(new Error("Acknowledgment lost"));
    const write = vi.spyOn(h.adapter, "cancelBooking");
    const commit = { ...cancel, confirmation_token: envelope.confirmationToken };
    await expect(h.engine.cancelBooking(h.actor, commit, h.signal)).rejects.toMatchObject({ code: "IDEMPOTENCY_UNCERTAIN" });
    expect((await h.store.bookings.get(h.actor.id, cancel.booking_id))?.status).toBe("cancelled");
    await expect(h.engine.cancelBooking(h.actor, commit, h.signal)).rejects.toMatchObject({ code: "IDEMPOTENCY_UNCERTAIN" });
    expect(charge).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it.each(["pending", "failed"] as const)("does not label a %s refund as completed or send it again", async (status) => {
    const h = createHarness();
    const { request } = await prepare(h);
    const booked = await h.engine.createBooking(h.actor, request, h.signal) as BookingResult;
    const payment = { booking_id: booked.booking.booking_id, idempotency_key: "payment" };
    const payEnvelope = await h.engine.payOrDeposit(h.actor, payment, h.signal) as ConfirmationEnvelope;
    await h.engine.payOrDeposit(h.actor, { ...payment, confirmation_token: payEnvelope.confirmationToken }, h.signal);
    vi.spyOn(h.adapter, "getCancellationPolicy").mockResolvedValue({ known: true, freeUntil: null, feeAmount: null, text: null });
    const cancel = { booking_id: booked.booking.booking_id, idempotency_key: "cancel" };
    const envelope = await h.engine.cancelBooking(h.actor, cancel, h.signal) as ConfirmationEnvelope;
    const refund = vi.spyOn(h.payments, "refund").mockResolvedValue({ refundId: "refund", status, amount: { amount: payEnvelope.money.amount, currency: "USD" } });
    const commit = { ...cancel, confirmation_token: envelope.confirmationToken };
    await expect(h.engine.cancelBooking(h.actor, commit, h.signal)).rejects.toMatchObject({ code: "IDEMPOTENCY_UNCERTAIN" });
    expect((await h.store.payments.listForBooking(h.actor.id, cancel.booking_id))[0]?.status).toBe("succeeded");
    await expect(h.engine.cancelBooking(h.actor, commit, h.signal)).rejects.toMatchObject({ code: "IDEMPOTENCY_UNCERTAIN" });
    expect(refund).toHaveBeenCalledTimes(1);
  });
});
