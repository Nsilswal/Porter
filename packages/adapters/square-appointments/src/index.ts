import { createHash } from "node:crypto";
import {
  PorterError,
  assertNotAborted,
  money,
  type HttpClient,
  type HttpResponse,
  type Money,
} from "@porter/shared";
import type {
  AdapterCapabilities,
  AdapterContext,
  AvailabilityQuery,
  Booking,
  CancelRequest,
  CancellationPolicy,
  CreateBookingRequest,
  ListQuery,
  ProviderAdapter,
  RescheduleRequest,
  SearchQuery,
  SearchResult,
  Service,
  Slot,
} from "@porter/adapter-contract";
import type { ServiceCategory } from "@porter/core";
import {
  serviceDurationMinutes,
  type BookingResponse,
  type BusinessBookingProfileResponse,
  type CustomerResponse,
  type ListBookingsResponse,
  type ListLocationsResponse,
  type SearchAvailabilityResponse,
  type SearchCatalogResponse,
  type SearchCustomersResponse,
  type SquareBusinessBookingProfile,
  type SquareCatalogObject,
  type SquareLocation,
} from "./api.js";
import {
  mapBooking,
  mapCancellationPolicy,
  mapProvider,
  mapServiceVariation,
  mapSlot,
  mapSquareError,
  type MappedVariation,
} from "./map.js";

export * from "./api.js";
export * from "./map.js";

export interface SquareAdapterOptions {
  readonly http: HttpClient;
  readonly baseUrl?: string;
  /** Square's dated API version header. */
  readonly apiVersion?: string;
  readonly id?: string;
  /** Cache TTL for catalog and locations, which change rarely. */
  readonly catalogTtlMs?: number;
}

interface CatalogEntry {
  readonly location: SquareLocation;
  readonly variations: Map<string, MappedVariation>;
  readonly unmapped: string[];
  readonly fetchedAt: number;
}

const DEFAULT_BASE = "https://connect.squareup.com";
const DEFAULT_API_VERSION = "2025-01-23";
// The reference requires 24 hours; sandbox also rejects sub-hour searches.
// Keep the upstream range valid and apply the caller's narrower bounds locally.
const MIN_AVAILABILITY_RANGE_MS = 24 * 60 * 60_000;

/**
 * Square Appointments adapter.
 *
 * Beauty and wellness. Square's model is slot-based and fully documented, so
 * this adapter maps onto Porter's domain closely: real open slots, a real
 * cancellation policy, and native idempotency on CreateBooking.
 *
 * Two mappings are worth knowing about:
 *
 *  - Square has no service taxonomy Porter can trust, because sellers name
 *    their own catalog entries. Categories are inferred by keyword and fall
 *    back to null rather than a guess.
 *  - `providerSlotRef` carries the Square team member id. Square books a
 *    specific person, so dropping it would silently rebook with someone else.
 */
export class SquareAppointmentsAdapter implements ProviderAdapter {
  readonly id: string;
  readonly displayName = "Square Appointments";
  readonly capabilities: AdapterCapabilities;

  readonly #http: HttpClient;
  readonly #baseUrl: string;
  readonly #apiVersion: string;
  readonly #catalogTtlMs: number;
  readonly #catalog = new Map<string, CatalogEntry>();
  readonly #profiles = new Map<string, { value: SquareBusinessBookingProfile; fetchedAt: number }>();

  constructor(options: SquareAdapterOptions) {
    this.id = options.id ?? "square";
    this.#http = options.http;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
    this.#apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
    this.#catalogTtlMs = options.catalogTtlMs ?? 5 * 60_000;

    this.capabilities = {
      // Square has no hold endpoint. Core degrades to optimistic booking with
      // a re-check, which is why holdSlot is optional on the interface.
      slotHold: false,
      // Appointments are priced from the catalog, not quoted.
      quoting: false,
      reschedule: true,
      cancellationPolicy: true,
      // Square has no customer-messaging API for bookings.
      messaging: false,
      remoteBookingList: true,
      categories: SQUARE_CATEGORIES,
      // Square requires the attached Customer to have a phone number.
      requiredCustomerFields: ["givenName", "phone"],
      optionalCustomerFields: ["familyName", "email", "notes"],
    };
  }

  // ------------------------------------------------------------------ reads

  async searchProviders(query: SearchQuery, ctx: AdapterContext): Promise<SearchResult[]> {
    assertNotAborted(ctx.signal, this.id);
    const locations = await this.#locations(ctx);
    const wanted = new Set(query.categories);
    const results: SearchResult[] = [];

    for (const location of locations) {
      const entry = await this.#catalogFor(location, ctx);
      let services = [...entry.variations.values()].map((v) => v.service);

      if (wanted.size > 0) {
        const matched = services.filter((s) => s.category !== null && wanted.has(s.category));
        // Fall back to a text match so a seller's oddly named service is still
        // findable, rather than invisible because it mapped to null.
        services = matched.length > 0 || !query.text ? matched : services.filter((s) => matches(s, query.text!));
      }
      if (query.text) {
        const hits = services.filter((s) => matches(s, query.text!));
        if (hits.length > 0) services = hits;
      }
      if (services.length === 0) continue;

      if (query.maxPriceMinor !== undefined) {
        const priced = services.map((s) => s.price?.amount).filter((v): v is number => v !== undefined);
        if (priced.length > 0 && Math.min(...priced) > query.maxPriceMinor) continue;
      }

      const provider = mapProvider(this.id, location, services, entry.unmapped);
      const next = await this.#firstAvailable(location, services, entry, query.timeWindow?.from ?? ctx.now, ctx);
      results.push(next ? { provider, services, nextAvailable: next } : { provider, services });
      if (results.length >= query.limit) break;
    }
    return results;
  }

  async getAvailability(query: AvailabilityQuery, ctx: AdapterContext): Promise<Slot[]> {
    assertNotAborted(ctx.signal, this.id);
    const { locationId, variation } = await this.#resolveService(query.providerId, query.serviceId, ctx);
    return this.#searchAvailability(locationId, variation, query.from, query.to, query.limit, ctx);
  }

  async checkSlot(
    query: { providerId: string; serviceId: string; startsAt: Date; providerSlotRef?: string },
    ctx: AdapterContext,
  ): Promise<Slot | null> {
    assertNotAborted(ctx.signal, this.id);
    const { locationId, variation } = await this.#resolveService(query.providerId, query.serviceId, ctx, true);

    // A point range is filtered locally after widening Square's request. Match
    // the chosen team member before limiting, even when many people are free.
    const slots = await this.#searchAvailability(
      locationId, variation, query.startsAt, query.startsAt, 1, ctx, query.providerSlotRef,
    );
    return slots[0] ?? null;
  }

  async getCancellationPolicy(bookingRef: string, ctx: AdapterContext): Promise<CancellationPolicy> {
    assertNotAborted(ctx.signal, this.id);
    const booking = await this.#retrieveBooking(bookingRef, ctx);
    const profile = await this.#bookingProfile(ctx, true);
    return mapCancellationPolicy(profile, new Date(booking.start_at ?? ctx.now.toISOString()));
  }

  /** Square's booking profile is account-level, so no booking is needed. */
  async getServiceCancellationPolicy(
    query: { providerId: string; serviceId: string; startsAt: Date },
    ctx: AdapterContext,
  ): Promise<CancellationPolicy> {
    assertNotAborted(ctx.signal, this.id);
    const profile = await this.#bookingProfile(ctx, true);
    return mapCancellationPolicy(profile, query.startsAt);
  }

  async listBookings(query: ListQuery, ctx: AdapterContext): Promise<Booking[]> {
    assertNotAborted(ctx.signal, this.id);
    const params = new URLSearchParams({ limit: String(Math.min(query.limit, 100)) });
    if (query.since) params.set("start_at_min", query.since.toISOString());

    const res = await this.#request<ListBookingsResponse>("GET", `/v2/bookings?${params}`, undefined, ctx);
    const profile = await this.#bookingProfile(ctx);
    const out: Booking[] = [];
    for (const b of res.bookings ?? []) {
      const duration = b.appointment_segments?.[0]?.duration_minutes ?? 60;
      const policy = mapCancellationPolicy(profile, new Date(b.start_at ?? ctx.now.toISOString()));
      out.push(mapBooking(this.id, b, duration, policy, await this.#priceFor(b, ctx)));
    }
    return out;
  }

  // ----------------------------------------------------------------- writes

  async createBooking(request: CreateBookingRequest, ctx: AdapterContext): Promise<Booking> {
    assertNotAborted(ctx.signal, this.id);
    validateIdempotencyKey(request.idempotencyKey);
    const customer = { ...request.customer, phone: normalizeCustomerPhone(request.customer.phone) };
    const { locationId, variation } = await this.#resolveService(request.providerId, request.serviceId, ctx);
    if (request.locationId !== `${this.id}:${locationId}`) {
      throw new PorterError("INVALID_REQUEST", "The appointment location does not match the selected business.");
    }
    const profile = await this.#bookingProfile(ctx, true);
    assertSupportedBooking(profile, variation);
    const teamMemberId = request.providerSlotRef;
    if (!teamMemberId) {
      throw new PorterError("INVALID_REQUEST", "Choose an available appointment before booking.");
    }
    const durationMinutes = appointmentDuration(request.startsAt, request.endsAt);
    const customerId = await this.#ensureCustomer(customer, request.idempotencyKey, ctx);

    const res = await this.#request<BookingResponse>(
      "POST",
      "/v2/bookings",
      {
        // Square supports idempotency natively, so protection is end to end
        // rather than stopping at Porter's boundary.
        idempotency_key: request.idempotencyKey,
        booking: {
          location_id: locationId,
          start_at: request.startsAt.toISOString(),
          customer_id: customerId,
          appointment_segments: [
            {
              duration_minutes: durationMinutes,
              service_variation_id: variation.variationId,
              service_variation_version: variation.variationVersion,
              team_member_id: teamMemberId,
            },
          ],
          ...(request.notes ? { customer_note: request.notes.slice(0, 1500) } : {}),
        },
      },
      ctx,
    );

    const booking = res.booking;
    if (!booking) throw new PorterError("ADAPTER_DOWN", "That business's booking system did not confirm the appointment.");

    return mapBooking(
      this.id,
      booking,
      durationMinutes,
      mapCancellationPolicy(profile, new Date(booking.start_at ?? request.startsAt.toISOString())),
      variation.service.price,
    );
  }

  async rescheduleBooking(request: RescheduleRequest, ctx: AdapterContext): Promise<Booking> {
    assertNotAborted(ctx.signal, this.id);
    validateIdempotencyKey(request.idempotencyKey);
    const existing = await this.#retrieveBooking(request.bookingRef, ctx);
    const { locationId, variation } = await this.#resolveService(request.providerId, request.serviceId, ctx);
    if (existing.location_id !== locationId) throw new PorterError("NOT_FOUND", "We could not find that booking at this business.");
    const profile = await this.#bookingProfile(ctx, true);
    assertSupportedBooking(profile, variation);
    const durationMinutes = appointmentDuration(request.startsAt, request.endsAt);
    const segment = existing.appointment_segments?.[0];
    // Buyer permissions allow a sparse start_at update, but appointment_segments
    // become immutable after creation. Omitting them is safe only when it keeps
    // the requested service, duration, and person exactly as booked. A seller's
    // subscription capability does not grant this token seller permissions.
    if (
      existing.appointment_segments?.length !== 1 ||
      segment?.service_variation_id !== variation.variationId ||
      segment.duration_minutes !== durationMinutes ||
      !segment.team_member_id ||
      (request.providerSlotRef !== undefined && request.providerSlotRef !== segment.team_member_id)
    ) {
      throw new PorterError("UNSUPPORTED_CAPABILITY", "This appointment can only move to a new time with the same service, staff member, and duration. Contact the salon for other changes.");
    }
    if (existing.version === undefined || !Number.isSafeInteger(existing.version) || existing.version < 0) {
      throw new PorterError("ADAPTER_DOWN", "The booking's current version could not be verified. Please try again before making a change.");
    }

    const res = await this.#request<BookingResponse>(
      "PUT",
      `/v2/bookings/${encodeURIComponent(request.bookingRef)}`,
      {
        idempotency_key: request.idempotencyKey,
        booking: {
          // Square uses optimistic concurrency: the version must match, so a
          // booking changed underneath us fails rather than clobbering.
          version: existing.version,
          start_at: request.startsAt.toISOString(),
        },
      },
      ctx,
    );

    const booking = res.booking;
    if (!booking) throw new PorterError("ADAPTER_DOWN", "That business's booking system did not confirm the change.");
    return mapBooking(
      this.id,
      booking,
      durationMinutes,
      mapCancellationPolicy(profile, new Date(booking.start_at ?? request.startsAt.toISOString())),
      variation.service.price,
    );
  }

  async cancelBooking(request: CancelRequest, ctx: AdapterContext): Promise<Booking> {
    assertNotAborted(ctx.signal, this.id);
    validateIdempotencyKey(request.idempotencyKey);
    const existing = await this.#retrieveBooking(request.bookingRef, ctx);
    if (`${this.id}:${existing.location_id}` !== request.providerId) {
      throw new PorterError("NOT_FOUND", "We could not find that booking at this business.");
    }
    const profile = await this.#bookingProfile(ctx, true);

    const res = await this.#request<BookingResponse>(
      "POST",
      `/v2/bookings/${encodeURIComponent(request.bookingRef)}/cancel`,
      { idempotency_key: request.idempotencyKey, booking_version: existing.version },
      ctx,
    );

    const booking = res.booking;
    if (!booking) throw new PorterError("ADAPTER_DOWN", "That business's booking system did not confirm the cancellation.");
    const duration = booking.appointment_segments?.[0]?.duration_minutes ?? 60;
    return mapBooking(
      this.id,
      booking,
      duration,
      mapCancellationPolicy(profile, new Date(booking.start_at ?? ctx.now.toISOString())),
      await this.#priceFor(booking, ctx),
    );
  }

  // --------------------------------------------------------------- internals

  async #request<T>(method: "GET" | "POST" | "PUT", path: string, body: unknown, ctx: AdapterContext): Promise<T> {
    assertNotAborted(ctx.signal, this.id);
    const token = ctx.credentials.accessToken;
    if (!token) {
      throw new PorterError("PROVIDER_UNAVAILABLE", "That business's booking system is not connected.", {
        details: { adapter: this.id },
      });
    }

    let response: HttpResponse;
    try {
      response = await this.#http.send({
        method,
        url: `${this.#baseUrl}${path}`,
        headers: {
          authorization: `Bearer ${token}`,
          "square-version": this.#apiVersion,
        },
        signal: ctx.signal,
        ...(body === undefined ? {} : { body }),
      });
    } catch (error) {
      if (PorterError.is(error)) throw error;
      throw new PorterError("ADAPTER_DOWN", "That booking system is not responding right now. Try again in a moment.", {
        details: { adapter: this.id },
        cause: error,
      });
    }

    const payload = (response.body ?? {}) as T & { errors?: readonly { code: string; category: string; detail?: string }[] };
    if (response.status >= 400 || (payload.errors && payload.errors.length > 0)) {
      throw mapSquareError(response.status, payload.errors, this.id);
    }
    return payload;
  }

  async #locations(ctx: AdapterContext): Promise<SquareLocation[]> {
    const res = await this.#request<ListLocationsResponse>("GET", "/v2/locations", undefined, ctx);
    return (res.locations ?? []).filter((l) => l.status !== "INACTIVE");
  }

  async #catalogFor(location: SquareLocation, ctx: AdapterContext, refresh = false): Promise<CatalogEntry> {
    const cacheKey = `${credentialScope(ctx)}:${location.id}`;
    const cached = this.#catalog.get(cacheKey);
    if (!refresh && cached && ctx.now.getTime() - cached.fetchedAt < this.#catalogTtlMs) return cached;

    const objects: SquareCatalogObject[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const res = await this.#request<SearchCatalogResponse>(
        "POST",
        "/v2/catalog/search",
        { object_types: ["ITEM", "CATEGORY"], include_related_objects: true, ...(cursor ? { cursor } : {}) },
        ctx,
      );
      objects.push(...(res.objects ?? []), ...(res.related_objects ?? []));
      cursor = res.cursor;
      if (cursor && cursors.has(cursor)) {
        throw new PorterError("ADAPTER_DOWN", "That business's service list could not be loaded completely.");
      }
      if (cursor) cursors.add(cursor);
    } while (cursor);
    const categoryNames = new Map<string, string>();
    for (const o of objects) {
      if (o.type === "CATEGORY" && o.category_data?.name) categoryNames.set(o.id, o.category_data.name);
    }

    const variations = new Map<string, MappedVariation>();
    const unmapped: string[] = [];

    for (const item of objects) {
      if (item.type !== "ITEM") continue;
      if (item.item_data?.product_type !== "APPOINTMENTS_SERVICE") continue;
      const categoryName = item.item_data.categories?.[0]?.id ? categoryNames.get(item.item_data.categories[0].id!) : undefined;

      for (const variation of item.item_data.variations ?? []) {
        const mapped = mapServiceVariation(this.id, location.id, item, variation, categoryName);
        if (!mapped) continue;
        variations.set(mapped.variationId, mapped);
        // Track what we could not place, so gaps in the keyword map surface
        // instead of silently shrinking what the agent can find.
        if (mapped.service.category === null) unmapped.push(item.item_data.name ?? variation.id);
      }
    }

    const entry: CatalogEntry = { location, variations, unmapped, fetchedAt: ctx.now.getTime() };
    this.#catalog.set(cacheKey, entry);
    return entry;
  }

  async #resolveService(
    providerId: string,
    serviceId: string,
    ctx: AdapterContext,
    refresh = false,
  ): Promise<{ locationId: string; variation: MappedVariation }> {
    const providerPrefix = `${this.id}:`;
    const servicePrefix = `${providerId}:`;
    if (!providerId.startsWith(providerPrefix) || !serviceId.startsWith(servicePrefix)) {
      throw new PorterError("NOT_FOUND", "We could not find that service at this business.");
    }
    const locationId = providerId.slice(providerPrefix.length);
    const variationId = serviceId.slice(servicePrefix.length);

    const cached = this.#catalog.get(`${credentialScope(ctx)}:${locationId}`);
    const hit = cached?.variations.get(variationId);
    if (!refresh && hit && cached && ctx.now.getTime() - cached.fetchedAt < this.#catalogTtlMs) return { locationId, variation: hit };

    const locations = await this.#locations(ctx);
    const location = locations.find((l) => l.id === locationId);
    if (!location) throw new PorterError("NOT_FOUND", "We could not find that business.");

    const entry = await this.#catalogFor(location, ctx, refresh);
    const variation = entry.variations.get(variationId);
    if (!variation) throw new PorterError("NOT_FOUND", "We could not find that service.");
    return { locationId, variation };
  }

  async #searchAvailability(
    locationId: string,
    variation: MappedVariation,
    from: Date,
    to: Date,
    limit: number,
    ctx: AdapterContext,
    teamMemberId?: string,
  ): Promise<Slot[]> {
    const fromMs = from.getTime();
    const toMs = to.getTime();
    const upstreamTo = new Date(Math.max(toMs, fromMs + MIN_AVAILABILITY_RANGE_MS));
    const res = await this.#request<SearchAvailabilityResponse>(
      "POST",
      "/v2/bookings/availability/search",
      {
        query: {
          filter: {
            start_at_range: { start_at: from.toISOString(), end_at: upstreamTo.toISOString() },
            location_id: locationId,
            segment_filters: [{ service_variation_id: variation.variationId }],
          },
        },
      },
      ctx,
    );

    const out: Slot[] = [];
    for (const a of res.availabilities ?? []) {
      const segment = a.appointment_segments?.[0];
      const startMs = new Date(a.start_at).getTime();
      // The wider provider query must not widen the customer's requested
      // window or replace their chosen person. Filter before counting results.
      if (!Number.isFinite(startMs) || startMs < fromMs || startMs > toMs) continue;
      if (teamMemberId !== undefined && segment?.team_member_id !== teamMemberId) continue;
      const duration = segment?.duration_minutes ?? variation.service.durationMinutes;
      out.push(
        mapSlot(
          this.id,
          a.location_id ?? locationId,
          variation.service.id,
          a.start_at,
          duration,
          ctx.now,
          variation.service.price,
          segment?.team_member_id,
        ),
      );
      if (out.length >= limit) break;
    }
    return out;
  }

  async #firstAvailable(
    location: SquareLocation,
    services: readonly Service[],
    entry: CatalogEntry,
    from: Date,
    ctx: AdapterContext,
  ): Promise<Slot | undefined> {
    const service = services[0];
    if (!service) return undefined;
    const variation = entry.variations.get(service.id.split(":").pop() ?? "");
    if (!variation) return undefined;
    try {
      const slots = await this.#searchAvailability(location.id, variation, from, new Date(from.getTime() + 14 * 24 * 60 * 60_000), 1, ctx);
      return slots[0];
    } catch {
      // A missing "next available" must not blank an otherwise good result.
      return undefined;
    }
  }

  async #bookingProfile(ctx: AdapterContext, refresh = false): Promise<SquareBusinessBookingProfile> {
    const cacheKey = credentialScope(ctx);
    const cached = this.#profiles.get(cacheKey);
    if (!refresh && cached && ctx.now.getTime() - cached.fetchedAt < this.#catalogTtlMs) return cached.value;
    const res = await this.#request<BusinessBookingProfileResponse>("GET", "/v2/bookings/business-booking-profile", undefined, ctx);
    if (!res.business_booking_profile) throw new PorterError("ADAPTER_DOWN", "That business's booking settings could not be loaded.");
    this.#profiles.set(cacheKey, { value: res.business_booking_profile, fetchedAt: ctx.now.getTime() });
    return res.business_booking_profile;
  }

  async #retrieveBooking(bookingRef: string, ctx: AdapterContext) {
    const res = await this.#request<BookingResponse>("GET", `/v2/bookings/${encodeURIComponent(bookingRef)}`, undefined, ctx);
    if (!res.booking) throw new PorterError("NOT_FOUND", "We could not find that booking.");
    return res.booking;
  }

  /**
   * Find or create the Square Customer a booking attaches to.
   *
   * Only the fields core projected for this adapter are sent — Terms 4.3(e).
   * Search-before-create avoids piling up duplicate customer records in the
   * seller's account on every repeat booking.
   */
  async #ensureCustomer(customer: CreateBookingRequest["customer"] & { readonly phone: string }, idempotencyKey: string, ctx: AdapterContext): Promise<string> {
    const found = await this.#request<SearchCustomersResponse>(
      "POST",
      "/v2/customers/search",
      {
        limit: 1,
        query: { filter: {
          phone_number: { exact: customer.phone },
          ...(customer.email ? { email_address: { exact: customer.email } } : {}),
        } },
      },
      ctx,
    );
    const existing = found.customers?.find((entry) => entry.phone_number)?.id;
    if (existing) return existing;

    const created = await this.#request<CustomerResponse>(
      "POST",
      "/v2/customers",
      {
        idempotency_key: createHash("sha256").update(JSON.stringify(["customer", ctx.actorId, idempotencyKey])).digest("hex"),
        ...(customer.givenName ? { given_name: customer.givenName } : {}),
        ...(customer.familyName ? { family_name: customer.familyName } : {}),
        ...(customer.email ? { email_address: customer.email } : {}),
        phone_number: customer.phone,
      },
      ctx,
    );
    const id = created.customer?.id;
    if (!id) throw new PorterError("ADAPTER_DOWN", "That business's booking system could not record your details.");
    return id;
  }

  async #priceFor(booking: { appointment_segments?: readonly { service_variation_id?: string }[]; location_id?: string }, ctx: AdapterContext): Promise<Money | undefined> {
    const variationId = booking.appointment_segments?.[0]?.service_variation_id;
    const locationId = booking.location_id;
    if (!variationId || !locationId) return undefined;
    const entry = this.#catalog.get(`${credentialScope(ctx)}:${locationId}`);
    const price = entry?.variations.get(variationId)?.service.price;
    if (price) return price;
    return undefined;
  }
}

function matches(service: Service, text: string): boolean {
  const q = text.toLowerCase();
  return String(service.name).toLowerCase().includes(q) || String(service.description ?? "").toLowerCase().includes(q);
}

function credentialScope(ctx: AdapterContext): string {
  const token = ctx.credentials.accessToken;
  if (!token) throw new PorterError("PROVIDER_UNAVAILABLE", "That business's booking system is not connected.");
  return createHash("sha256").update(token).digest("hex");
}

function validateIdempotencyKey(key: string): void {
  if (!key || key.length > 255) {
    throw new PorterError("INVALID_REQUEST", "The booking request needs a valid idempotency key.");
  }
}

/** Exact customer search requires an explicit international country code. */
function normalizeCustomerPhone(value: string | undefined): string {
  const phone = value?.trim().replace(/[ ()-]/g, "") ?? "";
  if (!/^\+[1-9]\d{1,14}$/.test(phone)) {
    throw new PorterError("INVALID_REQUEST", "Provide a phone number with + and its country code, such as +14155550100.");
  }
  return phone;
}

function appointmentDuration(startsAt: Date, endsAt: Date): number {
  const minutes = (endsAt.getTime() - startsAt.getTime()) / 60_000;
  if (!Number.isSafeInteger(minutes) || minutes <= 0) throw new PorterError("INVALID_REQUEST", "Choose a valid appointment duration.");
  return minutes;
}

function assertSupportedBooking(profile: SquareBusinessBookingProfile, variation: MappedVariation): void {
  if (profile.booking_enabled !== true || !profile.business_appointment_settings) {
    throw new PorterError("PROVIDER_UNAVAILABLE", "Online booking is not configured for this business.");
  }
  if ((profile.business_appointment_settings.cancellation_fee_money?.amount ?? 0) > 0) {
    throw new PorterError("POLICY_BLOCKED", "This business requires a cancellation fee and cannot be booked through Porter.");
  }
  if (!variation.service.price || variation.service.quoteRequired) {
    throw new PorterError("QUOTE_REQUIRED", "This service needs a confirmed price before it can be booked.");
  }
}

/** Beauty and wellness only. Square Appointments does not serve home trades. */
const SQUARE_CATEGORIES: readonly ServiceCategory[] = [
  "beauty.haircut",
  "beauty.hair.color",
  "beauty.hair.styling",
  "beauty.barber",
  "beauty.nails.manicure",
  "beauty.nails.pedicure",
  "beauty.waxing",
  "beauty.massage",
  "beauty.facial",
  "beauty.makeup",
  "beauty.lashes",
];

export function createSquareAdapter(options: SquareAdapterOptions): SquareAppointmentsAdapter {
  return new SquareAppointmentsAdapter(options);
}

export function squareMoney(amount: number, currency = "USD"): Money {
  return money(amount, currency);
}

export { serviceDurationMinutes };
