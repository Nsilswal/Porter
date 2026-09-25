import type { HttpClient, HttpRequest, HttpResponse } from "@porter/shared";
import locationsFixture from "../fixtures/locations.json" with { type: "json" };
import catalogFixture from "../fixtures/catalog.json" with { type: "json" };
import profileFixture from "../fixtures/business-booking-profile.json" with { type: "json" };
import teamFixture from "../fixtures/team-members.json" with { type: "json" };
import shortAvailabilityRangeFixture from "../fixtures/availability-range-error.json" with { type: "json" };
import immutableSegmentsFixture from "../fixtures/booking-segments-permission-error.json" with { type: "json" };
import type { SquareBooking, SquareCatalogObject, SquareCustomer, SquareLocation } from "../api.js";

/**
 * A wire-level fake of Square Appointments.
 *
 * It speaks Square's real request and response shapes, taken from the
 * published reference, and holds enough state for a booking to actually
 * remove availability. That lets the conformance suite drive the adapter's
 * genuine request building, response parsing, mapping and error handling —
 * none of which a static response stub would reach.
 *
 * This is synthetic test data, not a recording of the seller's account. The
 * availability-range and immutable-segment errors reproduce literal errors
 * observed in sandbox; the rest models the published reference and buyer
 * permissions. Passing these tests alone does not verify live behavior.
 * See docs/square-integration-contract.md.
 */
export interface FakeSquareOptions {
  /** Fail every call, to check error mapping. */
  readonly failWith?: { status: number; code: string; category?: string };
  /** Business hours in UTC, as [openHour, closeHour). */
  readonly hours?: readonly [number, number];
  /** Slot alignment in minutes. */
  readonly stepMinutes?: number;
  readonly accessToken?: string;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** The fake owns this record and mutates it, unlike the readonly wire type. */
interface StoredBooking extends Mutable<SquareBooking> {
  id: string;
  version: number;
}

export class FakeSquare implements HttpClient {
  readonly bookings = new Map<string, StoredBooking>();
  readonly customers = new Map<string, SquareCustomer>();
  readonly requests: { method: string; path: string; body: unknown }[] = [];
  readonly #idempotency = new Map<string, string>();
  readonly #options: FakeSquareOptions;
  #counter = 0;

  constructor(options: FakeSquareOptions = {}) {
    this.#options = options;
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    if (request.signal?.aborted) throw new Error("aborted");

    const url = new URL(request.url);
    const path = url.pathname;
    this.requests.push({ method: request.method, path, body: request.body });

    // Square rejects a call with no or wrong credentials before anything else.
    const auth = request.headers?.authorization ?? "";
    const expected = this.#options.accessToken ?? "sandbox-token";
    if (auth !== `Bearer ${expected}`) {
      return json(401, { errors: [{ category: "AUTHENTICATION_ERROR", code: "UNAUTHORIZED" }] });
    }
    if (!request.headers?.["square-version"]) {
      return json(400, { errors: [{ category: "INVALID_REQUEST_ERROR", code: "BAD_REQUEST", detail: "missing Square-Version" }] });
    }

    const fail = this.#options.failWith;
    if (fail) return json(fail.status, { errors: [{ category: fail.category ?? "API_ERROR", code: fail.code }] });

    if (request.method === "GET" && path === "/v2/locations") {
      return json(200, locationsFixture);
    }
    if (request.method === "POST" && path === "/v2/catalog/search") {
      return json(200, catalogFixture);
    }
    if (request.method === "GET" && path === "/v2/bookings/business-booking-profile") {
      return json(200, profileFixture);
    }
    if (request.method === "GET" && path === "/v2/bookings/team-member-booking-profiles") {
      return json(200, teamFixture);
    }
    if (request.method === "POST" && path === "/v2/bookings/availability/search") {
      const range = (request.body as { query?: { filter?: { start_at_range?: { start_at?: string; end_at?: string } } } })?.query?.filter?.start_at_range;
      const durationMs = Date.parse(range?.end_at ?? "") - Date.parse(range?.start_at ?? "");
      if (!Number.isFinite(durationMs) || durationMs < 60 * 60_000) {
        return json(400, shortAvailabilityRangeFixture);
      }
      return json(200, { availabilities: this.#availability(request.body) });
    }
    if (request.method === "POST" && path === "/v2/customers/search") {
      const filter = (request.body as { query?: { filter?: { email_address?: { exact?: string }; phone_number?: { exact?: string } } } })?.query?.filter;
      const phone = filter?.phone_number?.exact?.replace(/[ ()-]/g, "");
      if (phone !== undefined && !/^\+[1-9]\d{1,14}$/.test(phone)) {
        return json(400, { errors: [{ category: "INVALID_REQUEST_ERROR", code: "INVALID_VALUE", field: "query.filter.phone_number.exact" }] });
      }
      const hit = [...this.customers.values()].find((c) =>
        (!filter?.email_address?.exact || c.email_address === filter.email_address.exact) &&
        (phone === undefined || c.phone_number?.replace(/[ ()-]/g, "") === phone),
      );
      return json(200, hit ? { customers: [hit] } : {});
    }
    if (request.method === "POST" && path === "/v2/customers") {
      const id = `CUST_${++this.#counter}`;
      const customer = { id, ...(request.body as Record<string, unknown>) };
      this.customers.set(id, customer as any);
      return json(200, { customer });
    }
    if (request.method === "POST" && path === "/v2/bookings") {
      return this.#createBooking(request.body);
    }

    const bookingMatch = /^\/v2\/bookings\/([^/]+)$/.exec(path);
    if (bookingMatch) {
      const id = decodeURIComponent(bookingMatch[1]!);
      const existing = this.bookings.get(id);
      if (!existing) return json(404, { errors: [{ category: "INVALID_REQUEST_ERROR", code: "NOT_FOUND" }] });
      if (request.method === "GET") return json(200, { booking: existing });
      if (request.method === "PUT") return this.#update(existing, request.body);
    }

    const cancelMatch = /^\/v2\/bookings\/([^/]+)\/cancel$/.exec(path);
    if (cancelMatch && request.method === "POST") {
      const id = decodeURIComponent(cancelMatch[1]!);
      const existing = this.bookings.get(id);
      if (!existing) return json(404, { errors: [{ category: "INVALID_REQUEST_ERROR", code: "NOT_FOUND" }] });
      existing.status = "CANCELLED_BY_CUSTOMER";
      existing.version += 1;
      existing.updated_at = new Date().toISOString();
      return json(200, { booking: existing });
    }

    return json(404, { errors: [{ category: "INVALID_REQUEST_ERROR", code: "NOT_FOUND" }] });
  }

  #createBooking(body: unknown): HttpResponse {
    const payload = body as { idempotency_key?: string; booking?: SquareBooking };
    const key = payload.idempotency_key;

    // Square's own idempotency: the same key replays the same booking.
    if (key) {
      const existingId = this.#idempotency.get(key);
      if (existingId) return json(200, { booking: this.bookings.get(existingId) });
    }

    const booking = payload.booking;
    if (!booking?.customer_id || !this.customers.get(booking.customer_id)?.phone_number) {
      return json(400, { errors: [{ category: "INVALID_REQUEST_ERROR", code: "BAD_REQUEST", field: "phone" }] });
    }
    const startAt = booking?.start_at;
    const segment = booking?.appointment_segments?.[0];
    if (!startAt || !segment?.service_variation_id || !segment.team_member_id) {
      return json(400, { errors: [{ category: "INVALID_REQUEST_ERROR", code: "BAD_REQUEST" }] });
    }

    // That person at that time is either free or not.
    const taken = [...this.bookings.values()].some(
      (b) =>
        b.status !== "CANCELLED_BY_CUSTOMER" &&
        b.status !== "CANCELLED_BY_SELLER" &&
        b.start_at === startAt &&
        b.appointment_segments?.[0]?.team_member_id === segment.team_member_id,
    );
    if (taken) return json(409, { errors: [{ category: "INVALID_REQUEST_ERROR", code: "BOOKING_CONFLICT" }] });

    const id = `SQBK${++this.#counter}`;
    const now = new Date().toISOString();
    const stored: StoredBooking = {
      id,
      version: 1,
      status: "ACCEPTED",
      created_at: now,
      updated_at: now,
      start_at: startAt,
      location_id: booking.location_id,
      customer_id: booking.customer_id,
      appointment_segments: booking.appointment_segments,
      ...(booking.customer_note ? { customer_note: booking.customer_note } : {}),
    };
    this.bookings.set(id, stored);
    if (key) this.#idempotency.set(key, id);
    return json(200, { booking: stored });
  }

  #update(existing: StoredBooking, body: unknown): HttpResponse {
    const payload = body as { booking?: SquareBooking & { version?: number } };
    const incoming = payload.booking;
    // The pilot uses buyer permissions. Even repeating unchanged segments is
    // forbidden after creation; time-only rescheduling must be a sparse update.
    if (incoming && Object.hasOwn(incoming, "appointment_segments")) {
      return json(403, immutableSegmentsFixture);
    }

    // Optimistic concurrency, exactly as Square does it.
    if (incoming?.version !== undefined && incoming.version !== existing.version) {
      return json(409, { errors: [{ category: "INVALID_REQUEST_ERROR", code: "CONFLICT" }] });
    }

    const newStart = incoming?.start_at;
    const segment = existing.appointment_segments?.[0];
    if (newStart) {
      const clash = [...this.bookings.values()].some(
        (b) =>
          b.id !== existing.id &&
          b.status === "ACCEPTED" &&
          b.start_at === newStart &&
          b.appointment_segments?.[0]?.team_member_id === segment?.team_member_id,
      );
      if (clash) return json(409, { errors: [{ category: "INVALID_REQUEST_ERROR", code: "BOOKING_CONFLICT" }] });
      existing.start_at = newStart;
    }
    existing.version += 1;
    existing.updated_at = new Date().toISOString();
    return json(200, { booking: existing });
  }

  /**
   * Generate open slots from business hours, minus anything already booked.
   * Square returns one availability per open start time per team member.
   */
  #availability(body: unknown): unknown[] {
    const filter = (body as any)?.query?.filter ?? {};
    const locationId: string = filter.location_id;
    const variationId: string = filter.segment_filters?.[0]?.service_variation_id;
    const from = new Date(filter.start_at_range?.start_at ?? Date.now());
    const to = new Date(filter.start_at_range?.end_at ?? Date.now());
    if (!variationId) return [];

    const variation = findVariation(variationId);
    if (!variation) return [];
    const durationMs = variation.item_variation_data?.service_duration ?? 3_600_000;
    const durationMinutes = Math.round(durationMs / 60_000);
    const teamMembers = variation.item_variation_data?.team_member_ids ?? ["TM_ALEX"];

    const [open, close] = this.#options.hours ?? [16, 23]; // UTC, ~9-4 Pacific
    const step = this.#options.stepMinutes ?? 30;
    const out: unknown[] = [];

    const day = new Date(from);
    day.setUTCHours(0, 0, 0, 0);

    for (let d = 0; d < 30 && out.length < 60; d++) {
      const base = new Date(day.getTime() + d * 86_400_000);
      if (base.getTime() > to.getTime() + 86_400_000) break;
      if (base.getUTCDay() === 0) continue; // closed Sundays

      for (let m = open * 60; m + durationMinutes <= close * 60; m += step) {
        const startsAt = new Date(base.getTime() + m * 60_000);
        if (startsAt < from || startsAt > to) continue;

        for (const teamMemberId of teamMembers) {
          const busy = [...this.bookings.values()].some(
            (b) =>
              b.status === "ACCEPTED" &&
              b.start_at === startsAt.toISOString() &&
              b.appointment_segments?.[0]?.team_member_id === teamMemberId,
          );
          if (busy) continue;
          out.push({
            start_at: startsAt.toISOString(),
            location_id: locationId,
            appointment_segments: [
              {
                duration_minutes: durationMinutes,
                service_variation_id: variationId,
                service_variation_version: variation.version ?? 0,
                team_member_id: teamMemberId,
              },
            ],
          });
        }
      }
    }
    return out;
  }
}

function findVariation(variationId: string): SquareCatalogObject | undefined {
  for (const item of catalogFixture.objects as unknown as SquareCatalogObject[]) {
    for (const v of item.item_data?.variations ?? []) {
      if (v.id === variationId) return v;
    }
  }
  return undefined;
}

function json(status: number, body: unknown): HttpResponse {
  return { status, headers: { "content-type": "application/json" }, body };
}

export const FIXTURE_LOCATIONS = locationsFixture.locations as unknown as SquareLocation[];
export const SQUARE_TEST_TOKEN = "sandbox-token";
