import { describe, expect, it } from "vitest";
import { BookingEngine, RateLimiter, createSigner, type Actor } from "@porter/core";
import { FixedClock, silentLogger, PorterError } from "@porter/shared";
import { createMemoryStore } from "@porter/db";
import { createMockAdapter } from "@porter/adapter-mock";
import { createSquareAdapter } from "@porter/adapter-square-appointments";
import { FakeSquare, SQUARE_TEST_TOKEN } from "@porter/adapter-square-appointments/testing";
import { createJobberAdapter } from "@porter/adapter-jobber";
import { FakeJobber, JOBBER_TEST_TOKEN } from "@porter/adapter-jobber/testing";
import type { ConfirmationEnvelope } from "@porter/core";

/**
 * Three platforms behind one engine.
 *
 * This is the milestone 3 claim made concrete: core routes across a
 * slot-based platform (Square), a request-based one (Jobber) and the mock,
 * with no platform-specific code in the engine. Every difference between them
 * is carried by the capability flags.
 */
function harness() {
  const clock = new FixedClock(new Date("2026-10-01T12:00:00.000Z"));
  const store = createMemoryStore();
  const squareHttp = new FakeSquare();
  const jobberHttp = new FakeJobber();

  const engine = new BookingEngine({
    adapters: [
      createMockAdapter({ seed: 42 }),
      createSquareAdapter({ http: squareHttp }),
      createJobberAdapter({ http: jobberHttp }),
    ],
    credentials: {
      square: { accessToken: SQUARE_TEST_TOKEN },
      jobber: { accessToken: JOBBER_TEST_TOKEN },
    },
    store,
    clock,
    log: silentLogger,
    signer: createSigner("multi-adapter-test-secret-long-enough-01"),
    limiter: new RateLimiter(clock, {
      perUser: { capacity: 10_000, refillPerSecond: 1000 },
      perAdapter: {},
      defaultAdapter: { capacity: 10_000, refillPerSecond: 1000 },
    }),
  });

  const actor: Actor = { id: "user_multi" };
  return { engine, actor, clock, store, squareHttp, jobberHttp, signal: new AbortController().signal };
}

const isEnvelope = (v: unknown): v is ConfirmationEnvelope =>
  typeof v === "object" && v !== null && (v as any).status === "confirmation_required";

describe("multi-adapter routing", () => {
  it("searches only the platforms that serve a category", async () => {
    const h = harness();

    // Beauty: mock and Square, never Jobber.
    const beauty = await h.engine.searchProviders(h.actor, { category: "haircut", limit: 25 }, h.signal);
    const beautyAdapters = new Set(beauty.providers.map((p) => p.provider_id.split(":")[0]));
    expect(beautyAdapters.has("jobber")).toBe(false);
    expect(beautyAdapters.has("square")).toBe(true);

    // Home trades: mock and Jobber, never Square.
    const home = await h.engine.searchProviders(h.actor, { category: "plumber", limit: 25 }, h.signal);
    const homeAdapters = new Set(home.providers.map((p) => p.provider_id.split(":")[0]));
    expect(homeAdapters.has("square")).toBe(false);
    expect(homeAdapters.has("jobber")).toBe(true);
  });

  it("books through Square and Jobber in the same session", async () => {
    const h = harness();

    const square = await bookThrough(h, "haircut", "square", {
      givenName: "Sam",
      familyName: "Rivera",
      email: "sam@example.com",
      phone: "+14155550100",
    });
    // Square confirms immediately.
    expect(square.booking.status).toBe("confirmed");

    const jobber = await bookThrough(h, "drain", "jobber", {
      givenName: "Sam",
      familyName: "Rivera",
      email: "sam@example.com",
      phone: "555-0100",
      addressLine1: "12 Oak St",
      city: "Oakland",
      region: "CA",
      postalCode: "94610",
    });
    // Jobber cannot: the business still has to schedule it.
    expect(jobber.booking.status).toBe("pending");

    const { bookings } = await h.engine.listMyBookings(h.actor);
    expect(bookings).toHaveLength(2);
  });

  it("gives each adapter only the customer fields it declared", async () => {
    const h = harness();
    const customer = {
      givenName: "Sam",
      familyName: "Rivera",
      email: "sam@example.com",
      phone: "+14155550100",
      addressLine1: "12 Oak St",
      city: "Oakland",
      region: "CA",
      postalCode: "94610",
      notes: "gate code 1234",
    };

    await bookThrough(h, "haircut", "square", customer);
    await bookThrough(h, "drain", "jobber", customer);

    // Square requires name and phone; email is optional. Address stays local.
    const squareCustomer = h.squareHttp.requests.find((r) => r.method === "POST" && r.path === "/v2/customers");
    expect(Object.keys(squareCustomer!.body as object).sort()).toEqual(["email_address", "family_name", "given_name", "idempotency_key", "phone_number"]);

    // Jobber needs the address, because someone drives to it.
    const jobberProperty = h.jobberHttp.operations.find((o) => o.name === "PorterPropertyCreate");
    expect((jobberProperty!.variables.input as any).address.street1).toBe("12 Oak St");

    // Neither platform receives a field it did not ask for.
    const squareBlob = JSON.stringify(h.squareHttp.requests);
    expect(squareBlob).not.toContain("12 Oak St");
    expect(squareBlob).not.toContain("gate code");
  });

  it("shows a real Square policy and an unknown Jobber one", async () => {
    const h = harness();

    const square = await bookThrough(h, "haircut", "square", { givenName: "Sam", email: "sam@example.com", phone: "+14155550100" });
    const squareCancel = (await h.engine.cancelBooking(h.actor, { booking_id: square.booking.booking_id, idempotency_key: "c-sq" }, h.signal)) as ConfirmationEnvelope;
    expect(squareCancel.cancellationPolicy.known).toBe(true);
    expect(squareCancel.cancellationPolicy.feeAmount).toBeNull();

    const jobber = await bookThrough(h, "drain", "jobber", {
      givenName: "Sam",
      phone: "555-0100",
      addressLine1: "12 Oak St",
      city: "Oakland",
      postalCode: "94610",
    });
    const jobberCancel = (await h.engine.cancelBooking(h.actor, { booking_id: jobber.booking.booking_id, idempotency_key: "c-jb" }, h.signal)) as ConfirmationEnvelope;
    // Jobber publishes no policy, so the user is told that rather than
    // being told cancellation is free.
    expect(jobberCancel.cancellationPolicy.known).toBe(false);
    expect(jobberCancel.humanSummary).toContain("not published");
  });

  it("degrades when a platform lacks a capability", async () => {
    const h = harness();
    const jobber = await bookThrough(h, "drain", "jobber", {
      givenName: "Sam",
      phone: "555-0100",
      addressLine1: "12 Oak St",
      city: "Oakland",
      postalCode: "94610",
    });
    // Jobber has no messaging API. The agent gets a clear reason, not a crash.
    await expect(
      h.engine.messageProvider(h.actor, { booking_id: jobber.booking.booking_id, message: "running late" }, h.signal),
    ).rejects.toSatisfy((e: unknown) => PorterError.is(e) && e.code === "UNSUPPORTED_CAPABILITY");
  });

  it("keeps one platform's outage from blanking the whole search", async () => {
    const clock = new FixedClock(new Date("2026-10-01T12:00:00.000Z"));
    const engine = new BookingEngine({
      adapters: [
        createMockAdapter({ seed: 42 }),
        // Square is down.
        createSquareAdapter({ http: new FakeSquare({ failWith: { status: 503, code: "SERVICE_UNAVAILABLE" } }) }),
      ],
      credentials: { square: { accessToken: SQUARE_TEST_TOKEN } },
      store: createMemoryStore(),
      clock,
      log: silentLogger,
      signer: createSigner("multi-adapter-test-secret-long-enough-01"),
    });

    const { providers } = await engine.searchProviders({ id: "user_x" }, { category: "haircut", limit: 10 }, new AbortController().signal);
    // The mock's results still come back.
    expect(providers.length).toBeGreaterThan(0);
    expect(providers.every((p) => !p.provider_id.startsWith("square:"))).toBe(true);
  });
});

async function bookThrough(
  h: ReturnType<typeof harness>,
  category: string,
  adapterId: string,
  customer: Record<string, string>,
) {
  const { providers } = await h.engine.searchProviders(h.actor, { category, limit: 25 }, h.signal);
  const provider = providers.find((p) => p.provider_id.startsWith(`${adapterId}:`) && p.services.some((s) => !s.quote_required));
  if (!provider) throw new Error(`no bookable ${adapterId} provider for ${category}`);
  const service = provider.services.find((s) => !s.quote_required)!;

  const from = new Date(h.clock.nowMs() + 2 * 60 * 60_000).toISOString();
  const to = new Date(h.clock.nowMs() + 21 * 24 * 60 * 60_000).toISOString();
  const { slots } = await h.engine.getAvailability(h.actor, { provider_id: provider.provider_id, service_id: service.service_id, from, to, limit: 10 }, h.signal);
  if (slots.length === 0) throw new Error(`no availability from ${adapterId}`);

  const key = `${adapterId}-${category}`;
  const envelope = (await h.engine.createBooking(h.actor, { slot_id: slots[0]!.slot_id, customer_details: customer, idempotency_key: key }, h.signal)) as ConfirmationEnvelope;
  if (!isEnvelope(envelope)) throw new Error("expected a confirmation envelope first");

  const done = (await h.engine.createBooking(
    h.actor,
    { slot_id: slots[0]!.slot_id, customer_details: customer, idempotency_key: key, confirmation_token: envelope.confirmationToken },
    h.signal,
  )) as { status: "ok"; booking: { booking_id: string; status: string } };
  return done;
}
