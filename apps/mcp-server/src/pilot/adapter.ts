import { createSquareAdapter, mapSquareError, type BookingResponse, type BusinessBookingProfileResponse, type SquareBooking } from "@porter/adapter-square-appointments";
import type {
  AdapterCapabilities, AdapterContext, AvailabilityQuery, Booking, CancelRequest,
  CancellationPolicy, CancellationValidation, CancellationValidationRequest, CreateBookingRequest, ProviderAdapter, RescheduleRequest,
  RescheduleValidation, RescheduleValidationRequest, SearchQuery, SearchResult, Service, ServiceDescription, Slot,
} from "@porter/core";
import type { PilotBusiness, PilotStore, SquareEnvironment } from "@porter/db";
import { assertNotAborted, createFetchHttpClient, PorterError, sanitize, stableHash, untrusted, type HttpClient } from "@porter/shared";
import type { MerchantConnections } from "./connections.js";

export interface PilotSquareAdapterOptions {
  readonly store: PilotStore;
  readonly connections: Pick<MerchantConnections, "credentials">;
  readonly environment: SquareEnvironment;
  readonly http?: HttpClient;
}

const ID = "pilot-square";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const RAW_ID = /^[A-Za-z0-9_-]{1,128}$/;
type Purpose = "new" | "manage";
interface Scope {
  readonly business: PilotBusiness;
  readonly providerId: string;
  readonly innerProviderId: string;
  readonly inner: ProviderAdapter;
  readonly context: AdapterContext;
  readonly http: HttpClient;
  readonly baseUrl: string;
}

/**
 * The pilot's tenant boundary. Only persisted business IDs select merchant
 * credentials; caller-supplied AdapterContext credentials are always ignored.
 * Existing-booking ownership remains the engine/BookingStore's responsibility.
 */
export class PilotSquareAdapter implements ProviderAdapter {
  readonly id = ID;
  readonly displayName = "Porter salon pilot";
  readonly capabilities: AdapterCapabilities;
  readonly #store: PilotStore;
  readonly #connections: Pick<MerchantConnections, "credentials">;
  readonly #environment: SquareEnvironment;
  readonly #http: HttpClient;

  constructor(options: PilotSquareAdapterOptions) {
    this.#store = options.store;
    this.#connections = options.connections;
    this.#environment = options.environment;
    this.#http = options.http ?? createFetchHttpClient({
      maxRetries: 0,
      fetchImpl: (input, init) => fetch(input, { ...init, redirect: "error" }),
    });
    this.capabilities = {
      ...createSquareAdapter({ http: this.#http }).capabilities,
      remoteBookingList: false, quoting: false, messaging: false,
    };
  }

  async searchProviders(query: SearchQuery, ctx: AdapterContext): Promise<SearchResult[]> {
    assertNotAborted(ctx.signal, ID);
    const results: SearchResult[] = [];
    const limit = Math.max(0, Math.min(query.limit, 50));
    if (!limit) return results;
    const wantedName = query.text?.trim().toLocaleLowerCase("en-US");
    for (const candidate of await this.#store.businesses.listActive()) {
      if (wantedName && !sanitize(candidate.name).toLocaleLowerCase("en-US").includes(wantedName)) continue;
      try {
        // Re-read rather than trusting a list snapshot that may now be paused.
        const scope = await this.#scope(candidate.id, "new", ctx);
        const found = await scope.inner.searchProviders({ ...query, text: undefined, limit: 1 }, scope.context);
        const hit = found.find((result) => result.provider.id === scope.innerProviderId);
        if (!hit) continue;
        const services = hit.services.filter((service) => this.#enabled(scope, service.id) && supportedService(service)).map((service) => publicService(scope, service));
        if (!services.length) continue;
        if (query.maxPriceMinor !== undefined && services.every((service) => service.price!.amount > query.maxPriceMinor!)) continue;
        const location = hit.provider.locations.find((entry) => entry.id === scope.innerProviderId);
        if (!location || location.address.countryCode !== "US") continue;
        if (query.near && "postalCode" in query.near && sanitize(location.address.postalCode).toLowerCase() !== query.near.postalCode.trim().toLowerCase()) continue;
        const description = typeof scope.business.profile.description === "string" ? scope.business.profile.description : hit.provider.description;
        const next = hit.nextAvailable && services.some((service) => service.id === publicServiceId(scope, hit.nextAvailable!.serviceId)) && supportedSlot(hit.nextAvailable)
          ? publicSlot(scope, hit.nextAvailable) : undefined;
        results.push({
          provider: {
            ...hit.provider, id: scope.providerId, adapterId: ID,
            name: untrusted(sanitize(scope.business.name, { maxLength: 160 })),
            categories: [...new Set(services.flatMap((service) => service.category ? [service.category] : []))],
            ...(description ? { description: untrusted(sanitize(description, { maxLength: 1_000 })) } : {}),
            locations: [{ ...location, id: scope.providerId }],
          },
          services, ...(next ? { nextAvailable: next } : {}),
        });
        if (results.length >= limit) break;
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        // One inaccessible merchant must not hide other invited businesses.
        ctx.log.warn("pilot_business_unavailable", { businessId: candidate.id, code: PorterError.is(error) ? error.code : "unknown" });
      }
    }
    return results;
  }

  async getAvailability(query: AvailabilityQuery, ctx: AdapterContext): Promise<Slot[]> {
    const businessId = businessFromProvider(query.providerId);
    const variation = variationFromService(query.serviceId, businessId);
    const scope = await this.#scope(businessId, "new", ctx, variation);
    const slots = await scope.inner.getAvailability({ ...query, providerId: scope.innerProviderId, serviceId: innerServiceId(scope, variation) }, scope.context);
    return slots.filter(supportedSlot).map((slot) => publicSlot(scope, slot, variation));
  }

  async checkSlot(query: { providerId: string; serviceId: string; startsAt: Date; providerSlotRef?: string }, ctx: AdapterContext): Promise<Slot | null> {
    const businessId = businessFromProvider(query.providerId);
    const variation = variationFromService(query.serviceId, businessId);
    const scope = await this.#scope(businessId, "new", ctx, variation);
    const slot = await scope.inner.checkSlot({ ...query, providerId: scope.innerProviderId, serviceId: innerServiceId(scope, variation) }, scope.context);
    return slot && supportedSlot(slot) ? publicSlot(scope, slot, variation) : null;
  }

  async getAvailabilityForBooking(query: AvailabilityQuery & { bookingRef: string }, ctx: AdapterContext): Promise<Slot[]> {
    const businessId = businessFromProvider(query.providerId);
    const variation = variationFromService(query.serviceId, businessId);
    const reference = rawBookingRef(query.bookingRef, businessId);
    const scope = await this.#scope(businessId, "manage", ctx, variation);
    const existing = await readExisting(scope, reference, variation);
    const segment = existing.appointment_segments![0]!;
    const slots = await scope.inner.getAvailability({
      ...query, providerId: scope.innerProviderId, serviceId: innerServiceId(scope, variation), providerSlotRef: segment.team_member_id!,
    }, scope.context);
    return slots.filter((slot) => supportedSlot(slot) && slot.providerSlotRef === segment.team_member_id && durationMinutes(slot) === segment.duration_minutes)
      .map((slot) => publicSlot(scope, slot, variation));
  }

  async validateReschedule(request: RescheduleValidationRequest, ctx: AdapterContext): Promise<RescheduleValidation> {
    const businessId = businessFromProvider(request.providerId);
    const variation = variationFromService(request.serviceId, businessId);
    const reference = rawBookingRef(request.bookingRef, businessId);
    const scope = await this.#scope(businessId, "manage", ctx, variation);
    const existing = await readExisting(scope, reference, variation);
    const segment = existing.appointment_segments![0]!;
    if (durationMinutes(request) !== segment.duration_minutes || (request.providerSlotRef !== undefined && request.providerSlotRef !== segment.team_member_id)) throw unsupportedMove();
    const fresh = await scope.inner.checkSlot({ providerId: scope.innerProviderId, serviceId: innerServiceId(scope, variation), startsAt: request.startsAt, providerSlotRef: segment.team_member_id! }, scope.context);
    if (!fresh) throw new PorterError("SLOT_TAKEN", "That appointment time is unavailable. Find another time for the same booking.");
    if (!supportedSlot(fresh) || durationMinutes(fresh) !== segment.duration_minutes || fresh.providerSlotRef !== segment.team_member_id) throw unsupportedMove();
    const policy = await scope.inner.getServiceCancellationPolicy!({ providerId: scope.innerProviderId, serviceId: innerServiceId(scope, variation), startsAt: fresh.startsAt }, scope.context);
    return { slot: publicSlot(scope, fresh, variation), cancellationPolicy: policy, bookingState: bookingState(existing) };
  }

  async describeService(query: { providerId: string; serviceId: string }, ctx: AdapterContext): Promise<ServiceDescription> {
    const businessId = businessFromProvider(query.providerId);
    const variation = variationFromService(query.serviceId, businessId);
    const scope = await this.#scope(businessId, "new", ctx, variation);
    const found = await scope.inner.searchProviders({ categories: [], limit: 1 }, scope.context);
    const service = found.find((entry) => entry.provider.id === scope.innerProviderId)?.services.find((entry) => entry.id === innerServiceId(scope, variation));
    if (!service || !supportedService(service)) throw notFound();
    return { service: publicService(scope, service), providerName: sanitize(scope.business.name, { maxLength: 160 }) };
  }

  async createBooking(request: CreateBookingRequest, ctx: AdapterContext): Promise<Booking> {
    const businessId = businessFromProvider(request.providerId);
    if (request.locationId !== request.providerId) throw notFound();
    const variation = variationFromService(request.serviceId, businessId);
    const scope = await this.#scope(businessId, "new", ctx, variation);
    const booking = await scope.inner.createBooking({
      ...request, providerId: scope.innerProviderId, locationId: scope.innerProviderId, serviceId: innerServiceId(scope, variation),
    }, scope.context);
    return publicBooking(scope, booking, variation);
  }

  async rescheduleBooking(request: RescheduleRequest, ctx: AdapterContext): Promise<Booking> {
    const businessId = businessFromProvider(request.providerId);
    const variation = variationFromService(request.serviceId, businessId);
    const bookingRef = rawBookingRef(request.bookingRef, businessId);
    const scope = await this.#scope(businessId, "manage", ctx, variation, request.expectedBookingState);
    const booking = await scope.inner.rescheduleBooking({
      ...request, providerId: scope.innerProviderId, serviceId: innerServiceId(scope, variation), bookingRef,
    }, scope.context);
    return publicBooking(scope, booking, variation, bookingRef);
  }

  async cancelBooking(request: CancelRequest, ctx: AdapterContext): Promise<Booking> {
    const businessId = businessFromProvider(request.providerId);
    const bookingRef = rawBookingRef(request.bookingRef, businessId);
    const scope = await this.#scope(businessId, "manage", ctx, undefined, request.expectedBookingState);
    const existing = await readExisting(scope, bookingRef);
    await assertCancellationServiceFee(scope, existing.appointment_segments![0]!.service_variation_id!, this.#http);
    return publicBooking(scope, await scope.inner.cancelBooking({ ...request, providerId: scope.innerProviderId, bookingRef }, scope.context), undefined, bookingRef);
  }

  async validateCancellation(request: CancellationValidationRequest, ctx: AdapterContext): Promise<CancellationValidation> {
    const businessId = businessFromProvider(request.providerId);
    const variation = variationFromService(request.serviceId, businessId);
    const reference = rawBookingRef(request.bookingRef, businessId);
    const scope = await this.#scope(businessId, "manage", ctx);
    const existing = await readExisting(scope, reference, variation);
    await assertCancellationServiceFee(scope, variation, this.#http);
    const startsAt = new Date(existing.start_at!);
    const endsAt = new Date(startsAt.getTime() + existing.appointment_segments![0]!.duration_minutes! * 60_000);
    const cancellationPolicy = await scope.inner.getServiceCancellationPolicy!({ providerId: scope.innerProviderId, serviceId: innerServiceId(scope, variation), startsAt }, scope.context);
    return { startsAt, endsAt, cancellationPolicy, bookingState: bookingState(existing) };
  }

  async getCancellationPolicy(bookingRef: string, ctx: AdapterContext): Promise<CancellationPolicy> {
    const businessId = bookingRef.split(":")[0] ?? "";
    const raw = rawBookingRef(bookingRef, businessId);
    const scope = await this.#scope(businessId, "manage", ctx);
    const existing = await readExisting(scope, raw);
    const variation = existing.appointment_segments![0]!.service_variation_id!;
    await assertCancellationServiceFee(scope, variation, this.#http);
    return scope.inner.getServiceCancellationPolicy!({ providerId: scope.innerProviderId, serviceId: innerServiceId(scope, variation), startsAt: new Date(existing.start_at!) }, scope.context);
  }

  async getServiceCancellationPolicy(query: { providerId: string; serviceId: string; startsAt: Date }, ctx: AdapterContext): Promise<CancellationPolicy> {
    const businessId = businessFromProvider(query.providerId);
    const variation = variationFromService(query.serviceId, businessId);
    const scope = await this.#scope(businessId, "new", ctx, variation);
    return scope.inner.getServiceCancellationPolicy!({ ...query, providerId: scope.innerProviderId, serviceId: innerServiceId(scope, variation) }, scope.context);
  }

  async #scope(businessId: string, purpose: Purpose, ctx: AdapterContext, variation?: string, expectedBookingState?: string): Promise<Scope> {
    assertNotAborted(ctx.signal, ID);
    if (!UUID.test(businessId)) throw notFound();
    const business = await this.#store.businesses.getById(businessId);
    if (!business || !business.selectedLocationId || !RAW_ID.test(business.selectedLocationId)) throw notFound();
    if (purpose === "new") {
      if (business.status !== "active") throw unavailable();
      if (business.profile.policyReviewed !== true || business.profile.noPaymentObligations !== true) throw new PorterError("POLICY_BLOCKED", "This salon's booking policies need review before new appointments can be booked.");
      if (variation && !enabledIds(business).has(variation)) throw notFound();
    } else if (business.status !== "active" && business.status !== "paused") throw unavailable();
    const credentials = await this.#connections.credentials(businessId, ctx.signal);
    if (credentials.businessId !== businessId || credentials.environment !== this.#environment || credentials.status !== "connected" || !credentials.accessToken || credentials.expiresAt.getTime() <= ctx.now.getTime()) throw unavailable();
    const http = selectedLocationClient(this.#http, business.selectedLocationId, purpose === "new" || variation !== undefined, variation, expectedBookingState);
    const baseUrl = this.#environment === "sandbox" ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com";
    const inner = createSquareAdapter({ http, baseUrl });
    return {
      business, inner, http, baseUrl, providerId: `${ID}:${business.id}`, innerProviderId: `square:${business.selectedLocationId}`,
      context: { ...ctx, credentials: { accessToken: credentials.accessToken } },
    };
  }

  #enabled(scope: Scope, serviceId: string): boolean {
    const variation = rawVariation(scope, serviceId);
    return enabledIds(scope.business).has(variation);
  }
}

/** Limit every inner catalog/discovery operation to the reviewed location. */
function selectedLocationClient(http: HttpClient, locationId: string, requireBusinessLocation: boolean, selectedVariation?: string, expectedBookingState?: string): HttpClient {
  return { async send(request) {
    const response = await http.send(request);
    if (response.status < 200 || response.status >= 300 || !response.body || typeof response.body !== "object") return response;
    const body = response.body as Record<string, unknown>;
    const path = new URL(request.url).pathname;
    if (path === "/v2/bookings/business-booking-profile") {
      const profile = body as BusinessBookingProfileResponse;
      const settings = profile.business_booking_profile?.business_appointment_settings;
      // Applies to both policy preflight and the inner adapter's last profile
      // read before a mutation. Never let the pilot enter core's fee gateway.
      const feeFailure = paymentFeeFailure(settings?.cancellation_fee_money, "cancellation");
      if (feeFailure) throw feeFailure;
      const locationTypes = record(settings)?.location_types;
      // A salon changing where appointments occur must not turn an existing
      // confirmation into an at-home or phone appointment. Cancellation remains
      // available when only the permitted location types have changed.
      if (requireBusinessLocation && locationTypes !== undefined && (!Array.isArray(locationTypes) || !locationTypes.includes("BUSINESS_LOCATION"))) {
        throw new PorterError("POLICY_BLOCKED", "This salon no longer supports appointments at its business location. Contact the salon before booking or moving an appointment.");
      }
    }
    if (path === "/v2/catalog/search") {
      const filter = (objects: unknown) => Array.isArray(objects) ? objects.map((value: unknown) => {
        const item = record(value);
        const data = record(item?.item_data);
        if (item?.type !== "ITEM" || data?.product_type !== "APPOINTMENTS_SERVICE" || !Array.isArray(data.variations)) return value;
        const variations = data.variations.filter((entry: unknown) => {
          const variation = record(entry);
          const failure = paymentFeeFailure(record(variation?.item_variation_data)?.no_show_fee, "no-show");
          if (failure && variation?.id === selectedVariation) throw failure;
          return !failure;
        });
        return { ...item, item_data: { ...data, variations } };
      }) : objects;
      // Exclude only the affected variation from discovery. A different service
      // with a fee must not hide the salon's eligible pay-at-salon services.
      return { ...response, body: { ...body,
        ...(body.objects !== undefined ? { objects: filter(body.objects) } : {}),
        ...(body.related_objects !== undefined ? { related_objects: filter(body.related_objects) } : {}),
      } };
    }
    if (path === "/v2/locations" && Array.isArray(body.locations)) {
      return { ...response, body: { ...body, locations: body.locations.filter((value: unknown) => value && typeof value === "object" && (value as Record<string, unknown>).id === locationId) } };
    }
    // Retrieval for policy has no providerId argument; verify location here too.
    if (/^\/v2\/bookings(?:\/[^/]+(?:\/cancel)?)?$/.test(path) && body.booking && typeof body.booking === "object") {
      if ((body.booking as Record<string, unknown>).location_id !== locationId) throw notFound();
      if (request.method === "GET" && expectedBookingState && bookingState(body.booking as SquareBooking) !== expectedBookingState) throw new PorterError("CONFIRMATION_STALE", "This appointment changed after it was confirmed. Review its current details before trying again.");
    }
    return response;
  } };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Missing amounts stay unknown; explicit positive or malformed fees fail closed. */
function paymentFeeFailure(value: unknown, kind: "cancellation" | "no-show"): PorterError | null {
  if (value === undefined) return null;
  const fee = record(value);
  if (!fee || (fee.amount !== undefined && (typeof fee.amount !== "number" || !Number.isSafeInteger(fee.amount) || fee.amount < 0))) {
    return new PorterError("POLICY_BLOCKED", `This salon's ${kind} fee could not be verified. Contact the salon before booking, changing or cancelling an appointment.`);
  }
  if (typeof fee.amount === "number" && fee.amount > 0) {
    return new PorterError("POLICY_BLOCKED", `This service requires a ${kind} fee. Contact the salon; Porter cannot collect fees during the pilot.`);
  }
  return null;
}

function businessFromProvider(providerId: string): string {
  const parts = providerId.split(":");
  if (parts.length !== 2 || parts[0] !== ID || !UUID.test(parts[1] ?? "")) throw notFound();
  return parts[1]!;
}
function variationFromService(serviceId: string, businessId: string): string {
  const prefix = `${ID}:${businessId}:`;
  const variation = serviceId.startsWith(prefix) ? serviceId.slice(prefix.length) : "";
  if (!RAW_ID.test(variation)) throw notFound();
  return variation;
}
function rawBookingRef(reference: string, businessId: string): string {
  const prefix = `${businessId}:`;
  const raw = reference.startsWith(prefix) ? reference.slice(prefix.length) : "";
  if (!UUID.test(businessId) || !RAW_ID.test(raw)) throw notFound();
  return raw;
}
function enabledIds(business: PilotBusiness): Set<string> {
  const values = business.profile.enabledServiceIds;
  return new Set(Array.isArray(values) ? values.filter((id): id is string => typeof id === "string" && RAW_ID.test(id)).slice(0, 500) : []);
}
function innerServiceId(scope: Scope, variation: string): string { return `${scope.innerProviderId}:${variation}`; }
function rawVariation(scope: Scope, serviceId: string): string {
  const prefix = `${scope.innerProviderId}:`;
  const raw = serviceId.startsWith(prefix) ? serviceId.slice(prefix.length) : "";
  if (!RAW_ID.test(raw)) throw new PorterError("ADAPTER_DOWN", "Square returned a service for a different salon.");
  return raw;
}
function publicServiceId(scope: Scope, serviceId: string): string { return `${scope.providerId}:${rawVariation(scope, serviceId)}`; }
function publicService(scope: Scope, service: Service): Service {
  assertLocation(scope, service);
  return { ...service, id: publicServiceId(scope, service.id), providerId: scope.providerId, locationId: scope.providerId };
}
function publicSlot(scope: Scope, slot: Slot, variation?: string): Slot {
  assertLocation(scope, slot);
  if (variation !== undefined && rawVariation(scope, slot.serviceId) !== variation) throw new PorterError("ADAPTER_DOWN", "Square returned a different service than requested.");
  return { ...slot, providerId: scope.providerId, locationId: scope.providerId, serviceId: publicServiceId(scope, slot.serviceId) };
}
function publicBooking(scope: Scope, booking: Booking, variation?: string, expectedRef?: string): Booking {
  assertLocation(scope, booking);
  if (!RAW_ID.test(booking.providerBookingRef) || (expectedRef !== undefined && booking.providerBookingRef !== expectedRef) || (variation !== undefined && rawVariation(scope, booking.serviceId) !== variation)) throw new PorterError("ADAPTER_DOWN", "Square returned an unexpected booking. Its outcome needs to be checked before trying again.");
  const reference = `${scope.business.id}:${booking.providerBookingRef}`;
  return { ...booking, id: reference, adapterId: ID, providerId: scope.providerId, locationId: scope.providerId, serviceId: publicServiceId(scope, booking.serviceId), providerBookingRef: reference };
}
function assertLocation(scope: Scope, value: { providerId: string; locationId: string }): void {
  if (value.providerId !== scope.innerProviderId || value.locationId !== scope.innerProviderId) throw new PorterError("ADAPTER_DOWN", "Square returned an appointment for a different salon.");
}
function supportedService(service: Service): boolean {
  return !service.quoteRequired && !service.depositRequired && service.durationMinutes > 0 && Number.isFinite(service.durationMinutes) && supportedPrice(service.price);
}
function supportedSlot(slot: Slot): boolean { return supportedPrice(slot.price) && slot.endsAt.getTime() > slot.startsAt.getTime(); }
function supportedPrice(price: Service["price"]): boolean { return Boolean(price && price.currency === "USD" && Number.isSafeInteger(price.amount) && price.amount >= 0); }
function durationMinutes(value: { startsAt: Date; endsAt: Date }): number { return (value.endsAt.getTime() - value.startsAt.getTime()) / 60_000; }

async function readExisting(scope: Scope, reference: string, variation?: string): Promise<SquareBooking> {
  const response = await scope.http.send({ method: "GET", url: `${scope.baseUrl}/v2/bookings/${encodeURIComponent(reference)}`,
    headers: { authorization: `Bearer ${scope.context.credentials.accessToken}`, "square-version": "2025-01-23" }, signal: scope.context.signal });
  const payload = (response.body ?? {}) as BookingResponse;
  if (response.status >= 400 || payload.errors?.length) throw mapSquareError(response.status, payload.errors, ID);
  const booking = payload.booking;
  if (!booking || booking.id !== reference || booking.location_id !== scope.business.selectedLocationId) throw notFound();
  if (booking.status !== "ACCEPTED" && booking.status !== "PENDING") throw new PorterError("INVALID_REQUEST", "This appointment is no longer active. Contact the salon if you need help.");
  const segment = booking.appointment_segments?.[0];
  if (booking.appointment_segments?.length !== 1 || !segment?.service_variation_id || !RAW_ID.test(segment.service_variation_id)
    || (variation !== undefined && segment.service_variation_id !== variation) ||
    !segment.team_member_id || !RAW_ID.test(segment.team_member_id) || !Number.isSafeInteger(segment.duration_minutes) || segment.duration_minutes! <= 0) throw unsupportedMove();
  if (booking.version === undefined || !Number.isSafeInteger(booking.version) || booking.version < 0 || !Number.isFinite(Date.parse(booking.start_at ?? ""))) throw new PorterError("ADAPTER_DOWN", "The existing appointment's current state could not be verified.");
  return booking;
}

/** Cancellation must inspect the booked variation even after it is disabled or archived. */
async function assertCancellationServiceFee(scope: Scope, variation: string, http: HttpClient): Promise<void> {
  let cursor: string | undefined;
  const seen = new Set<string>();
  let found = false;
  let records = 0;
  const signal = AbortSignal.any([scope.context.signal, AbortSignal.timeout(20_000)]);
  for (let page = 0; page < 20; page++) {
    assertNotAborted(signal, ID);
    const response = await http.send({ method: "POST", url: `${scope.baseUrl}/v2/catalog/search`,
      headers: { authorization: `Bearer ${scope.context.credentials.accessToken}`, "square-version": "2025-01-23" },
      body: { object_types: ["ITEM"], include_related_objects: true, ...(cursor ? { cursor } : {}) }, signal });
    const payload = record(response.body);
    if (response.status >= 400) throw mapSquareError(response.status, undefined, ID);
    if (!payload || (payload.errors !== undefined && (!Array.isArray(payload.errors) || payload.errors.length > 0))) throw cancellationFeeUnavailable();
    for (const field of ["objects", "related_objects"] as const) {
      const objects = payload[field];
      if (objects !== undefined && !Array.isArray(objects)) throw cancellationFeeUnavailable();
      for (const value of objects ?? []) {
        if (++records > 5_000) throw cancellationFeeUnavailable();
        const object = record(value);
        const entries = object?.type === "ITEM_VARIATION" ? [object] : record(object?.item_data)?.variations;
        if (entries !== undefined && !Array.isArray(entries)) throw cancellationFeeUnavailable();
        for (const entry of entries ?? []) {
          const item = record(entry);
          if (item?.id !== variation) continue;
          const data = record(item.item_variation_data);
          if (!data) throw cancellationFeeUnavailable();
          const failure = paymentFeeFailure(data.no_show_fee, "no-show");
          if (failure) throw failure;
          found = true;
        }
      }
    }
    if (payload.cursor === undefined || payload.cursor === "") {
      if (!found) throw cancellationFeeUnavailable();
      return;
    }
    if (typeof payload.cursor !== "string" || payload.cursor.length > 65_536 || seen.has(payload.cursor)) throw cancellationFeeUnavailable();
    cursor = payload.cursor;
    seen.add(cursor);
  }
  throw cancellationFeeUnavailable();
}

function cancellationFeeUnavailable(): PorterError {
  return new PorterError("POLICY_BLOCKED", "This appointment's current service fee could not be verified. Contact the salon before cancelling.");
}

function bookingState(booking: SquareBooking): string {
  return stableHash({ id: booking.id, version: booking.version, status: booking.status, location: booking.location_id, start: booking.start_at, segments: booking.appointment_segments });
}
function unsupportedMove(): PorterError {
  return new PorterError("UNSUPPORTED_CAPABILITY", "This appointment can only move to a new time with the same service, staff member, and duration. Contact the salon for other changes.");
}
function notFound(): PorterError { return new PorterError("NOT_FOUND", "We could not find that appointment or service at this salon."); }
function unavailable(): PorterError { return new PorterError("PROVIDER_UNAVAILABLE", "This salon is not accepting new bookings through Porter. Contact the salon for help with existing appointments."); }

export function createPilotSquareAdapter(options: PilotSquareAdapterOptions): PilotSquareAdapter { return new PilotSquareAdapter(options); }
