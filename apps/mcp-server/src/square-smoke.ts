/**
 * Exercise one synthetic booking against Square sandbox: pnpm square:smoke.
 * Requires PORTER_SQUARE_ACCESS_TOKEN and configured Appointments services.
 * Cancels every observed booking in finally; synthetic customer records remain.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createFetchHttpClient, ERROR_CODES, PorterError, silentLogger } from "@porter/shared";
import type { HttpClient } from "@porter/shared";
import { createSquareAdapter } from "@porter/adapter-square-appointments";
import type { AdapterContext, CreateBookingRequest } from "@porter/core";

const SANDBOX = "https://connect.squareupsandbox.com";

type CheckStatus = "pass" | "fail" | "skip" | "note";
export interface SmokeCheck {
  readonly status: CheckStatus;
  readonly label: string;
  readonly detail?: string;
}

export interface SquareSmokeReport {
  readonly runId: string;
  readonly checks: readonly SmokeCheck[];
  readonly outcome: "passed" | "failed" | "incomplete";
  readonly unresolvedBookingRefs: readonly string[];
  readonly uncertainCreate: boolean;
}

export interface SquareSmokeOptions {
  readonly accessToken: string;
  readonly baseUrl?: string;
  /** Inject a fake transport for regression tests. */
  readonly http?: HttpClient;
  readonly operationTimeoutMs?: number;
}

/** Reject all other URLs before creating a client or using any credential. */
export function validateSquareSandboxUrl(baseUrl = SANDBOX): void {
  if (baseUrl !== SANDBOX && baseUrl !== `${SANDBOX}/`) {
    throw new Error("Square smoke tests require https://connect.squareupsandbox.com; production and custom URLs are disabled.");
  }
}

/** No environment reads, console output, or process exits; safe to import in tests. */
export async function runSquareSmoke(options: SquareSmokeOptions): Promise<SquareSmokeReport> {
  validateSquareSandboxUrl(options.baseUrl);
  if (!options.accessToken.trim()) throw new Error("PORTER_SQUARE_ACCESS_TOKEN is not set.");
  const timeoutMs = options.operationTimeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("The operation timeout must be positive.");

  const runId = `porter-smoke-${randomUUID()}`;
  const checks: SmokeCheck[] = [];
  const bookings = new Map<string, string>();
  let selectedProviderId: string | undefined;
  let uncertainCreate = false;
  let originalCreateBody: string | undefined;
  let replayBodyChanged = false;
  let stage = "Catalog discovery";
  const check = (status: CheckStatus, label: string, detail?: string): void => {
    checks.push({ status, label, ...(detail ? { detail } : {}) });
  };
  const fail = (label: string, error: unknown): void => check("fail", label, safeError(error));
  const transport = options.http ?? createFetchHttpClient({
    maxRetries: 0,
    // A redirect must never move this authenticated test off the sandbox host.
    fetchImpl: (input, init) => fetch(input, { ...init, redirect: "error" }),
  });
  const adapter = createSquareAdapter({
    baseUrl: SANDBOX,
    http: {
      async send(request) {
        const creating = request.method === "POST" && request.url === `${SANDBOX}/v2/bookings`;
        if (!creating) return transport.send(request);
        // The adapter resolves customer IDs again during replay. Compare the
        // actual wire body before sending, even when its input object is frozen.
        const serializedBody = JSON.stringify(request.body);
        if (originalCreateBody === undefined) originalCreateBody = serializedBody;
        else if (serializedBody !== originalCreateBody) {
          replayBodyChanged = true;
          throw new PorterError("IDEMPOTENCY_CONFLICT", "The smoke replay payload changed.");
        }
        // Capture references before adapter mapping, including unexpected replay
        // duplicates, so mapping failures still reach the cleanup in finally.
        try {
          const response = await transport.send(request);
          const ref = createdBookingRef(response.body);
          if (response.status >= 200 && response.status < 300 && ref && selectedProviderId) {
            bookings.set(ref, selectedProviderId);
          } else if (response.status < 400 || response.status >= 500 || response.status === 408) {
            uncertainCreate = true;
          }
          return response;
        } catch (error) {
          uncertainCreate = true;
          throw error;
        }
      },
    },
  });

  // Every adapter operation, including every cancellation, has a fresh deadline.
  async function call<T>(operation: (ctx: AdapterContext) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await operation({
        actorId: "square-sandbox-smoke",
        log: silentLogger,
        signal: controller.signal,
        credentials: { accessToken: options.accessToken },
        now: new Date(),
      });
    } finally {
      clearTimeout(timer);
    }
  }

  function report(): SquareSmokeReport {
    return {
      runId,
      checks,
      outcome: checks.some((entry) => entry.status === "fail") ? "failed"
        : checks.some((entry) => entry.status === "skip") ? "incomplete" : "passed",
      unresolvedBookingRefs: [...bookings.keys()],
      uncertainCreate,
    };
  }

  try {
    const providers = await call((ctx) => adapter.searchProviders({ categories: [], limit: 10 }, ctx));
    if (providers.length === 0) {
      check("fail", "Catalog discovery", "No bookable services returned; configure sandbox Appointments services and staff.");
      return report();
    }
    check("pass", "Catalog discovery", `${providers.length} location(s) returned.`);
    const selection = providers.flatMap(({ provider, services }) => services.map((service) => ({ provider, service })))
      .find(({ service }) => !service.quoteRequired && service.price?.currency === "USD" && service.durationMinutes > 0);
    if (!selection) {
      check("fail", "Service mapping", "No fixed-price USD service with a positive duration returned.");
      return report();
    }
    const { provider, service } = selection;
    selectedProviderId = provider.id;
    check("pass", "Service mapping", `${service.durationMinutes} minutes; ${service.price!.amount} USD minor units.`);
    if (service.category === null) check("note", "Category mapping", "The selected service has no taxonomy category.");

    const from = new Date(Date.now() + 2 * 3_600_000);
    const to = new Date(Date.now() + 14 * 86_400_000);
    stage = "Availability";
    const slots = await call((ctx) => adapter.getAvailability({ providerId: provider.id, serviceId: service.id, from, to, limit: 5 }, ctx));
    const slot = slots[0];
    if (!slot) {
      check("fail", "Availability", "No slots returned; check sandbox hours and staff bookability.");
      return report();
    }
    if (!slot.providerSlotRef || !Number.isFinite(slot.startsAt.getTime()) || !Number.isFinite(slot.endsAt.getTime()) || slot.startsAt < from || slot.startsAt > to || slot.endsAt <= slot.startsAt) {
      check("fail", "Availability", "The first slot has invalid times or no team member reference.");
      return report();
    }
    check("pass", "Availability", `${slots.length} slot(s) returned.`);

    stage = "Policy before booking";
    const policy = await call((ctx) => adapter.getServiceCancellationPolicy!(
      { providerId: provider.id, serviceId: service.id, startsAt: slot.startsAt }, ctx,
    ));
    check(policy.known ? "pass" : "note", "Policy before booking", policy.known ? "Published policy returned." : "Policy reported unknown.");

    const slotQuery = { providerId: provider.id, serviceId: service.id, startsAt: slot.startsAt, providerSlotRef: slot.providerSlotRef };
    stage = "Slot recheck";
    const rechecked = await call((ctx) => adapter.checkSlot(slotQuery, ctx));
    if (!rechecked) {
      check("fail", "Slot recheck", "The offered slot is no longer available; no booking attempted.");
      return report();
    }
    if (rechecked.endsAt.getTime() !== slot.endsAt.getTime() || rechecked.price?.amount !== slot.price?.amount || rechecked.price?.currency !== slot.price?.currency) {
      check("fail", "Slot recheck", "The offered duration or price changed; no booking attempted.");
      return report();
    }
    check("pass", "Slot recheck");

    // Construct this once. The customer, notes, times, and key must remain
    // identical across the original request and the idempotent replay.
    const createRequest: CreateBookingRequest = Object.freeze({
      providerId: provider.id,
      locationId: slot.locationId,
      serviceId: service.id,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      providerSlotRef: slot.providerSlotRef,
      customer: Object.freeze({ givenName: "Porter", phone: "+14155550100", email: `${runId}@example.com` }),
      idempotencyKey: runId,
      notes: "Porter sandbox smoke test; synthetic customer; safe to delete.",
    });
    stage = "Create booking";
    const booking = await call((ctx) => adapter.createBooking(createRequest, ctx));
    if (!bookings.has(booking.providerBookingRef)) {
      throw new PorterError("ADAPTER_DOWN", "No usable booking reference returned.");
    }
    const validStatus = booking.status === "pending" || booking.status === "confirmed";
    check(validStatus ? "pass" : "fail", "Create booking", validStatus ? `Returned ${booking.status}.` : "Unexpected booking status.");
    const matchesRequest = booking.providerId === provider.id && booking.locationId === slot.locationId
      && booking.serviceId === service.id && booking.startsAt.getTime() === slot.startsAt.getTime()
      && booking.endsAt.getTime() === slot.endsAt.getTime();
    check(matchesRequest ? "pass" : "fail", "Created booking details",
      matchesRequest ? "Provider, location, service, and times match the request." : "Returned booking differs from the requested appointment.");

    try {
      const replay = await call((ctx) => adapter.createBooking(createRequest, ctx));
      check(replay.providerBookingRef === booking.providerBookingRef ? "pass" : "fail", "Idempotent replay",
        replay.providerBookingRef === booking.providerBookingRef ? "Identical request returned the same booking." : "Replay returned a second booking; both will be cancelled.");
    } catch (error) {
      if (replayBodyChanged) check("fail", "Idempotent replay", "The rebuilt Square booking payload changed; replay was not sent.");
      else fail("Idempotent replay", error);
    }

    try {
      const available = await call((ctx) => adapter.checkSlot(slotQuery, ctx));
      check(available === null ? "pass" : "note", "Availability after booking",
        available === null ? "The slot is no longer offered." : "The slot is still offered; exclusive occupancy was not established.");
      const bookingPolicy = await call((ctx) => adapter.getCancellationPolicy(booking.providerBookingRef, ctx));
      check("pass", "Retrieve booking policy", bookingPolicy.known ? "Published policy returned." : "Policy reported unknown.");
    } catch (error) {
      fail("Booking readback", error);
    }

    try {
      const later = await call((ctx) => adapter.getAvailability({
        providerId: provider.id, serviceId: service.id, from: new Date(slot.endsAt.getTime() + 3_600_000), to, limit: 3,
      }, ctx));
      const destination = later[0];
      if (!destination) {
        check("skip", "Reschedule", "No later slot returned.");
      } else {
        const moved = await call((ctx) => adapter.rescheduleBooking({
          bookingRef: booking.providerBookingRef,
          providerId: provider.id,
          serviceId: service.id,
          startsAt: destination.startsAt,
          endsAt: destination.endsAt,
          providerSlotRef: destination.providerSlotRef,
          idempotencyKey: `${runId}-move`,
        }, ctx));
        check(moved.providerBookingRef === booking.providerBookingRef && moved.startsAt.getTime() === destination.startsAt.getTime()
          && moved.endsAt.getTime() === destination.endsAt.getTime() ? "pass" : "fail", "Reschedule");
      }
    } catch (error) {
      fail("Reschedule", error);
    }

    try {
      await call((ctx) => adapter.cancelBooking({ bookingRef: "not-a-real-booking-ref", providerId: provider.id, idempotencyKey: `${runId}-missing` }, ctx));
      check("fail", "Missing booking error mapping", "Expected NOT_FOUND; received success.");
    } catch (error) {
      if (PorterError.is(error) && error.code === "NOT_FOUND") check("pass", "Missing booking error mapping");
      else fail("Missing booking error mapping", error);
    }
  } catch (error) {
    fail(stage, error);
  } finally {
    let cancelIndex = 0;
    for (const [bookingRef, providerId] of bookings) {
      try {
        const cancelled = await call((ctx) => adapter.cancelBooking({
          bookingRef, providerId, reason: "Porter sandbox smoke test", idempotencyKey: `${runId}-cancel-${++cancelIndex}`,
        }, ctx));
        if (cancelled.status === "cancelled" && cancelled.providerBookingRef === bookingRef) {
          bookings.delete(bookingRef);
          check("pass", "Cancel test booking");
        } else {
          check("fail", "Cancel test booking", "Cancellation was not confirmed; inspect the sandbox dashboard.");
        }
      } catch (error) {
        fail("Cancel test booking", error);
      }
    }
    if (uncertainCreate) check("fail", "Uncertain create outcome", "A booking write had no definitive response. Inspect sandbox appointments using this run ID before another run.");
  }
  return report();
}

function createdBookingRef(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || !("booking" in body)) return undefined;
  const booking = body.booking;
  if (!booking || typeof booking !== "object" || !("id" in booking)) return undefined;
  return typeof booking.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(booking.id) ? booking.id : undefined;
}

function safeError(error: unknown): string {
  // Messages, details, causes, URLs and provider response bodies may contain
  // credentials or customer data. Only emit Porter's closed error taxonomy.
  return PorterError.is(error) && ERROR_CODES.includes(error.code) ? error.code : "Unexpected failure (details withheld).";
}

async function main(): Promise<void> {
  // Configuration errors are fixed strings; never echo the supplied URL/token.
  try {
    validateSquareSandboxUrl(process.env.PORTER_SQUARE_BASE_URL);
    if (!process.env.PORTER_SQUARE_ACCESS_TOKEN?.trim()) {
      console.error("PORTER_SQUARE_ACCESS_TOKEN is not set. Configure a sandbox token in the ignored .env file.");
      process.exitCode = 1;
      return;
    }
  } catch {
    console.error("Refusing smoke test: only https://connect.squareupsandbox.com is allowed. Production overrides are disabled.");
    process.exitCode = 1;
    return;
  }
  console.log(`Square sandbox smoke test (${SANDBOX})`);
  const report = await runSquareSmoke({ accessToken: process.env.PORTER_SQUARE_ACCESS_TOKEN! });
  console.log(`Run: ${report.runId}`);
  for (const entry of report.checks) console.log(`${entry.status.toUpperCase()} ${entry.label}${entry.detail ? `: ${entry.detail}` : ""}`);
  console.log(`Result: ${report.outcome}; ${report.checks.filter((entry) => entry.status === "pass").length} checks passed.`);
  if (report.unresolvedBookingRefs.length) console.error(`Cancel these test bookings in the sandbox dashboard: ${report.unresolvedBookingRefs.join(", ")}`);
  console.log("Evidence covers only the reported sandbox checks. Buyer OAuth scopes, notification delivery, Muse, and production readiness remain unverified. Synthetic customer records are retained.");
  process.exitCode = report.outcome === "passed" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Smoke test stopped: ${safeError(error)}`);
    process.exitCode = 1;
  });
}
