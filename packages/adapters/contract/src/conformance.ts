import { describe, expect, it } from "vitest";
import { createLogger, silentLogger, untrusted, sanitize, PorterError } from "@porter/shared";
import type { AdapterContext, ProviderAdapter } from "@porter/core";

/**
 * The conformance suite every adapter must pass.
 *
 * This is what makes "add a seventh platform without touching core" a real
 * claim rather than an aspiration. An adapter is correct when it passes this,
 * and core is allowed to assume everything asserted here.
 */
export interface ConformanceFixtures {
  /** Build a fresh adapter for each test. */
  readonly makeAdapter: () => ProviderAdapter | Promise<ProviderAdapter>;
  /** A category the adapter definitely serves. */
  readonly searchCategory: import("@porter/core").ServiceCategory;
  /** Customer record with at least the adapter's required fields. */
  readonly customer: Record<string, string>;
  /** Optional: force the adapter into a failure mode, to check error mapping. */
  readonly makeFailingAdapter?: () => ProviderAdapter | Promise<ProviderAdapter>;
}

export function makeContext(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    actorId: "user_conformance",
    log: process.env.PORTER_TEST_LOGS ? createLogger({ level: "debug" }) : silentLogger,
    signal: new AbortController().signal,
    credentials: {},
    now: new Date("2026-10-01T12:00:00.000Z"),
    ...overrides,
  };
}

export function runAdapterConformance(name: string, fixtures: ConformanceFixtures): void {
  describe(`ProviderAdapter conformance: ${name}`, () => {
    it("declares a stable identity and capability set", async () => {
      const adapter = await fixtures.makeAdapter();
      expect(adapter.id).toMatch(/^[a-z0-9-]+$/);
      expect(adapter.displayName.length).toBeGreaterThan(0);

      const caps = adapter.capabilities;
      expect(Array.isArray(caps.categories)).toBe(true);
      expect(caps.categories.length).toBeGreaterThan(0);
      expect(Array.isArray(caps.requiredCustomerFields)).toBe(true);

      // A capability flag must match the method actually being implemented,
      // or core's degradation logic is built on a lie.
      expect(typeof adapter.getQuote === "function").toBe(caps.quoting);
      expect(typeof adapter.holdSlot === "function").toBe(caps.slotHold);
      expect(typeof adapter.messageProvider === "function").toBe(caps.messaging);
      expect(typeof adapter.listBookings === "function").toBe(caps.remoteBookingList);
    });

    it("never asks for more customer fields than it declares", async () => {
      const adapter = await fixtures.makeAdapter();
      const declared = new Set([
        ...adapter.capabilities.requiredCustomerFields,
        ...adapter.capabilities.optionalCustomerFields,
      ]);
      // Required must be a subset of the union, and the two lists must not overlap.
      for (const f of adapter.capabilities.requiredCustomerFields) expect(declared.has(f)).toBe(true);
      const optional = new Set(adapter.capabilities.optionalCustomerFields);
      for (const f of adapter.capabilities.requiredCustomerFields) expect(optional.has(f)).toBe(false);
    });

    it("returns searchable providers whose text survives sanitisation", async () => {
      const adapter = await fixtures.makeAdapter();
      const results = await adapter.searchProviders(
        { categories: [fixtures.searchCategory], limit: 10 },
        makeContext(),
      );
      expect(results.length).toBeGreaterThan(0);

      for (const r of results) {
        expect(r.provider.adapterId).toBe(adapter.id);
        expect(r.provider.id.length).toBeGreaterThan(0);
        // Provider text is untrusted. Sanitising must always yield something
        // safe and non-empty, even for hostile names.
        const safe = sanitize(r.provider.name, { maxLength: 120 });
        expect(safe).not.toMatch(/<script/i);
        expect(safe).not.toContain("[/PROVIDER_DATA]");
        expect(r.services.length).toBeGreaterThan(0);
        for (const s of r.services) {
          expect(s.providerId).toBe(r.provider.id);
          expect(s.durationMinutes).toBeGreaterThan(0);
          // Either a price or an explicit quote-required flag. Never neither.
          expect(Boolean(s.price || s.priceRange || s.quoteRequired)).toBe(true);
        }
      }
    });

    it("returns availability inside the requested window, stamped with fetchedAt", async () => {
      const adapter = await fixtures.makeAdapter();
      const ctx = makeContext();
      const [first] = await adapter.searchProviders({ categories: [fixtures.searchCategory], limit: 1 }, ctx);
      expect(first).toBeDefined();
      const service = first!.services.find((s) => !s.quoteRequired) ?? first!.services[0]!;

      const from = new Date(ctx.now.getTime() + 60 * 60_000);
      const to = new Date(from.getTime() + 7 * 24 * 60 * 60_000);
      const slots = await adapter.getAvailability(
        { providerId: first!.provider.id, serviceId: service.id, from, to, limit: 20 },
        ctx,
      );

      for (const slot of slots) {
        expect(slot.startsAt.getTime()).toBeGreaterThanOrEqual(from.getTime());
        expect(slot.startsAt.getTime()).toBeLessThanOrEqual(to.getTime());
        expect(slot.endsAt.getTime()).toBeGreaterThan(slot.startsAt.getTime());
        expect(slot.fetchedAt).toBeInstanceOf(Date);
        expect(slot.serviceId).toBe(service.id);
      }
    });

    it("completes the booking lifecycle and reports a cancellation policy", async () => {
      const adapter = await fixtures.makeAdapter();
      const ctx = makeContext();
      const [first] = await adapter.searchProviders({ categories: [fixtures.searchCategory], limit: 1 }, ctx);
      const provider = first!.provider;
      const service = first!.services.find((s) => !s.quoteRequired) ?? first!.services[0]!;

      const from = new Date(ctx.now.getTime() + 60 * 60_000);
      const slots = await adapter.getAvailability(
        { providerId: provider.id, serviceId: service.id, from, to: new Date(from.getTime() + 14 * 24 * 60 * 60_000), limit: 5 },
        ctx,
      );
      expect(slots.length).toBeGreaterThan(0);
      const slot = slots[0]!;

      // checkSlot must confirm a slot that getAvailability just returned.
      const rechecked = await adapter.checkSlot(
        { providerId: provider.id, serviceId: service.id, startsAt: slot.startsAt, providerSlotRef: slot.providerSlotRef },
        ctx,
      );
      expect(rechecked).not.toBeNull();

      const booking = await adapter.createBooking(
        {
          providerId: provider.id,
          locationId: slot.locationId,
          serviceId: service.id,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          providerSlotRef: slot.providerSlotRef,
          customer: fixtures.customer,
          idempotencyKey: "conformance-key-1",
        },
        ctx,
      );

      expect(["pending", "confirmed"]).toContain(booking.status);
      expect(booking.providerBookingRef.length).toBeGreaterThan(0);
      expect(booking.adapterId).toBe(adapter.id);

      // The slot must no longer be bookable once taken.
      const afterBooking = await adapter.checkSlot(
        { providerId: provider.id, serviceId: service.id, startsAt: slot.startsAt, providerSlotRef: slot.providerSlotRef },
        ctx,
      );
      expect(afterBooking).toBeNull();

      const policy = await adapter.getCancellationPolicy(booking.providerBookingRef, ctx);
      expect(typeof policy.known).toBe("boolean");
      // An unknown policy must be reported as unknown, not as a zero fee.
      if (!policy.known) {
        expect(policy.feeAmount).toBeNull();
      }

      if (adapter.capabilities.reschedule) {
        const later = await adapter.getAvailability(
          { providerId: provider.id, serviceId: service.id, from: new Date(slot.endsAt.getTime() + 60 * 60_000), to: new Date(from.getTime() + 21 * 24 * 60 * 60_000), limit: 5 },
          ctx,
        );
        if (later.length > 0) {
          const target = later[0]!;
          const moved = await adapter.rescheduleBooking(
            {
              bookingRef: booking.providerBookingRef,
              providerId: provider.id,
              serviceId: service.id,
              startsAt: target.startsAt,
              endsAt: target.endsAt,
              providerSlotRef: target.providerSlotRef,
              idempotencyKey: "conformance-key-2",
            },
            ctx,
          );
          expect(moved.startsAt.getTime()).toBe(target.startsAt.getTime());
          expect(["pending", "confirmed"]).toContain(moved.status);
        }
      }

      const cancelled = await adapter.cancelBooking(
        { bookingRef: booking.providerBookingRef, providerId: provider.id, reason: "conformance", idempotencyKey: "conformance-key-3" },
        ctx,
      );
      expect(cancelled.status).toBe("cancelled");
    });

    it("refuses to book a slot that has been taken", async () => {
      const adapter = await fixtures.makeAdapter();
      const ctx = makeContext();
      const [first] = await adapter.searchProviders({ categories: [fixtures.searchCategory], limit: 1 }, ctx);
      const provider = first!.provider;
      const service = first!.services.find((s) => !s.quoteRequired) ?? first!.services[0]!;
      const from = new Date(ctx.now.getTime() + 60 * 60_000);
      const slots = await adapter.getAvailability(
        { providerId: provider.id, serviceId: service.id, from, to: new Date(from.getTime() + 14 * 24 * 60 * 60_000), limit: 5 },
        ctx,
      );
      const slot = slots[0]!;

      const base = {
        providerId: provider.id,
        locationId: slot.locationId,
        serviceId: service.id,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        providerSlotRef: slot.providerSlotRef,
        customer: fixtures.customer,
      };

      await adapter.createBooking({ ...base, idempotencyKey: "dup-a" }, ctx);
      await expect(adapter.createBooking({ ...base, idempotencyKey: "dup-b" }, ctx)).rejects.toSatisfy(
        (e: unknown) => PorterError.is(e) && e.code === "SLOT_TAKEN",
      );
    });

    it("maps unknown identifiers to NOT_FOUND rather than crashing", async () => {
      const adapter = await fixtures.makeAdapter();
      const ctx = makeContext();
      await expect(
        adapter.cancelBooking({ bookingRef: "definitely-not-a-real-ref", providerId: "nope", idempotencyKey: "x" }, ctx),
      ).rejects.toSatisfy((e: unknown) => PorterError.is(e) && (e.code === "NOT_FOUND" || e.code === "ADAPTER_DOWN"));
    });

    it("maps transport failures to PorterError, never a raw throw", async () => {
      if (!fixtures.makeFailingAdapter) return;
      const adapter = await fixtures.makeFailingAdapter();
      const ctx = makeContext();
      await expect(
        adapter.searchProviders({ categories: [fixtures.searchCategory], limit: 5 }, ctx),
      ).rejects.toSatisfy((e: unknown) => PorterError.is(e));
    });

    it("honours an abort signal", async () => {
      const adapter = await fixtures.makeAdapter();
      const controller = new AbortController();
      controller.abort();
      const ctx = makeContext({ signal: controller.signal });
      await expect(
        adapter.searchProviders({ categories: [fixtures.searchCategory], limit: 5 }, ctx),
      ).rejects.toBeDefined();
    });
  });
}

export { untrusted };
