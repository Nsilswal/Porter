/**
 * Square sandbox smoke test.
 *
 *   PORTER_SQUARE_ACCESS_TOKEN=EAAA... pnpm square:smoke
 *
 * Runs the real Square adapter against Square's real sandbox API and reports
 * what actually holds. This is the test that matters: the adapter and its
 * fixtures were written from Square's published documentation, not recorded
 * from live traffic, so until this passes the mapping is believed, not known.
 *
 * It creates a booking and then cancels it. Sandbox only by default; pointing
 * it at production takes a deliberate flag.
 */
import { createFetchHttpClient, createLogger, PorterError, silentLogger } from "@porter/shared";
import { createSquareAdapter } from "@porter/adapter-square-appointments";
import type { AdapterContext } from "@porter/core";

const SANDBOX = "https://connect.squareupsandbox.com";
const PRODUCTION = "https://connect.squareup.com";

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

let passed = 0;
let failed = 0;
const notes: string[] = [];

function ok(label: string, detail = ""): void {
  passed++;
  console.log(`  ${green("PASS")} ${label}${detail ? dim(`  ${detail}`) : ""}`);
}
function bad(label: string, detail = ""): void {
  failed++;
  console.log(`  ${red("FAIL")} ${label}${detail ? `  ${detail}` : ""}`);
}
function warn(label: string): void {
  notes.push(label);
  console.log(`  ${yellow("NOTE")} ${label}`);
}
function heading(title: string): void {
  console.log(`\n${bold(title)}`);
}

async function main(): Promise<void> {
  const token = process.env.PORTER_SQUARE_ACCESS_TOKEN;
  if (!token) {
    console.error(`
${red("PORTER_SQUARE_ACCESS_TOKEN is not set.")}

  1. Create a free Square developer account at https://developer.squareup.com
  2. Make an application, open the Sandbox tab
  3. Copy the sandbox Access Token (it starts with EAAA)
  4. Put it in .env, which is gitignored:

       PORTER_SQUARE_ACCESS_TOKEN=EAAA...

  5. Give the sandbox seller some Appointments services in the Square
     dashboard: a bookable service with a price, a duration and a team member.
`);
    process.exit(1);
  }

  const useProduction = process.env.PORTER_SQUARE_BASE_URL === PRODUCTION;
  if (useProduction && process.env.PORTER_SMOKE_ALLOW_PRODUCTION !== "true") {
    console.error(red("\nRefusing to run against production Square. This creates real bookings for real customers."));
    console.error("Set PORTER_SMOKE_ALLOW_PRODUCTION=true only if you genuinely mean it.\n");
    process.exit(1);
  }
  const baseUrl = process.env.PORTER_SQUARE_BASE_URL ?? SANDBOX;

  console.log(bold("\nSquare sandbox smoke test"));
  console.log(dim(`host: ${baseUrl}`));
  console.log(dim(`token: ${token.slice(0, 6)}…${token.slice(-4)}`));

  const adapter = createSquareAdapter({ http: createFetchHttpClient(), baseUrl });
  const ctx: AdapterContext = {
    actorId: "smoke",
    log: process.env.PORTER_SMOKE_VERBOSE ? createLogger({ level: "debug" }) : silentLogger,
    signal: AbortSignal.timeout(60_000),
    credentials: { accessToken: token },
    now: new Date(),
  };

  // ------------------------------------------------------------ discovery
  heading("1. Catalog and locations");
  let providers;
  try {
    providers = await adapter.searchProviders({ categories: [], limit: 10 }, ctx);
  } catch (error) {
    bad("searchProviders", describe(error));
    return summarise();
  }

  if (providers.length === 0) {
    bad("searchProviders returned nothing", "the sandbox seller has no bookable Appointments services");
    console.log(dim("\n  Add a service in the Square sandbox dashboard: Items → Services,"));
    console.log(dim("  priced, with a duration, marked bookable, assigned to a team member.\n"));
    return summarise();
  }
  ok("searchProviders", `${providers.length} location(s)`);

  for (const p of providers) {
    console.log(dim(`       ${p.provider.name} — ${p.services.length} service(s)`));
    if (p.provider.unmappedCategories?.length) {
      warn(`category inference missed: ${p.provider.unmappedCategories.slice(0, 4).join(", ")}`);
    }
  }

  const bookable = providers.find((p) => p.services.some((s) => !s.quoteRequired));
  if (!bookable) {
    bad("no priced service", "every service came back quote-required, so pricing did not map");
    return summarise();
  }
  const provider = bookable.provider;
  const service = bookable.services.find((s) => !s.quoteRequired)!;
  ok("service mapping", `${service.name} · ${service.durationMinutes}min · ${service.price ? `$${(service.price.amount / 100).toFixed(2)}` : "no price"}`);

  if (service.durationMinutes <= 0) bad("duration mapping", "Square returns milliseconds; expected minutes");
  if (service.category === null) warn(`"${service.name}" did not map to a taxonomy category`);

  // --------------------------------------------------------------- policy
  heading("2. Cancellation policy, before any booking exists");
  try {
    const policy = await adapter.getServiceCancellationPolicy!(
      { providerId: provider.id, serviceId: service.id, startsAt: new Date(Date.now() + 7 * 86_400_000) },
      ctx,
    );
    if (policy.known) {
      ok("business booking profile", `fee ${policy.feeAmount ? `$${(policy.feeAmount.amount / 100).toFixed(2)}` : "none"}, free until ${policy.freeUntil?.toISOString() ?? "n/a"}`);
    } else {
      warn("the sandbox seller has not configured a cancellation policy, so it reports unknown (correct behaviour)");
    }
  } catch (error) {
    bad("getServiceCancellationPolicy", describe(error));
  }

  // --------------------------------------------------------- availability
  heading("3. Availability");
  const from = new Date(Date.now() + 2 * 3_600_000);
  const to = new Date(Date.now() + 14 * 86_400_000);
  let slots;
  try {
    slots = await adapter.getAvailability({ providerId: provider.id, serviceId: service.id, from, to, limit: 5 }, ctx);
  } catch (error) {
    bad("getAvailability", describe(error));
    return summarise();
  }

  if (slots.length === 0) {
    bad("no availability", "check the sandbox seller's business hours and team member bookability");
    return summarise();
  }
  ok("searchAvailability", `${slots.length} slot(s), first ${slots[0]!.startsAt.toISOString()}`);

  const slot = slots[0]!;
  if (!slot.providerSlotRef) {
    bad("team member missing", "providerSlotRef should carry the Square team member id");
  } else {
    ok("team member carried", slot.providerSlotRef);
  }
  if (slot.startsAt < from || slot.startsAt > to) bad("slot outside the requested window");

  // ------------------------------------------------------------ checkSlot
  heading("4. Re-check before booking");
  try {
    const rechecked = await adapter.checkSlot(
      { providerId: provider.id, serviceId: service.id, startsAt: slot.startsAt, providerSlotRef: slot.providerSlotRef },
      ctx,
    );
    rechecked ? ok("checkSlot confirms an open slot") : bad("checkSlot said a slot from getAvailability is gone");
  } catch (error) {
    bad("checkSlot", describe(error));
  }

  // -------------------------------------------------------------- booking
  heading("5. Create a booking");
  const idempotencyKey = `porter-smoke-${Date.now()}`;
  let booking;
  try {
    booking = await adapter.createBooking(
      {
        providerId: provider.id,
        locationId: slot.locationId,
        serviceId: service.id,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        providerSlotRef: slot.providerSlotRef,
        customer: { givenName: "Porter", email: `porter-smoke-${Date.now()}@example.com` },
        idempotencyKey,
        notes: "Porter smoke test — safe to delete",
      },
      ctx,
    );
    ok("createBooking", `${booking.providerBookingRef} · ${booking.status}`);
  } catch (error) {
    bad("createBooking", describe(error));
    return summarise();
  }

  if (!["pending", "confirmed"].includes(booking.status)) {
    bad("status mapping", `got "${booking.status}"`);
  }

  heading("6. Square's own idempotency");
  try {
    const replay = await adapter.createBooking(
      {
        providerId: provider.id,
        locationId: slot.locationId,
        serviceId: service.id,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        providerSlotRef: slot.providerSlotRef,
        customer: { givenName: "Porter", email: `porter-smoke-${Date.now()}@example.com` },
        idempotencyKey,
      },
      ctx,
    );
    replay.providerBookingRef === booking.providerBookingRef
      ? ok("same key replayed the same booking")
      : bad("same key created a second booking", `${booking.providerBookingRef} vs ${replay.providerBookingRef}`);
  } catch (error) {
    bad("idempotent replay", describe(error));
  }

  heading("7. The slot is no longer bookable");
  try {
    const gone = await adapter.checkSlot(
      { providerId: provider.id, serviceId: service.id, startsAt: slot.startsAt, providerSlotRef: slot.providerSlotRef },
      ctx,
    );
    gone === null
      ? ok("checkSlot now returns null")
      : warn("the slot is still offered after booking — Square may allow overlapping bookings for this seller");
  } catch (error) {
    bad("checkSlot after booking", describe(error));
  }

  heading("8. Policy for the real booking");
  try {
    const policy = await adapter.getCancellationPolicy(booking.providerBookingRef, ctx);
    ok("getCancellationPolicy", policy.known ? "published" : "not published (reported as unknown)");
  } catch (error) {
    bad("getCancellationPolicy", describe(error));
  }

  // ----------------------------------------------------------- reschedule
  heading("9. Reschedule");
  try {
    const later = await adapter.getAvailability(
      { providerId: provider.id, serviceId: service.id, from: new Date(slot.endsAt.getTime() + 3_600_000), to, limit: 3 },
      ctx,
    );
    if (later.length === 0) {
      warn("no later slot available to reschedule into; skipped");
    } else {
      const moved = await adapter.rescheduleBooking(
        {
          bookingRef: booking.providerBookingRef,
          providerId: provider.id,
          serviceId: service.id,
          startsAt: later[0]!.startsAt,
          endsAt: later[0]!.endsAt,
          providerSlotRef: later[0]!.providerSlotRef,
          idempotencyKey: `${idempotencyKey}-move`,
        },
        ctx,
      );
      moved.startsAt.getTime() === later[0]!.startsAt.getTime()
        ? ok("rescheduleBooking", moved.startsAt.toISOString())
        : bad("reschedule did not move the booking");
    }
  } catch (error) {
    bad("rescheduleBooking", describe(error));
  }

  // --------------------------------------------------------------- clean up
  heading("10. Cancel (cleaning up after ourselves)");
  try {
    const cancelled = await adapter.cancelBooking(
      { bookingRef: booking.providerBookingRef, providerId: provider.id, reason: "Porter smoke test", idempotencyKey: `${idempotencyKey}-cancel` },
      ctx,
    );
    cancelled.status === "cancelled" ? ok("cancelBooking") : bad("cancel status", cancelled.status);
  } catch (error) {
    bad("cancelBooking", describe(error), );
    console.log(red(`\n  Booking ${booking.providerBookingRef} was left open. Cancel it in the Square dashboard.`));
  }

  heading("11. Error mapping");
  try {
    await adapter.cancelBooking({ bookingRef: "not-a-real-booking-ref", providerId: provider.id, idempotencyKey: "x" }, ctx);
    bad("unknown booking ref", "expected NOT_FOUND, got success");
  } catch (error) {
    PorterError.is(error) && error.code === "NOT_FOUND"
      ? ok("unknown ref maps to NOT_FOUND")
      : bad("unknown ref mapping", describe(error));
  }

  summarise();
}

function describe(error: unknown): string {
  if (PorterError.is(error)) return `${error.code}: ${error.message}`;
  return String(error);
}

function summarise(): void {
  console.log(`\n${bold("Result")}  ${green(`${passed} passed`)}${failed ? `  ${red(`${failed} failed`)}` : ""}${notes.length ? `  ${yellow(`${notes.length} note(s)`)}` : ""}`);
  if (failed === 0) {
    console.log(green("\nThe Square adapter works against the real API. The fixtures held.\n"));
  } else {
    console.log(red("\nSomething the fixtures assumed is not true of the real API. Fix the adapter, then re-record the fixtures.\n"));
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
