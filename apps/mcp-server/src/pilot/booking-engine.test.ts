import { describe, expect, it } from "vitest";
import { FakeSquare } from "@porter/adapter-square-appointments/testing";
import { BookingEngine, createSigner, RecordingPaymentGateway, type Actor, type ConfirmationEnvelope, type SlotTokenPayload } from "@porter/core";
import { createMemoryStore, type MerchantCredentials, type PilotBusiness, type PilotStore } from "@porter/db";
import { FixedClock, silentLogger, type HttpClient, type HttpRequest } from "@porter/shared";
import { createPilotSquareAdapter } from "./adapter.js";

const A = "10000000-0000-4000-8000-000000000001";
const B = "10000000-0000-4000-8000-000000000002";
const actorA = { id: "customer-a" };
const actorB = { id: "customer-b" };
const provider = (id: string) => `pilot-square:${id}`;
const service = (id: string) => `${provider(id)}:VAR_CUT_45`;
const CUSTOMER = { givenName: "Porter", phone: "+14155550101" };
const signal = new AbortController().signal;
const NOW = new Date("2026-10-01T08:00:00Z");

function setup() {
  const businesses = new Map<string, PilotBusiness>([A, B].map((id, i) => [id, {
    id, ownerId: `owner-${id}`, name: i === 0 ? "Juniper Salon" : "Magnolia Spa", websiteUrl: "https://salon.example.com/", status: "active", selectedLocationId: "L7GK3M2QWERTY",
    profile: { enabledServiceIds: ["VAR_CUT_45", "VAR_WORKS"], policyReviewed: true, noPaymentObligations: true }, createdAt: NOW, updatedAt: NOW,
  }]));
  const grants = new Map<string, MerchantCredentials>([A, B].map((id) => [id, {
    businessId: id, merchantId: `merchant-${id}`, environment: "sandbox", status: "connected", version: 1, accessToken: `token-${id}`, refreshToken: "refresh", scopes: [],
    expiresAt: new Date("2027-01-01T00:00:00Z"), createdAt: NOW, updatedAt: NOW, refreshedAt: NOW,
  }]));
  const fakes = new Map([A, B].map((id) => [id, new FakeSquare({ accessToken: `token-${id}` })]));
  const requests: HttpRequest[] = [];
  const changes: { duration?: number; price?: number; serviceDuration?: number; policyText?: string; fee?: number; noShowFee?: number; otherStaffFirst?: boolean; unknownPolicy?: boolean } = {};
  const http: HttpClient = { async send(request) {
    requests.push(request);
    const id = request.headers?.authorization?.replace("Bearer token-", "");
    const fake = id ? fakes.get(id) : undefined;
    if (!fake) throw new Error("Wrong merchant routing");
    const response = await fake.send(request);
    const body = structuredClone(response.body) as Record<string, any>;
    if (changes.duration && Array.isArray(body.availabilities)) {
      for (const availability of body.availabilities) availability.appointment_segments[0].duration_minutes = changes.duration;
    }
    if (changes.otherStaffFirst && Array.isArray(body.availabilities) && body.availabilities.length) {
      const sample = body.availabilities[0];
      body.availabilities = [...Array.from({ length: 60 }, (_, i) => ({ ...sample, appointment_segments: [{ ...sample.appointment_segments[0], team_member_id: `OTHER_${i}` }] })), ...body.availabilities];
    }
    if (changes.policyText && body.business_booking_profile) body.business_booking_profile.business_appointment_settings.cancellation_policy_text = changes.policyText;
    if (changes.fee && body.business_booking_profile) {
      body.business_booking_profile.business_appointment_settings.cancellation_fee_money.amount = changes.fee;
      body.business_booking_profile.business_appointment_settings.cancellation_window_seconds = 604_800;
    }
    if (changes.noShowFee && Array.isArray(body.objects)) {
      for (const item of body.objects) {
        for (const variation of item.item_data?.variations ?? []) {
          if (variation.id === "VAR_CUT_45") variation.item_variation_data.no_show_fee = { amount: changes.noShowFee, currency: "USD" };
        }
      }
    }
    if ((changes.price || changes.serviceDuration) && Array.isArray(body.objects)) {
      for (const item of body.objects) {
        for (const variation of item.item_data?.variations ?? []) {
          if (variation.id !== "VAR_CUT_45") continue;
          if (changes.price) variation.item_variation_data.price_money.amount = changes.price;
          if (changes.serviceDuration) variation.item_variation_data.service_duration = changes.serviceDuration * 60_000;
          variation.version++;
        }
      }
    }
    if (changes.unknownPolicy && body.business_booking_profile) {
      const settings = body.business_booking_profile.business_appointment_settings;
      delete settings.cancellation_fee_money;
      delete settings.cancellation_window_seconds;
      delete settings.cancellation_policy_text;
    }
    return { ...response, body };
  } };
  const pilotStore = { businesses: {
    getById: async (id: string) => businesses.get(id) ?? null,
    listActive: async () => [...businesses.values()].filter((business) => business.status === "active"),
  } } as unknown as PilotStore;
  const connections = { credentials: async (id: string) => { const grant = grants.get(id); if (!grant) throw new Error("Disconnected"); return grant; } };
  const adapter = createPilotSquareAdapter({ store: pilotStore, connections, environment: "sandbox", http });
  const store = createMemoryStore();
  const signer = createSigner("pilot-management-tests-signing-secret-0001");
  const payments = new RecordingPaymentGateway();
  const engine = new BookingEngine({ adapters: [adapter], store, signer, clock: new FixedClock(NOW), log: silentLogger, payments });
  return { businesses, grants, fakes, requests, changes, adapter, engine, store, signer, payments };
}
type Harness = ReturnType<typeof setup>;
async function availability(h: Harness, actor: Actor, businessId: string, bookingId?: string) {
  return h.engine.getAvailability({ id: actor.id }, { provider_id: provider(businessId), service_id: service(businessId), from: "2026-10-02T10:00:00Z", to: "2026-10-04T16:00:00Z", limit: 50, ...(bookingId ? { booking_id: bookingId } : {}) }, signal);
}
async function create(h: Harness, actor = actorA, businessId = A, key = "create") {
  const { slots } = await availability(h, actor, businessId);
  const request = { slot_id: slots[0]!.slot_id, customer_details: CUSTOMER, idempotency_key: key };
  const quote = await h.engine.createBooking(actor, request, signal);
  if (quote.status !== "confirmation_required") throw new Error("Expected confirmation");
  const booked = await h.engine.createBooking(actor, { ...request, confirmation_token: quote.confirmationToken }, signal);
  if (booked.status !== "ok") throw new Error("Expected booking");
  const stored = await h.store.bookings.get(actor.id, booked.booking.booking_id);
  if (!stored) throw new Error("Expected stored booking");
  return { booking: booked.booking, stored, originalSlot: slots[0]!, originalToken: h.signer.verify<SlotTokenPayload>(slots[0]!.slot_id) };
}
async function rescheduleQuote(h: Harness, bookingId: string, slotId: string, key = "move"): Promise<ConfirmationEnvelope> {
  const result = await h.engine.rescheduleBooking(actorA, { booking_id: bookingId, new_slot_id: slotId, idempotency_key: key }, signal);
  if (result.status !== "confirmation_required") throw new Error("Expected confirmation");
  return result;
}

describe("pilot booking engine integration", () => {
  it("supports name-only lookup without guessing a service category or enumerating other merchants", async () => {
    const h = setup();
    const result = await h.engine.searchProviders(actorA, { business_name: "Juniper" }, signal);
    expect(result.unmatched_category).toBe(false);
    expect(result.providers.map((entry) => entry.provider_id)).toEqual([provider(A)]);
    expect(result.providers[0]!.services.some((entry) => entry.service_id.endsWith("VAR_WORKS"))).toBe(true);
    expect(h.requests.every((request) => request.headers?.authorization === `Bearer token-${A}`)).toBe(true);
    await expect(h.engine.searchProviders(actorA, {}, signal)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(await h.engine.searchProviders(actorA, { category: "unknown-gibberish", business_name: "Juniper" }, signal)).toMatchObject({ providers: [], unmatched_category: true });
  });

  it("uses targeted service descriptions even when the chosen merchant is beyond ordinary search limits", async () => {
    const h = setup();
    // The description hook must resolve directly, not depend on a search snapshot.
    h.adapter.searchProviders = async () => { throw new Error("Do not enumerate merchants to describe one service"); };
    const created = await create(h);
    expect(created.booking.provider).toBe("Juniper Salon");
  });

  it("isolates two customers and two merchants through availability, booking, listing and management", async () => {
    const h = setup();
    const a = await create(h, actorA, A, "a-create");
    const b = await create(h, actorB, B, "b-create");
    expect(a.stored.providerBookingRef.split(":")[1]).toBe(b.stored.providerBookingRef.split(":")[1]);
    expect(a.stored.providerBookingRef).not.toBe(b.stored.providerBookingRef);
    expect((await h.engine.listMyBookings(actorA)).bookings.map((entry) => entry.booking_id)).toEqual([a.booking.booking_id]);
    expect((await h.engine.listMyBookings(actorB)).bookings.map((entry) => entry.booking_id)).toEqual([b.booking.booking_id]);
    const count = h.requests.length;
    await expect(availability(h, actorB, A, a.booking.booking_id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(h.engine.cancelBooking(actorB, { booking_id: a.booking.booking_id, idempotency_key: "steal" }, signal)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(availability(h, actorA, B, a.booking.booking_id)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(h.requests).toHaveLength(count);
  });

  it("allows owned paused-booking reschedule/cancel while blocking new availability and creation", async () => {
    const h = setup(); const created = await create(h);
    const prior = await availability(h, actorA, A);
    h.businesses.set(A, { ...h.businesses.get(A)!, status: "paused", profile: {} });
    await expect(availability(h, actorA, A)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    await expect(h.engine.createBooking(actorA, { slot_id: prior.slots[0]!.slot_id, customer_details: CUSTOMER, idempotency_key: "paused-new" }, signal)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    const times = await availability(h, actorA, A, created.booking.booking_id);
    expect(times.slots.length).toBeGreaterThan(0);
    for (const slot of times.slots) {
      const token = h.signer.verify<SlotTokenPayload>(slot.slot_id);
      expect(token).toMatchObject({ b: created.booking.booking_id, uid: actorA.id, r: created.originalToken.r });
    }
    const target = times.slots[0]!;
    await expect(h.engine.createBooking(actorA, { slot_id: target.slot_id, customer_details: CUSTOMER, idempotency_key: "management-as-new" }, signal)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const quote = await rescheduleQuote(h, created.booking.booking_id, target.slot_id);
    const moved = await h.engine.rescheduleBooking(actorA, { booking_id: created.booking.booking_id, new_slot_id: target.slot_id, idempotency_key: "move", confirmation_token: quote.confirmationToken }, signal);
    expect(moved.status).toBe("ok");
    const cancellation = await h.engine.cancelBooking(actorA, { booking_id: created.booking.booking_id, idempotency_key: "cancel" }, signal);
    if (cancellation.status !== "confirmation_required") throw new Error("Expected cancel confirmation");
    const cancelled = await h.engine.cancelBooking(actorA, { booking_id: created.booking.booking_id, idempotency_key: "cancel", confirmation_token: cancellation.confirmationToken }, signal);
    expect(cancelled.status).toBe("ok");
    expect((await h.store.bookings.get(actorA.id, created.booking.booking_id))?.status).toBe("cancelled");
    expect(h.fakes.get(A)!.bookings.size).toBe(1);
  });

  it("binds management slots to the original booking even for the same customer", async () => {
    const h = setup(); const first = await create(h); const second = await create(h, actorA, A, "second");
    const times = await availability(h, actorA, A, first.booking.booking_id);
    await expect(h.engine.rescheduleBooking(actorA, { booking_id: second.booking.booking_id, new_slot_id: times.slots[0]!.slot_id, idempotency_key: "wrong-booking" }, signal)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("filters the booked staff member before the upstream availability limit", async () => {
    const h = setup(); const created = await create(h); h.changes.otherStaffFirst = true;
    const times = await availability(h, actorA, A, created.booking.booking_id);
    expect(times.slots.length).toBeGreaterThan(0);
    expect(times.slots.every((slot) => h.signer.verify<SlotTokenPayload>(slot.slot_id).r === created.originalToken.r)).toBe(true);
  });

  it("rejects another staff member before issuing a reschedule confirmation", async () => {
    const h = setup(); const created = await create(h);
    const times = await availability(h, actorA, A);
    const differentStaff = times.slots.find((slot) => h.signer.verify<SlotTokenPayload>(slot.slot_id).r !== created.originalToken.r)!;
    await expect(rescheduleQuote(h, created.booking.booking_id, differentStaff.slot_id)).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    expect(h.requests.some((request) => request.method === "PUT")).toBe(false);
  });

  it("rejects a duration change before confirming or attempting an update", async () => {
    const h = setup(); const created = await create(h); h.changes.duration = 60;
    const times = await availability(h, actorA, A);
    const originalStaff = times.slots.find((slot) => h.signer.verify<SlotTokenPayload>(slot.slot_id).r === created.originalToken.r)!;
    await expect(rescheduleQuote(h, created.booking.booking_id, originalStaff.slot_id)).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    expect((await availability(h, actorA, A, created.booking.booking_id)).slots).toEqual([]);
    expect(h.requests.some((request) => request.method === "PUT")).toBe(false);
  });

  it.each(["fee", "noShowFee"] as const)("rejects a newly unsupported %s before confirming or attempting an update", async (fee) => {
    const h = setup(); const created = await create(h);
    const times = await availability(h, actorA, A, created.booking.booking_id);
    const quote = await rescheduleQuote(h, created.booking.booking_id, times.slots[0]!.slot_id);
    h.changes[fee] = 500;
    await expect(rescheduleQuote(h, created.booking.booking_id, times.slots[0]!.slot_id)).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
    await expect(h.engine.rescheduleBooking(actorA, { booking_id: created.booking.booking_id, new_slot_id: times.slots[0]!.slot_id, idempotency_key: "move", confirmation_token: quote.confirmationToken }, signal)).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
    expect(await h.store.idempotency.get(actorA.id, "reschedule_booking", "move")).toBeNull();
    expect(await h.store.bookingMutations.acquire(actorA.id, created.booking.booking_id, "test", "guard")).toBe(true);
    await h.store.bookingMutations.release(actorA.id, created.booking.booking_id, "test", "guard");
    expect(h.requests.some((request) => request.method === "PUT")).toBe(false);
    expect(h.payments.charges).toEqual([]);
  });

  it("rejects a service no-show fee added after create confirmation without writing or retaining intent", async () => {
    const h = setup();
    const times = await availability(h, actorA, A);
    const request = { slot_id: times.slots[0]!.slot_id, customer_details: CUSTOMER, idempotency_key: "create-fee" };
    const quote = await h.engine.createBooking(actorA, request, signal);
    if (quote.status !== "confirmation_required") throw new Error("Expected create confirmation");
    h.changes.noShowFee = 500;
    await expect(h.engine.createBooking(actorA, { ...request, confirmation_token: quote.confirmationToken }, signal)).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
    expect(await h.store.idempotency.get(actorA.id, "create_booking", request.idempotency_key)).toBeNull();
    expect(h.requests.some((request) => request.method === "POST" && /\/v2\/(?:bookings|customers)$/.test(new URL(request.url).pathname))).toBe(false);
    expect(h.fakes.get(A)!.bookings.size).toBe(0);
    expect(h.payments.charges).toEqual([]);
  });

  it.each(["fee", "noShowFee"] as const)("blocks cancellation with a newly added %s before quote or commit, without charging or stranding guards", async (fee) => {
    const h = setup(); const created = await create(h);
    await h.store.paymentProfiles.put(actorA.id, { customerRef: "customer-profile", paymentMethodRef: "saved-method", label: "Test payment method" });
    const request = { booking_id: created.booking.booking_id, idempotency_key: "cancel" };
    const quote = await h.engine.cancelBooking(actorA, request, signal);
    if (quote.status !== "confirmation_required") throw new Error("Expected cancellation confirmation");
    h.changes[fee] = 500;
    await expect(h.engine.cancelBooking(actorA, { ...request, idempotency_key: "new-quote" }, signal)).rejects.toMatchObject({ code: "POLICY_BLOCKED", message: expect.stringContaining("Contact the salon") });
    await expect(h.engine.cancelBooking(actorA, { ...request, confirmation_token: quote.confirmationToken }, signal)).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
    expect(await h.store.idempotency.get(actorA.id, "cancel_booking", "cancel")).toBeNull();
    expect(await h.store.bookingMutations.acquire(actorA.id, created.booking.booking_id, "test", "guard")).toBe(true);
    await h.store.bookingMutations.release(actorA.id, created.booking.booking_id, "test", "guard");
    expect(h.requests.some((entry) => entry.method === "POST" && entry.url.endsWith("/cancel"))).toBe(false);
    expect(h.payments.charges).toEqual([]);
    expect(await h.store.payments.listForUser(actorA.id)).toEqual([]);
    expect((await h.store.bookings.get(actorA.id, created.booking.booking_id))?.status).toBe("confirmed");
  });

  it.each(["time", "version", "staff", "duration"] as const)("rejects a cancellation confirmation after the provider changes its %s", async (change) => {
    const h = setup(); const created = await create(h);
    h.changes.unknownPolicy = true;
    const request = { booking_id: created.booking.booking_id, idempotency_key: "cancel" };
    const quote = await h.engine.cancelBooking(actorA, request, signal);
    if (quote.status !== "confirmation_required") throw new Error("Expected cancellation confirmation");
    const raw = h.fakes.get(A)!.bookings.get(created.stored.providerBookingRef.split(":")[1]!)!;
    if (change === "time") raw.start_at = "2026-10-05T10:00:00Z";
    else if (change === "version") raw.version++;
    else if (change === "staff") raw.appointment_segments = [{ ...raw.appointment_segments![0]!, team_member_id: "OTHER_STAFF" }];
    else raw.appointment_segments = [{ ...raw.appointment_segments![0]!, duration_minutes: 60 }];
    await expect(h.engine.cancelBooking(actorA, { ...request, confirmation_token: quote.confirmationToken }, signal)).rejects.toMatchObject({ code: "CONFIRMATION_STALE" });
    expect(await h.store.idempotency.get(actorA.id, "cancel_booking", "cancel")).toBeNull();
    expect(await h.store.bookingMutations.acquire(actorA.id, created.booking.booking_id, "test", "guard")).toBe(true);
    await h.store.bookingMutations.release(actorA.id, created.booking.booking_id, "test", "guard");
    expect(h.requests.some((entry) => entry.method === "POST" && entry.url.endsWith("/cancel"))).toBe(false);
    expect(h.payments.charges).toEqual([]);
  });

  it("summarizes current provider time and duration and requires that fresh cancellation confirmation", async () => {
    const h = setup(); const created = await create(h);
    h.changes.unknownPolicy = true;
    const raw = h.fakes.get(A)!.bookings.get(created.stored.providerBookingRef.split(":")[1]!)!;
    raw.start_at = "2026-10-05T10:00:00Z";
    raw.appointment_segments = [{ ...raw.appointment_segments![0]!, duration_minutes: 60 }];
    raw.version++;
    h.businesses.set(A, { ...h.businesses.get(A)!, status: "paused", profile: {} });
    const request = { booking_id: created.booking.booking_id, idempotency_key: "cancel" };
    const quote = await h.engine.cancelBooking(actorA, request, signal);
    if (quote.status !== "confirmation_required") throw new Error("Expected cancellation confirmation");
    expect(quote.summary).toMatchObject({ startsAt: "2026-10-05T10:00:00.000Z", durationMinutes: 60 });
    expect((await h.engine.cancelBooking(actorA, { ...request, confirmation_token: quote.confirmationToken }, signal)).status).toBe("ok");
    expect(await h.store.bookings.get(actorA.id, created.booking.booking_id)).toMatchObject({ startsAt: new Date(raw.start_at), endsAt: new Date("2026-10-05T11:00:00Z"), status: "cancelled" });
  });

  it.each(["state", "fee", "policy"] as const)("blocks cancellation when %s changes after preflight, retaining the conservative guard", async (change) => {
    const h = setup(); const created = await create(h);
    const request = { booking_id: created.booking.booking_id, idempotency_key: "cancel" };
    const quote = await h.engine.cancelBooking(actorA, request, signal);
    if (quote.status !== "confirmation_required") throw new Error("Expected cancellation confirmation");
    const cancel = h.adapter.cancelBooking.bind(h.adapter);
    h.adapter.cancelBooking = async (input, context) => {
      if (change === "state") h.fakes.get(A)!.bookings.get(created.stored.providerBookingRef.split(":")[1]!)!.version++;
      else if (change === "fee") h.changes.noShowFee = 500;
      else h.changes.policyText = "These are updated cancellation instructions.";
      return cancel(input, context);
    };
    await expect(h.engine.cancelBooking(actorA, { ...request, confirmation_token: quote.confirmationToken }, signal)).rejects.toMatchObject({ code: "IDEMPOTENCY_UNCERTAIN" });
    expect(h.requests.some((entry) => entry.method === "POST" && entry.url.endsWith("/cancel"))).toBe(false);
    expect(await h.store.idempotency.get(actorA.id, "cancel_booking", "cancel")).toMatchObject({ state: "uncertain" });
    expect(await h.store.bookingMutations.acquire(actorA.id, created.booking.booking_id, "another", "change")).toBe(false);
    expect(h.payments.charges).toEqual([]);
  });

  it.each(["price", "duration", "policy"] as const)("blocks creation when confirmed %s changes on the final adapter read", async (change) => {
    const h = setup();
    const times = await availability(h, actorA, A);
    const request = { slot_id: times.slots[0]!.slot_id, customer_details: CUSTOMER, idempotency_key: "late-create" };
    const quote = await h.engine.createBooking(actorA, request, signal);
    if (quote.status !== "confirmation_required") throw new Error("Expected confirmation");
    const createBooking = h.adapter.createBooking.bind(h.adapter);
    h.adapter.createBooking = async (input, context) => {
      if (change === "price") h.changes.price = 9900;
      else if (change === "duration") h.changes.serviceDuration = 60;
      else h.changes.policyText = "Updated service booking rules.";
      return createBooking(input, context);
    };
    await expect(h.engine.createBooking(actorA, { ...request, confirmation_token: quote.confirmationToken }, signal)).rejects.toMatchObject({ code: "IDEMPOTENCY_UNCERTAIN" });
    expect(h.requests.some((entry) => entry.method === "POST" && /\/v2\/(?:bookings|customers)$/.test(new URL(entry.url).pathname))).toBe(false);
    expect(h.payments.charges).toEqual([]);
  });

  it.each(["price", "duration", "policy"] as const)("blocks rescheduling when confirmed %s changes on the final adapter read", async (change) => {
    const h = setup(); const created = await create(h);
    const times = await availability(h, actorA, A, created.booking.booking_id);
    const quote = await rescheduleQuote(h, created.booking.booking_id, times.slots[0]!.slot_id);
    const move = h.adapter.rescheduleBooking.bind(h.adapter);
    h.adapter.rescheduleBooking = async (input, context) => {
      if (change === "price") h.changes.price = 9900;
      else if (change === "duration") h.changes.serviceDuration = 60;
      else h.changes.policyText = "Updated service booking rules.";
      return move(input, context);
    };
    await expect(h.engine.rescheduleBooking(actorA, { booking_id: created.booking.booking_id, new_slot_id: times.slots[0]!.slot_id, idempotency_key: "move", confirmation_token: quote.confirmationToken }, signal)).rejects.toMatchObject({ code: "IDEMPOTENCY_UNCERTAIN" });
    expect(h.requests.some((entry) => entry.method === "PUT")).toBe(false);
    expect(await h.store.bookingMutations.acquire(actorA.id, created.booking.booking_id, "another", "change")).toBe(false);
    expect(h.payments.charges).toEqual([]);
  });

  it("keeps missing Square policy fields unknown in reschedule and cancellation summaries", async () => {
    const h = setup(); const created = await create(h);
    h.changes.unknownPolicy = true;
    const times = await availability(h, actorA, A, created.booking.booking_id);
    const move = await rescheduleQuote(h, created.booking.booking_id, times.slots[0]!.slot_id);
    expect(move.cancellationPolicy).toMatchObject({ known: false, freeUntil: null, feeAmount: null, text: null });
    const cancel = await h.engine.cancelBooking(actorA, { booking_id: created.booking.booking_id, idempotency_key: "cancel" }, signal);
    if (cancel.status !== "confirmation_required") throw new Error("Expected cancellation confirmation");
    expect(cancel.cancellationPolicy).toMatchObject({ known: false, freeUntil: null, feeAmount: null, text: null });
    expect(h.payments.charges).toEqual([]);
  });

  it("releases preflight rejections without spending confirmation or stranding a mutation guard", async () => {
    const h = setup(); const created = await create(h);
    const times = await availability(h, actorA, A, created.booking.booking_id); const target = times.slots[0]!;
    const quote = await rescheduleQuote(h, created.booking.booking_id, target.slot_id);
    const raw = h.fakes.get(A)!.bookings.get(created.stored.providerBookingRef.split(":")[1]!)!;
    const original = structuredClone(raw.appointment_segments!);
    raw.appointment_segments = [{ ...original[0]!, team_member_id: "TM_OTHER" }];
    const request = { booking_id: created.booking.booking_id, new_slot_id: target.slot_id, idempotency_key: "move", confirmation_token: quote.confirmationToken };
    await expect(h.engine.rescheduleBooking(actorA, request, signal)).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    expect(await h.store.idempotency.get(actorA.id, "reschedule_booking", "move")).toBeNull();
    expect(await h.store.bookingMutations.acquire(actorA.id, created.booking.booking_id, "test", "guard")).toBe(true);
    await h.store.bookingMutations.release(actorA.id, created.booking.booking_id, "test", "guard");
    expect(h.requests.some((entry) => entry.method === "PUT")).toBe(false);
    raw.appointment_segments = original;
    expect((await h.engine.rescheduleBooking(actorA, request, signal)).status).toBe("ok");
  });

  it.each(["version", "policy"] as const)("rejects changed %s at commit before an upstream write", async (change) => {
    const h = setup(); const created = await create(h);
    const times = await availability(h, actorA, A, created.booking.booking_id); const target = times.slots[0]!;
    const quote = await rescheduleQuote(h, created.booking.booking_id, target.slot_id);
    if (change === "version") h.fakes.get(A)!.bookings.get(created.stored.providerBookingRef.split(":")[1]!)!.version++;
    else h.changes.policyText = "The salon updated its cancellation instructions.";
    await expect(h.engine.rescheduleBooking(actorA, { booking_id: created.booking.booking_id, new_slot_id: target.slot_id, idempotency_key: "move", confirmation_token: quote.confirmationToken }, signal)).rejects.toMatchObject({ code: "CONFIRMATION_STALE" });
    expect(await h.store.idempotency.get(actorA.id, "reschedule_booking", "move")).toBeNull();
    expect(h.requests.some((entry) => entry.method === "PUT")).toBe(false);
  });

  it("rejects disconnected existing-booking management without attempting a write", async () => {
    const h = setup(); const created = await create(h);
    const times = await availability(h, actorA, A, created.booking.booking_id); const target = times.slots[0]!;
    const quote = await rescheduleQuote(h, created.booking.booking_id, target.slot_id);
    h.grants.set(A, { ...h.grants.get(A)!, status: "disconnected" });
    await expect(h.engine.rescheduleBooking(actorA, { booking_id: created.booking.booking_id, new_slot_id: target.slot_id, idempotency_key: "move", confirmation_token: quote.confirmationToken }, signal)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(await h.store.idempotency.get(actorA.id, "reschedule_booking", "move")).toBeNull();
    expect(h.requests.some((entry) => entry.method === "PUT")).toBe(false);
    await expect(h.engine.cancelBooking(actorA, { booking_id: created.booking.booking_id, idempotency_key: "disconnected-cancel" }, signal)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("never overwrites a provider change after preflight and retains the conservative write guard", async () => {
    const h = setup(); const created = await create(h);
    const times = await availability(h, actorA, A, created.booking.booking_id); const target = times.slots[0]!;
    const quote = await rescheduleQuote(h, created.booking.booking_id, target.slot_id);
    const raw = h.fakes.get(A)!.bookings.get(created.stored.providerBookingRef.split(":")[1]!)!;
    const update = h.adapter.rescheduleBooking.bind(h.adapter);
    h.adapter.rescheduleBooking = async (request, context) => { raw.version++; return update(request, context); };
    await expect(h.engine.rescheduleBooking(actorA, { booking_id: created.booking.booking_id, new_slot_id: target.slot_id, idempotency_key: "move", confirmation_token: quote.confirmationToken }, signal)).rejects.toMatchObject({ code: "IDEMPOTENCY_UNCERTAIN" });
    expect(h.requests.some((request) => request.method === "PUT")).toBe(false);
    expect(raw.start_at).toBe(created.originalSlot.starts_at);
    expect(await h.store.idempotency.get(actorA.id, "reschedule_booking", "move")).toMatchObject({ state: "uncertain" });
    expect(await h.store.bookingMutations.acquire(actorA.id, created.booking.booking_id, "another", "change")).toBe(false);
  });
});
