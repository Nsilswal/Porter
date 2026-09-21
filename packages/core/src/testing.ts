import { FixedClock, createLogger, silentLogger } from "@porter/shared";
import { createMockAdapter, type MockAdapter } from "@porter/adapter-mock";
import { createMemoryStore, type MemoryStore } from "@porter/db";
import { BookingEngine } from "./engine.js";
import { MemoryPayoutDirectory, RecordingPaymentGateway } from "./payments.js";
import { RateLimiter } from "./ratelimit.js";
import { createSigner } from "./tokens.js";
import type { Actor } from "./engine.js";

/**
 * Test harness. Deterministic clock, in-memory store, seeded mock adapter.
 * Exported from the package so the MCP app's tests can use it too.
 */
export interface Harness {
  readonly engine: BookingEngine;
  readonly adapter: MockAdapter;
  readonly store: MemoryStore;
  readonly clock: FixedClock;
  readonly payments: RecordingPaymentGateway;
  readonly payouts: MemoryPayoutDirectory;
  readonly actor: Actor;
  readonly signal: AbortSignal;
}

export function createHarness(options: { now?: string; adapter?: MockAdapter; verbose?: boolean; noPaymentMethod?: boolean } = {}): Harness {
  const clock = new FixedClock(new Date(options.now ?? "2026-10-01T12:00:00.000Z"));
  const adapter = options.adapter ?? createMockAdapter({ seed: 42 });
  const store = createMemoryStore();
  const payments = new RecordingPaymentGateway();
  const payouts = new MemoryPayoutDirectory();

  const engine = new BookingEngine({
    adapters: [adapter],
    store,
    clock,
    log: options.verbose ? createLogger({ level: "debug" }) : silentLogger,
    signer: createSigner("test-signing-secret-that-is-long-enough-000"),
    limiter: new RateLimiter(clock, {
      perUser: { capacity: 10_000, refillPerSecond: 1000 },
      perAdapter: {},
      defaultAdapter: { capacity: 10_000, refillPerSecond: 1000 },
    }),
    payments,
    payouts,
  });

  const actor: Actor = { id: "user_test" };
  if (!options.noPaymentMethod) {
    // A saved payment method, the way a real user would have one. Porter
    // stores references only; it never sees card details.
    void store.paymentProfiles.put(actor.id, {
      customerRef: "cus_test_1",
      paymentMethodRef: "pm_test_1",
      label: "Visa ending 4242",
    });
  }

  return { engine, adapter, store, clock, payments, payouts, actor, signal: new AbortController().signal };
}

/** Search, take the first slot, and return everything needed to book it. */
export async function firstBookableSlot(h: Harness, category = "haircut") {
  const { providers } = await h.engine.searchProviders(h.actor, { category, limit: 5 }, h.signal);
  const provider = providers.find((p) => p.services.some((s) => !s.quote_required));
  if (!provider) throw new Error("no bookable provider in fixtures");
  const service = provider.services.find((s) => !s.quote_required)!;

  const from = new Date(h.clock.nowMs() + 60 * 60_000).toISOString();
  const to = new Date(h.clock.nowMs() + 14 * 24 * 60 * 60_000).toISOString();
  const { slots } = await h.engine.getAvailability(
    h.actor,
    { provider_id: provider.provider_id, service_id: service.service_id, from, to, limit: 10 },
    h.signal,
  );
  if (slots.length === 0) throw new Error("no availability in fixtures");
  return { provider, service, slots, slot: slots[0]! };
}

export const TEST_CUSTOMER = {
  givenName: "Sam",
  familyName: "Rivera",
  email: "sam@example.com",
  phone: "555-0100",
  addressLine1: "12 Oak St",
  city: "Oakland",
  region: "CA",
  postalCode: "94610",
};
