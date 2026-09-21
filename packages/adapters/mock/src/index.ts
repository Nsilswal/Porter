import {
  PorterError,
  money,
  untrusted,
  type Money,
} from "@porter/shared";
import type {
  Booking,
  CancellationPolicy,
  Provider,
  Quote,
  ServiceCategory,
  Service,
  Slot,
  SlotHold,
  Location,
} from "@porter/core";
import type {
  AdapterCapabilities,
  AdapterContext,
  AvailabilityQuery,
  CancelRequest,
  CreateBookingRequest,
  ListQuery,
  MessageReceipt,
  MessageRequest,
  ProviderAdapter,
  QuoteRequest,
  RescheduleRequest,
  SearchQuery,
  SearchResult,
} from "@porter/adapter-contract";
import { MOCK_BUSINESSES, type MockBusinessSeed, type MockServiceSeed } from "./data.js";

export { MOCK_BUSINESSES } from "./data.js";
export type { MockBusinessSeed, MockServiceSeed } from "./data.js";

export type MockFailureMode = "none" | "transport" | "slot_taken" | "not_found" | "rate_limited";

export interface MockAdapterOptions {
  readonly id?: string;
  readonly businesses?: readonly MockBusinessSeed[];
  /** Artificial latency per call, in milliseconds. */
  readonly latencyMs?: number;
  /** Probability in [0,1] that a call fails with `failureMode`. */
  readonly failureRate?: number;
  readonly failureMode?: MockFailureMode;
  /** Deterministic seed, so availability and failures repeat across runs. */
  readonly seed?: number;
  /** Slot granularity in minutes. */
  readonly slotStepMinutes?: number;
  /** Pretend this platform cannot do these things. */
  readonly capabilityOverrides?: Partial<AdapterCapabilities>;
}

interface BookingRecord {
  ref: string;
  providerKey: string;
  serviceKey: string;
  locationId: string;
  startsAt: Date;
  endsAt: Date;
  status: Booking["status"];
  priceMinor: number | null;
  depositMinor: number | null;
  createdAt: Date;
  updatedAt: Date;
  idempotencyKey: string;
}

/** Small deterministic PRNG, so a seeded adapter behaves identically each run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const MINUTE = 60_000;

/**
 * A realistic fake booking platform.
 *
 * It backs the unit tests, the integration tests, and the demo mode that a
 * Meta reviewer exercises — the platform page promises "end to end testing",
 * so a reviewer must be able to complete a full lifecycle without a real
 * Square or Jobber account.
 *
 * Availability is derived deterministically from business hours plus a seeded
 * PRNG, so the same seed always yields the same open slots. Bookings mutate
 * in-process state, so a booked slot really does disappear.
 */
export class MockAdapter implements ProviderAdapter {
  readonly id: string;
  readonly displayName = "Mock Booking Platform";
  readonly capabilities: AdapterCapabilities;

  readonly #businesses: readonly MockBusinessSeed[];
  readonly #byKey: Map<string, MockBusinessSeed>;
  readonly #bookings = new Map<string, BookingRecord>();
  readonly #taken = new Set<string>();
  readonly #holds = new Map<string, { key: string; expiresAt: Date }>();
  readonly #messages: { ref: string; bookingRef: string; at: Date }[] = [];
  readonly #options: Required<Omit<MockAdapterOptions, "capabilityOverrides" | "businesses" | "id">>;
  #counter = 0;

  constructor(options: MockAdapterOptions = {}) {
    this.id = options.id ?? "mock";
    this.#businesses = options.businesses ?? MOCK_BUSINESSES;
    this.#byKey = new Map(this.#businesses.map((b) => [b.key, b]));
    this.#options = {
      latencyMs: options.latencyMs ?? 0,
      failureRate: options.failureRate ?? 0,
      failureMode: options.failureMode ?? "none",
      seed: options.seed ?? 20260921,
      slotStepMinutes: options.slotStepMinutes ?? 30,
    };

    const categories = [...new Set(this.#businesses.flatMap((b) => b.services.map((s) => s.category)))];
    this.capabilities = {
      slotHold: true,
      quoting: true,
      reschedule: true,
      cancellationPolicy: true,
      messaging: true,
      remoteBookingList: true,
      categories,
      // A booking needs a name and one way to reach the customer. Address is
      // only needed for mobile trades, so it is optional here and core will
      // not forward it unless it is present.
      requiredCustomerFields: ["givenName", "phone"],
      optionalCustomerFields: ["familyName", "email", "addressLine1", "addressLine2", "city", "region", "postalCode", "notes"],
      ...options.capabilityOverrides,
    };
  }

  // ------------------------------------------------------------------ reads

  async searchProviders(query: SearchQuery, ctx: AdapterContext): Promise<SearchResult[]> {
    await this.#gate(ctx, "search");
    const wanted = new Set(query.categories);
    const text = query.text?.trim().toLowerCase();

    const results: SearchResult[] = [];
    for (const biz of this.#businesses) {
      const services = biz.services.filter((s) => (wanted.size === 0 ? true : wanted.has(s.category)));
      if (services.length === 0) continue;

      if (text && !`${biz.name} ${biz.description}`.toLowerCase().includes(text)) {
        const serviceHit = services.some((s) => s.name.toLowerCase().includes(text));
        if (!serviceHit) continue;
      }

      if (query.maxPriceMinor !== undefined) {
        const cheapest = services
          .map((s) => s.priceMinor ?? s.priceRangeMinor?.[0])
          .filter((v): v is number => v !== undefined);
        // Quote-required services have no comparable price, so they survive a
        // budget filter rather than being silently dropped.
        if (cheapest.length > 0 && Math.min(...cheapest) > query.maxPriceMinor && !services.some((s) => s.quoteRequired)) {
          continue;
        }
      }

      const provider = this.#toProvider(biz);
      const mapped = services.map((s) => this.#toService(biz, s));
      const next = await this.#firstAvailable(biz, services, query.timeWindow?.from ?? ctx.now);

      results.push(next ? { provider, services: mapped, nextAvailable: next } : { provider, services: mapped });
      if (results.length >= query.limit) break;
    }
    return results;
  }

  async getAvailability(query: AvailabilityQuery, ctx: AdapterContext): Promise<Slot[]> {
    await this.#gate(ctx, "availability");
    const biz = this.#requireBusinessByProviderId(query.providerId);
    const service = this.#requireService(biz, query.serviceId);
    return this.#generateSlots(biz, service, query.from, query.to, query.limit, ctx.now);
  }

  async checkSlot(
    query: { providerId: string; serviceId: string; startsAt: Date; providerSlotRef?: string },
    ctx: AdapterContext,
  ): Promise<Slot | null> {
    await this.#gate(ctx, "checkSlot");
    const biz = this.#requireBusinessByProviderId(query.providerId);
    const service = this.#requireService(biz, query.serviceId);

    const from = new Date(query.startsAt.getTime() - MINUTE);
    const to = new Date(query.startsAt.getTime() + MINUTE);
    // Holds hide a slot from availability listings, but must not hide it from
    // the caller that holds it — that is the whole point of taking one.
    const slots = this.#generateSlots(biz, service, from, to, 5, ctx.now, { ignoreHolds: true });
    return slots.find((s) => s.startsAt.getTime() === query.startsAt.getTime()) ?? null;
  }

  async getQuote(request: QuoteRequest, ctx: AdapterContext): Promise<Quote> {
    await this.#gate(ctx, "quote");
    const biz = this.#requireBusinessByProviderId(request.providerId);

    const candidates = biz.services.filter((s) =>
      request.category ? s.category === request.category : s.quoteRequired,
    );
    const service = candidates[0] ?? biz.services.find((s) => s.quoteRequired) ?? biz.services[0];
    if (!service) throw new PorterError("NOT_FOUND", "That business has no services listed.");

    // Price scales a little with the description length, so different jobs
    // produce different quotes deterministically.
    const rand = mulberry32(this.#options.seed ^ hashString(`${biz.key}:${request.jobDescription}`));
    const [lo, hi] = service.priceRangeMinor ?? [service.priceMinor ?? 15000, (service.priceMinor ?? 15000) * 2];
    const spread = Math.max(0, hi - lo);
    const low = lo + Math.round(spread * rand() * 0.4);
    const high = Math.min(hi, low + Math.round(spread * (0.3 + rand() * 0.5)));

    const offered = this.#generateSlots(biz, service, new Date(ctx.now.getTime() + 2 * 60 * MINUTE), new Date(ctx.now.getTime() + 7 * 24 * 60 * MINUTE), 3, ctx.now);

    const quote: Quote = {
      id: `${this.id}:quote:${biz.key}:${service.key}:${++this.#counter}`,
      adapterId: this.id,
      providerId: this.#providerId(biz),
      serviceId: this.#serviceId(biz, service),
      summary: untrusted(`${service.name} — estimate based on: ${request.jobDescription.slice(0, 120)}`),
      priceRange: { min: money(low), max: money(high) },
      expiresAt: new Date(ctx.now.getTime() + 7 * 24 * 60 * MINUTE),
      offeredSlots: offered,
      ...(service.depositMinor ? { depositRequired: money(service.depositMinor) } : {}),
    };
    return quote;
  }

  async getCancellationPolicy(bookingRef: string, ctx: AdapterContext): Promise<CancellationPolicy> {
    await this.#gate(ctx, "policy");
    const record = this.#bookings.get(bookingRef);
    if (!record) throw new PorterError("NOT_FOUND", "We could not find that booking.");
    const biz = this.#byKey.get(record.providerKey);
    if (!biz) throw new PorterError("NOT_FOUND", "We could not find that business.");
    return this.#policyFor(biz, record.startsAt);
  }

  async getServiceCancellationPolicy(
    query: { providerId: string; serviceId: string; startsAt: Date },
    ctx: AdapterContext,
  ): Promise<CancellationPolicy> {
    await this.#gate(ctx, "servicePolicy");
    const biz = this.#requireBusinessByProviderId(query.providerId);
    return this.#policyFor(biz, query.startsAt);
  }

  async listBookings(query: ListQuery, ctx: AdapterContext): Promise<Booking[]> {
    await this.#gate(ctx, "list");
    return [...this.#bookings.values()]
      .filter((r) => (query.since ? r.startsAt >= query.since : true))
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
      .slice(0, query.limit)
      .map((r) => this.#toBooking(r));
  }

  // ----------------------------------------------------------------- writes

  async holdSlot(
    query: { providerId: string; serviceId: string; startsAt: Date; providerSlotRef?: string },
    ctx: AdapterContext,
  ): Promise<SlotHold> {
    await this.#gate(ctx, "hold");
    const key = this.#slotKey(query.providerId, query.serviceId, query.startsAt);
    if (this.#taken.has(key)) {
      throw new PorterError("SLOT_TAKEN", "That time was just taken. Pick another one.");
    }
    const ref = `hold_${++this.#counter}`;
    const expiresAt = new Date(ctx.now.getTime() + 5 * MINUTE);
    this.#holds.set(ref, { key, expiresAt });
    return { ref, expiresAt };
  }

  async createBooking(request: CreateBookingRequest, ctx: AdapterContext): Promise<Booking> {
    await this.#gate(ctx, "create");

    const existing = [...this.#bookings.values()].find((b) => b.idempotencyKey === request.idempotencyKey);
    if (existing) return this.#toBooking(existing);

    const biz = this.#requireBusinessByProviderId(request.providerId);
    const service = this.#requireService(biz, request.serviceId);
    const key = this.#slotKey(request.providerId, request.serviceId, request.startsAt);

    if (this.#taken.has(key)) {
      throw new PorterError("SLOT_TAKEN", "That time was just taken. Pick another one.");
    }
    const stillOpen = await this.checkSlot(
      { providerId: request.providerId, serviceId: request.serviceId, startsAt: request.startsAt },
      ctx,
    );
    if (!stillOpen) {
      throw new PorterError("SLOT_TAKEN", "That time is no longer available. Pick another one.");
    }

    for (const field of this.capabilities.requiredCustomerFields) {
      if (!request.customer[field]) {
        throw new PorterError("INVALID_REQUEST", "That business needs more contact details to book.", {
          details: { missingFields: [field] },
        });
      }
    }

    this.#taken.add(key);
    for (const [ref, hold] of this.#holds) {
      if (hold.key === key) this.#holds.delete(ref);
    }
    const record: BookingRecord = {
      ref: `${this.id}_bk_${++this.#counter}`,
      providerKey: biz.key,
      serviceKey: service.key,
      locationId: request.locationId,
      startsAt: request.startsAt,
      endsAt: request.endsAt,
      status: "confirmed",
      priceMinor: service.priceMinor ?? null,
      depositMinor: service.depositMinor ?? null,
      createdAt: ctx.now,
      updatedAt: ctx.now,
      idempotencyKey: request.idempotencyKey,
    };
    this.#bookings.set(record.ref, record);
    return this.#toBooking(record);
  }

  async rescheduleBooking(request: RescheduleRequest, ctx: AdapterContext): Promise<Booking> {
    await this.#gate(ctx, "reschedule");
    const record = this.#bookings.get(request.bookingRef);
    if (!record) throw new PorterError("NOT_FOUND", "We could not find that booking.");
    if (record.status === "cancelled") {
      throw new PorterError("POLICY_BLOCKED", "That booking was already cancelled, so it cannot be moved.");
    }

    const targetKey = this.#slotKey(request.providerId, request.serviceId, request.startsAt);
    if (this.#taken.has(targetKey)) {
      throw new PorterError("SLOT_TAKEN", "That new time was just taken. Pick another one.");
    }
    const open = await this.checkSlot(
      { providerId: request.providerId, serviceId: request.serviceId, startsAt: request.startsAt },
      ctx,
    );
    if (!open) throw new PorterError("SLOT_TAKEN", "That new time is not available. Pick another one.");

    this.#taken.delete(this.#slotKey(request.providerId, request.serviceId, record.startsAt));
    this.#taken.add(targetKey);
    record.startsAt = request.startsAt;
    record.endsAt = request.endsAt;
    record.updatedAt = ctx.now;
    return this.#toBooking(record);
  }

  async cancelBooking(request: CancelRequest, ctx: AdapterContext): Promise<Booking> {
    await this.#gate(ctx, "cancel");
    const record = this.#bookings.get(request.bookingRef);
    if (!record) throw new PorterError("NOT_FOUND", "We could not find that booking.");
    if (record.status !== "cancelled") {
      this.#taken.delete(this.#slotKey(this.#providerIdFromKey(record.providerKey), this.#serviceIdFromKeys(record.providerKey, record.serviceKey), record.startsAt));
      record.status = "cancelled";
      record.updatedAt = ctx.now;
    }
    return this.#toBooking(record);
  }

  async messageProvider(request: MessageRequest, ctx: AdapterContext): Promise<MessageReceipt> {
    await this.#gate(ctx, "message");
    if (!this.#bookings.has(request.bookingRef)) {
      throw new PorterError("NOT_FOUND", "We could not find that booking.");
    }
    const ref = `msg_${++this.#counter}`;
    this.#messages.push({ ref, bookingRef: request.bookingRef, at: ctx.now });
    return { ref, deliveredAt: ctx.now };
  }

  // ------------------------------------------------------------- test hooks

  /** Simulate someone else taking a slot between search and booking. */
  takeSlotExternally(providerId: string, serviceId: string, startsAt: Date): void {
    this.#taken.add(this.#slotKey(providerId, serviceId, startsAt));
  }

  get sentMessageCount(): number {
    return this.#messages.length;
  }

  // --------------------------------------------------------------- internals

  async #gate(ctx: AdapterContext, op: string): Promise<void> {
    if (ctx.signal.aborted) {
      throw new PorterError("ADAPTER_DOWN", "That request was cancelled.", { details: { adapter: this.id, op } });
    }
    if (this.#options.latencyMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.#options.latencyMs);
        ctx.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new PorterError("ADAPTER_DOWN", "That request was cancelled.", { details: { adapter: this.id } }));
          },
          { once: true },
        );
      });
    }
    if (this.#options.failureRate > 0) {
      const rand = mulberry32(this.#options.seed ^ hashString(`${op}:${++this.#counter}`));
      if (rand() < this.#options.failureRate) this.#throwFailure(op);
    }
  }

  #throwFailure(op: string): never {
    switch (this.#options.failureMode) {
      case "slot_taken":
        throw new PorterError("SLOT_TAKEN", "That time was just taken. Pick another one.");
      case "not_found":
        throw new PorterError("NOT_FOUND", "We could not find that.");
      case "rate_limited":
        throw new PorterError("RATE_LIMITED", "That booking system is busy. Try again shortly.", { retryAfterSeconds: 5 });
      case "transport":
      default:
        throw new PorterError("ADAPTER_DOWN", "That booking system is not responding right now. Try again in a moment.", {
          details: { adapter: this.id, op },
        });
    }
  }

  #providerId(biz: MockBusinessSeed): string {
    return `${this.id}:${biz.key}`;
  }
  #providerIdFromKey(key: string): string {
    return `${this.id}:${key}`;
  }
  #serviceId(biz: MockBusinessSeed, service: MockServiceSeed): string {
    return `${this.id}:${biz.key}:${service.key}`;
  }
  #serviceIdFromKeys(bizKey: string, serviceKey: string): string {
    return `${this.id}:${bizKey}:${serviceKey}`;
  }
  #locationId(biz: MockBusinessSeed): string {
    return `${this.id}:${biz.key}:loc`;
  }
  #slotKey(providerId: string, serviceId: string, startsAt: Date): string {
    return `${providerId}|${serviceId}|${startsAt.toISOString()}`;
  }

  #requireBusinessByProviderId(providerId: string): MockBusinessSeed {
    const key = providerId.startsWith(`${this.id}:`) ? providerId.slice(this.id.length + 1) : providerId;
    const biz = this.#byKey.get(key);
    if (!biz) throw new PorterError("NOT_FOUND", "We could not find that business.");
    return biz;
  }

  #requireService(biz: MockBusinessSeed, serviceId: string): MockServiceSeed {
    const parts = serviceId.split(":");
    const key = parts[parts.length - 1] ?? serviceId;
    const service = biz.services.find((s) => s.key === key);
    if (!service) throw new PorterError("NOT_FOUND", "We could not find that service.");
    return service;
  }

  #toLocation(biz: MockBusinessSeed): Location {
    return {
      id: this.#locationId(biz),
      name: untrusted(biz.name),
      timezone: biz.timezone,
      address: {
        line1: untrusted(`${100 + (hashString(biz.key) % 900)} Main St`),
        city: untrusted(biz.city),
        region: untrusted(biz.region),
        postalCode: untrusted(biz.postalCode),
        countryCode: "US",
        lat: biz.lat,
        lon: biz.lon,
      },
      ...(biz.serviceRadiusKm !== undefined ? { serviceRadiusKm: biz.serviceRadiusKm } : {}),
    };
  }

  #toProvider(biz: MockBusinessSeed): Provider {
    return {
      id: this.#providerId(biz),
      adapterId: this.id,
      name: untrusted(biz.name),
      description: untrusted(biz.description),
      locations: [this.#toLocation(biz)],
      categories: [...new Set(biz.services.map((s) => s.category))] as ServiceCategory[],
      ...(biz.rating ? { rating: { ...biz.rating, source: this.displayName } } : {}),
      ...(biz.unmappedCategories ? { unmappedCategories: biz.unmappedCategories } : {}),
    };
  }

  #toService(biz: MockBusinessSeed, s: MockServiceSeed): Service {
    return {
      id: this.#serviceId(biz, s),
      providerId: this.#providerId(biz),
      locationId: this.#locationId(biz),
      name: untrusted(s.name),
      category: s.category,
      durationMinutes: s.durationMinutes,
      quoteRequired: s.quoteRequired ?? false,
      ...(s.description ? { description: untrusted(s.description) } : {}),
      ...(s.priceMinor !== undefined ? { price: money(s.priceMinor) } : {}),
      ...(s.priceRangeMinor
        ? { priceRange: { min: money(s.priceRangeMinor[0]), max: money(s.priceRangeMinor[1]) } }
        : {}),
      ...(s.depositMinor !== undefined ? { depositRequired: money(s.depositMinor) } : {}),
    };
  }

  #policyFor(biz: MockBusinessSeed, startsAt: Date): CancellationPolicy {
    switch (biz.cancellation.kind) {
      case "free":
        return { known: true, freeUntil: startsAt, feeAmount: null, text: untrusted("Free cancellation any time before the appointment.") };
      case "window": {
        const freeUntil = new Date(startsAt.getTime() - biz.cancellation.freeHoursBefore * 60 * MINUTE);
        return {
          known: true,
          freeUntil,
          feeAmount: money(biz.cancellation.feeMinor),
          text: untrusted(`Free until ${biz.cancellation.freeHoursBefore} hours before, then a fee applies.`),
        };
      }
      case "always_fee":
        return { known: true, freeUntil: null, feeAmount: money(biz.cancellation.feeMinor), text: untrusted("A cancellation fee applies to all cancellations.") };
      case "unknown":
      default:
        // The platform does not expose a policy. Say so; never invent a fee.
        return { known: false, freeUntil: null, feeAmount: null, text: null };
    }
  }

  #toBooking(r: BookingRecord): Booking {
    const biz = this.#byKey.get(r.providerKey)!;
    const price: Money | undefined = r.priceMinor === null ? undefined : money(r.priceMinor);
    const deposit: Money | undefined = r.depositMinor === null ? undefined : money(r.depositMinor);
    return {
      id: r.ref,
      adapterId: this.id,
      providerId: this.#providerIdFromKey(r.providerKey),
      locationId: r.locationId,
      serviceId: this.#serviceIdFromKeys(r.providerKey, r.serviceKey),
      status: r.status,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      cancellationPolicy: this.#policyFor(biz, r.startsAt),
      providerBookingRef: r.ref,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      ...(price ? { price } : {}),
      ...(deposit ? { deposit } : {}),
    };
  }

  async #firstAvailable(
    biz: MockBusinessSeed,
    services: readonly MockServiceSeed[],
    from: Date,
  ): Promise<Slot | undefined> {
    for (const s of services) {
      const slots = this.#generateSlots(biz, s, from, new Date(from.getTime() + 14 * 24 * 60 * MINUTE), 1, from);
      if (slots[0]) return slots[0];
    }
    return undefined;
  }

  /**
   * Derive open slots from business hours.
   *
   * Deterministic: the same seed, business and day always produce the same
   * pattern of open and busy slots. Slots already booked in this process are
   * excluded, so a booking really does remove availability.
   */
  #generateSlots(
    biz: MockBusinessSeed,
    service: MockServiceSeed,
    from: Date,
    to: Date,
    limit: number,
    now: Date,
    opts: { ignoreHolds?: boolean } = {},
  ): Slot[] {
    const out: Slot[] = [];
    const step = this.#options.slotStepMinutes * MINUTE;
    const providerId = this.#providerId(biz);
    const serviceId = this.#serviceId(biz, service);
    const earliest = Math.max(from.getTime(), now.getTime());

    // Walk day by day from the start of the `from` day.
    const cursor = new Date(from);
    cursor.setUTCHours(0, 0, 0, 0);

    for (let day = 0; day < 60 && out.length < limit; day++) {
      const dayStart = new Date(cursor.getTime() + day * 24 * 60 * MINUTE);
      if (dayStart.getTime() > to.getTime()) break;

      const weekday = dayStart.getUTCDay();
      const hours = biz.hours[weekday];
      if (!hours) continue;
      const [open, close] = hours;

      for (let h = open * 60; h + service.durationMinutes <= close * 60 && out.length < limit; h += this.#options.slotStepMinutes) {
        const startsAt = new Date(dayStart.getTime() + h * MINUTE);
        if (startsAt.getTime() < earliest) continue;
        if (startsAt.getTime() > to.getTime()) break;

        const key = this.#slotKey(providerId, serviceId, startsAt);
        if (this.#taken.has(key)) continue;

        if (!opts.ignoreHolds) {
          const hold = [...this.#holds.values()].find((x) => x.key === key && x.expiresAt > now);
          if (hold) continue;
        }

        // Deterministic "already busy" pattern, so availability looks real.
        const rand = mulberry32(this.#options.seed ^ hashString(key));
        if (rand() < 0.45) continue;

        const price = service.priceMinor !== undefined ? money(service.priceMinor) : undefined;
        out.push({
          providerId,
          locationId: this.#locationId(biz),
          serviceId,
          startsAt,
          endsAt: new Date(startsAt.getTime() + service.durationMinutes * MINUTE),
          fetchedAt: now,
          providerSlotRef: `${biz.key}:${service.key}:${startsAt.toISOString()}`,
          ...(price ? { price } : {}),
        });
      }
    }
    return out;
  }
}

export function createMockAdapter(options: MockAdapterOptions = {}): MockAdapter {
  return new MockAdapter(options);
}
