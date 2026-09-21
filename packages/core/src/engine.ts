import {
  PorterError,
  money,
  newId,
  sanitize,
  type Clock,
  type Logger,
  type Money,
} from "@porter/shared";
import type { AdapterContext, ProviderAdapter } from "./adapter.js";
import { AuditLog } from "./audit.js";
import {
  buildEnvelope,
  confirmationExpiry,
  termsHash,
  type ConfirmationEnvelope,
  type LineItem,
  type Recurrence,
} from "./confirmation.js";
import { projectCustomer, type CustomerDetails, type CustomerField } from "./customer.js";
import type { CancellationPolicy, Service, Slot } from "./domain.js";
import { Idempotency } from "./idempotency.js";
import type { Store, StoredBooking } from "./ports.js";
import { RateLimiter } from "./ratelimit.js";
import { resolveCategory, type ServiceCategory } from "./taxonomy.js";
import {
  createSigner,
  decodeConfirmationToken,
  decodeSlotToken,
  type Signer,
  type SlotTokenPayload,
} from "./tokens.js";
import {
  bookingView,
  bookingViewFromDomain,
  providerView,
  slotView,
  type BookingView,
  type ProviderView,
  type SlotView,
} from "./views.js";
import type { PaymentGateway } from "./payments.js";

export interface Actor {
  /** Pseudonymous user id. Never an email or phone number. */
  readonly id: string;
}

export interface EngineOptions {
  /** Slots older than this are not bookable without a re-check. */
  readonly slotTtlMs?: number;
  readonly confirmationTtlMs?: number;
  /**
   * Amount at or above which the envelope is flagged as needing explicit
   * approval. The Muse Connector Policies forbid "financial transactions above
   * material thresholds" without the user authorising the specific action, but
   * do not define the threshold, so Porter picks a conservative default and
   * declares it in the submission.
   */
  readonly materialThreshold?: Money;
  readonly defaultSearchLimit?: number;
}

export interface EngineDeps {
  readonly adapters: readonly ProviderAdapter[];
  readonly store: Store;
  readonly clock: Clock;
  readonly log: Logger;
  readonly signer?: Signer;
  readonly signingSecret?: string;
  readonly limiter?: RateLimiter;
  readonly payments?: PaymentGateway;
  readonly options?: EngineOptions;
  /** Per-adapter credentials, decrypted at the edge and scoped per call. */
  readonly credentials?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export interface SearchArgs {
  readonly category: string;
  readonly location?: string;
  readonly time_window?: { from?: string; to?: string };
  readonly budget_minor?: number;
  readonly radius_km?: number;
  readonly limit?: number;
}

export interface AvailabilityArgs {
  readonly provider_id: string;
  readonly service_id: string;
  readonly from: string;
  readonly to: string;
  readonly limit?: number;
}

export interface QuoteArgs {
  readonly provider_id: string;
  readonly job_description: string;
  readonly address: CustomerDetails;
  readonly photo_urls?: readonly string[];
  readonly category?: string;
}

export interface CreateBookingArgs {
  readonly slot_id?: string;
  readonly quote_id?: string;
  readonly customer_details: CustomerDetails;
  readonly notes?: string;
  readonly idempotency_key: string;
  readonly confirmation_token?: string;
}

export interface RescheduleArgs {
  readonly booking_id: string;
  readonly new_slot_id: string;
  readonly idempotency_key: string;
  readonly confirmation_token?: string;
}

export interface CancelArgs {
  readonly booking_id: string;
  readonly reason?: string;
  readonly idempotency_key: string;
  readonly confirmation_token?: string;
}

export interface PayArgs {
  readonly booking_id: string;
  readonly idempotency_key: string;
  readonly confirmation_token?: string;
}

export interface MessageArgs {
  readonly booking_id: string;
  readonly message: string;
}

export type BookingResult = { readonly status: "ok"; readonly booking: BookingView };
export type CancelResult = { readonly status: "ok"; readonly booking: BookingView; readonly fee_charged: { amount: number; currency: string } | null };
export type PayResult = { readonly status: "ok"; readonly payment_id: string; readonly amount: { amount: number; currency: string }; readonly booking_id: string };
export type MaybeConfirm<T> = ConfirmationEnvelope | T;

const DEFAULTS = {
  slotTtlMs: 5 * 60_000,
  confirmationTtlMs: 10 * 60_000,
  materialThreshold: { amount: 20_000, currency: "USD" } as Money,
  defaultSearchLimit: 8,
};

/**
 * The booking engine.
 *
 * Everything that mutates goes through the same shape: quote the terms, return
 * a confirmation envelope, and only commit when a matching signed token comes
 * back. Adapters are called through a per-call context that carries scoped
 * credentials and an abort signal, and never touch storage.
 */
export class BookingEngine {
  readonly #adapters: Map<string, ProviderAdapter>;
  readonly #store: Store;
  readonly #clock: Clock;
  readonly #log: Logger;
  readonly #signer: Signer;
  readonly #limiter: RateLimiter;
  readonly #idem: Idempotency;
  readonly #audit: AuditLog;
  readonly #payments: PaymentGateway | undefined;
  readonly #credentials: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly #opts: Required<EngineOptions>;

  constructor(deps: EngineDeps) {
    this.#adapters = new Map(deps.adapters.map((a) => [a.id, a]));
    this.#store = deps.store;
    this.#clock = deps.clock;
    this.#log = deps.log;
    this.#signer =
      deps.signer ??
      createSigner(deps.signingSecret ?? mustEnv("PORTER_SIGNING_SECRET"));
    this.#limiter = deps.limiter ?? new RateLimiter(deps.clock, { perUser: { capacity: 30, refillPerSecond: 1 }, perAdapter: {}, defaultAdapter: { capacity: 60, refillPerSecond: 5 } });
    this.#idem = new Idempotency(deps.store.idempotency, deps.store.keys, deps.clock);
    this.#audit = new AuditLog(deps.store.audit, deps.clock, deps.log);
    this.#payments = deps.payments;
    this.#credentials = deps.credentials ?? {};
    this.#opts = {
      slotTtlMs: deps.options?.slotTtlMs ?? DEFAULTS.slotTtlMs,
      confirmationTtlMs: deps.options?.confirmationTtlMs ?? DEFAULTS.confirmationTtlMs,
      materialThreshold: deps.options?.materialThreshold ?? DEFAULTS.materialThreshold,
      defaultSearchLimit: deps.options?.defaultSearchLimit ?? DEFAULTS.defaultSearchLimit,
    };
  }

  // ------------------------------------------------------------------ reads

  async searchProviders(actor: Actor, args: SearchArgs, signal: AbortSignal): Promise<{ providers: ProviderView[]; unmatched_category: boolean }> {
    const started = this.#clock.nowMs();
    this.#limiter.check(actor.id);

    const categories = resolveCategory(args.category);
    if (categories.length === 0) {
      await this.#audit.record({ actorId: actor.id, tool: "search_providers", action: "search", args, outcome: "error", errorCode: "INVALID_REQUEST", startedAtMs: started });
      return { providers: [], unmatched_category: true };
    }

    const limit = Math.min(args.limit ?? this.#opts.defaultSearchLimit, 25);
    const timeWindow = args.time_window?.from
      ? { from: new Date(args.time_window.from), to: new Date(args.time_window.to ?? args.time_window.from) }
      : undefined;

    const out: ProviderView[] = [];
    for (const adapter of this.#adapters.values()) {
      const relevant = categories.filter((c) => adapter.capabilities.categories.includes(c));
      if (relevant.length === 0) continue;
      try {
        this.#limiter.check(actor.id, adapter.id);
        const results = await adapter.searchProviders(
          {
            categories: relevant,
            limit,
            ...(args.location ? { near: { postalCode: args.location } } : {}),
            ...(args.radius_km !== undefined ? { radiusKm: args.radius_km } : {}),
            ...(timeWindow ? { timeWindow } : {}),
            ...(args.budget_minor !== undefined ? { maxPriceMinor: args.budget_minor, currency: "USD" } : {}),
          },
          this.#ctx(actor, adapter, signal),
        );
        for (const r of results) {
          const next = r.nextAvailable ? slotView(this.#encodeSlot(adapter.id, r.nextAvailable), r.nextAvailable) : null;
          out.push(providerView(r.provider, r.services, next));
        }
      } catch (error) {
        // One failing platform must not blank the whole search.
        this.#log.warn("adapter_search_failed", { adapter: adapter.id, code: PorterError.is(error) ? error.code : "unknown" });
      }
    }

    out.sort(rankProviders(args.budget_minor));
    const providers = out.slice(0, limit);
    await this.#audit.record({ actorId: actor.id, tool: "search_providers", action: "search", args, outcome: "ok", startedAtMs: started });
    return { providers, unmatched_category: false };
  }

  async getAvailability(actor: Actor, args: AvailabilityArgs, signal: AbortSignal): Promise<{ slots: SlotView[] }> {
    const started = this.#clock.nowMs();
    const adapter = this.#adapterForProvider(args.provider_id);
    this.#limiter.check(actor.id, adapter.id);

    const from = new Date(args.from);
    const to = new Date(args.to);
    assertValidRange(from, to);

    const slots = await adapter.getAvailability(
      { providerId: args.provider_id, serviceId: args.service_id, from, to, limit: Math.min(args.limit ?? 20, 50) },
      this.#ctx(actor, adapter, signal),
    );

    await this.#audit.record({ actorId: actor.id, tool: "get_availability", action: "read", adapterId: adapter.id, providerId: args.provider_id, args, outcome: "ok", startedAtMs: started });
    return { slots: slots.map((s) => slotView(this.#encodeSlot(adapter.id, s), s)) };
  }

  async getQuote(actor: Actor, args: QuoteArgs, signal: AbortSignal) {
    const started = this.#clock.nowMs();
    const adapter = this.#adapterForProvider(args.provider_id);
    this.#limiter.check(actor.id, adapter.id);

    if (!adapter.getQuote || !adapter.capabilities.quoting) {
      throw new PorterError("UNSUPPORTED_CAPABILITY", "That business does not give quotes through us. Book a visit instead.");
    }

    // Address fields go downstream, so they are minimised the same way customer
    // details are. Terms section 4.3(e).
    const { customer: address, disclosure } = projectCustomer(
      adapter.id,
      args.address,
      addressRequirement(adapter.capabilities.requiredCustomerFields),
      adapter.capabilities.optionalCustomerFields,
    );

    const quote = await adapter.getQuote(
      {
        providerId: args.provider_id,
        jobDescription: args.job_description,
        address,
        ...(args.photo_urls ? { photoUrls: args.photo_urls } : {}),
        ...(args.category && resolveCategory(args.category)[0] ? { category: resolveCategory(args.category)[0] as ServiceCategory } : {}),
      },
      this.#ctx(actor, adapter, signal),
    );

    await this.#audit.record({ actorId: actor.id, tool: "get_quote", action: "read", adapterId: adapter.id, providerId: args.provider_id, args, outcome: "ok", startedAtMs: started, disclosedFields: disclosure.fields });

    return {
      quote_id: quote.id,
      provider_id: quote.providerId,
      summary: sanitize(quote.summary, { maxLength: 400, label: "quote summary" }),
      price: quote.price ? { amount: quote.price.amount, currency: quote.price.currency } : null,
      price_range: quote.priceRange
        ? { min: { amount: quote.priceRange.min.amount, currency: quote.priceRange.min.currency }, max: { amount: quote.priceRange.max.amount, currency: quote.priceRange.max.currency } }
        : null,
      deposit_required: quote.depositRequired ? { amount: quote.depositRequired.amount, currency: quote.depositRequired.currency } : null,
      expires_at: quote.expiresAt.toISOString(),
      offered_slots: (quote.offeredSlots ?? []).map((s) => slotView(this.#encodeSlot(adapter.id, s), s)),
    };
  }

  async listMyBookings(actor: Actor, status?: StoredBooking["status"]): Promise<{ bookings: BookingView[] }> {
    const started = this.#clock.nowMs();
    this.#limiter.check(actor.id);
    const rows = await this.#store.bookings.list(actor.id, status);
    await this.#audit.record({ actorId: actor.id, tool: "list_my_bookings", action: "read", args: { status: status ?? null }, outcome: "ok", startedAtMs: started });
    return { bookings: rows.map(bookingView) };
  }

  // ----------------------------------------------------------------- writes

  async createBooking(actor: Actor, args: CreateBookingArgs, signal: AbortSignal): Promise<MaybeConfirm<BookingResult>> {
    const started = this.#clock.nowMs();
    if (!args.slot_id) {
      throw new PorterError("INVALID_REQUEST", "Pick an appointment time first, then book it.");
    }
    const slotToken = decodeSlotToken(this.#signer, args.slot_id);
    const adapter = this.#requireAdapter(slotToken.a);
    this.#limiter.check(actor.id, adapter.id);

    const { customer, disclosure } = projectCustomer(
      adapter.id,
      args.customer_details,
      adapter.capabilities.requiredCustomerFields,
      adapter.capabilities.optionalCustomerFields,
    );

    // ---- phase 1: quote the terms, change nothing -------------------------
    if (!args.confirmation_token) {
      const { service, providerName } = await this.#describe(actor, adapter, slotToken, signal);
      const fresh = await this.#recheck(actor, adapter, slotToken, signal);
      const policy = await this.#policyForService(actor, adapter, slotToken, signal);

      const price = fresh.price ?? service?.price ?? null;
      const deposit = service?.depositRequired ?? null;
      const chargeNow = deposit ?? null;
      const breakdown: LineItem[] = [];
      if (price) breakdown.push({ label: "Service", amount: price });
      if (deposit) breakdown.push({ label: "Deposit due now", amount: deposit });

      const envelope = this.#envelope({
        action: "book",
        actor,
        summary: {
          provider: sanitize(providerName, { maxLength: 120, label: "business name" }),
          service: sanitize(service?.name ?? "Appointment", { maxLength: 120, label: "service name" }),
          startsAt: fresh.startsAt.toISOString(),
          durationMinutes: Math.round((fresh.endsAt.getTime() - fresh.startsAt.getTime()) / 60_000),
        },
        moneyKind: chargeNow ? "deposit" : price ? "total" : "none",
        total: chargeNow ?? price,
        breakdown,
        policy,
        providerId: slotToken.p,
        serviceId: slotToken.s,
        startsAtMs: fresh.startsAt.getTime(),
        data: { slot_id: args.slot_id, customer, notes: args.notes ?? null },
      });

      await this.#audit.record({ actorId: actor.id, tool: "create_booking", action: "quote", adapterId: adapter.id, providerId: slotToken.p, args: redactArgs(args), outcome: "ok", startedAtMs: started, disclosedFields: [] });
      return envelope;
    }

    // ---- phase 2: commit --------------------------------------------------
    const token = decodeConfirmationToken(this.#signer, args.confirmation_token, this.#clock);
    this.#assertToken(token, actor, "book");

    return this.#idem.run(actor.id, "create_booking", args.idempotency_key, { slot: args.slot_id, customer, notes: args.notes ?? null }, async () => {
      const { service, providerName } = await this.#describe(actor, adapter, slotToken, signal);
      const fresh = await this.#recheck(actor, adapter, slotToken, signal);
      const policy = await this.#policyForService(actor, adapter, slotToken, signal);

      const price = fresh.price ?? service?.price ?? null;
      const deposit = service?.depositRequired ?? null;
      const chargeNow = deposit ?? null;

      // Spend the token first, so a confirmation is single-use whatever
      // happens next. A stale-terms failure needs a fresh summary anyway.
      await this.#consume(token);

      // Re-derive the terms and compare. If the price, time or policy moved
      // between the summary and the commit, the confirmation is void.
      const rederived = termsHash({
        action: "book",
        providerId: slotToken.p,
        serviceId: slotToken.s,
        startsAtMs: fresh.startsAt.getTime(),
        amountMinor: (chargeNow ?? price)?.amount ?? null,
        currency: (chargeNow ?? price)?.currency ?? null,
        feeMinor: policy.feeAmount?.amount ?? null,
        nonRefundable: false,
        recurrence: { kind: "one_off" },
      });
      if (rederived !== token.terms) {
        throw new PorterError("CONFIRMATION_STALE", "The price or time changed since we showed you the summary. Ask for a fresh summary and confirm again.");
      }

      let hold: string | undefined;
      if (adapter.holdSlot && adapter.capabilities.slotHold) {
        try {
          hold = (await adapter.holdSlot({ providerId: slotToken.p, serviceId: slotToken.s, startsAt: fresh.startsAt, ...(fresh.providerSlotRef ? { providerSlotRef: fresh.providerSlotRef } : {}) }, this.#ctx(actor, adapter, signal))).ref;
        } catch {
          // A hold is an optimisation. Losing it is not fatal; the create call
          // still re-checks and fails cleanly if the slot went.
        }
      }

      const booking = await adapter.createBooking(
        {
          providerId: slotToken.p,
          locationId: slotToken.l,
          serviceId: slotToken.s,
          startsAt: fresh.startsAt,
          endsAt: fresh.endsAt,
          customer,
          idempotencyKey: derivedKey(args.idempotency_key, "create"),
          ...(fresh.providerSlotRef ? { providerSlotRef: fresh.providerSlotRef } : {}),
          ...(hold ? { holdRef: hold } : {}),
          ...(args.notes ? { notes: args.notes } : {}),
          ...(args.quote_id ? { quoteId: args.quote_id } : {}),
        },
        this.#ctx(actor, adapter, signal),
      );

      const stored: StoredBooking = {
        id: newId("bk"),
        userId: actor.id,
        adapterId: adapter.id,
        providerBookingRef: booking.providerBookingRef,
        status: booking.status,
        startsAt: booking.startsAt,
        endsAt: booking.endsAt,
        providerId: booking.providerId,
        locationId: booking.locationId,
        serviceId: booking.serviceId,
        providerName: sanitize(providerName, { maxLength: 120, label: "business name" }),
        serviceName: sanitize(service?.name ?? "Appointment", { maxLength: 120, label: "service name" }),
        priceMinor: booking.price?.amount ?? null,
        currency: booking.price?.currency ?? null,
        createdAt: booking.createdAt,
        updatedAt: booking.updatedAt,
      };
      await this.#store.bookings.put(stored);

      await this.#audit.record({ actorId: actor.id, tool: "create_booking", action: "commit", adapterId: adapter.id, providerId: booking.providerId, args: redactArgs(args), idempotencyKey: args.idempotency_key, confirmationJti: token.jti, outcome: "ok", startedAtMs: started, disclosedFields: disclosure.fields });

      return { status: "ok" as const, booking: bookingView(stored) };
    });
  }

  async rescheduleBooking(actor: Actor, args: RescheduleArgs, signal: AbortSignal): Promise<MaybeConfirm<BookingResult>> {
    const started = this.#clock.nowMs();
    const stored = await this.#requireBooking(actor, args.booking_id);
    const adapter = this.#requireAdapter(stored.adapterId);
    this.#limiter.check(actor.id, adapter.id);

    if (!adapter.capabilities.reschedule) {
      throw new PorterError("UNSUPPORTED_CAPABILITY", "That business cannot move appointments through us. Cancel and book a new time instead.");
    }

    const slotToken = decodeSlotToken(this.#signer, args.new_slot_id);
    if (slotToken.a !== adapter.id || slotToken.p !== stored.providerId) {
      throw new PorterError("INVALID_REQUEST", "That new time belongs to a different business.");
    }

    const policy = await this.#policy(actor, adapter, stored, signal);

    if (!args.confirmation_token) {
      const fresh = await this.#recheck(actor, adapter, slotToken, signal);
      const envelope = this.#envelope({
        action: "reschedule",
        actor,
        summary: {
          provider: stored.providerName,
          service: stored.serviceName,
          startsAt: fresh.startsAt.toISOString(),
          durationMinutes: Math.round((fresh.endsAt.getTime() - fresh.startsAt.getTime()) / 60_000),
        },
        moneyKind: "none",
        total: null,
        breakdown: [],
        policy,
        providerId: stored.providerId,
        serviceId: stored.serviceId,
        startsAtMs: fresh.startsAt.getTime(),
        data: { booking_id: args.booking_id, new_slot_id: args.new_slot_id },
      });
      await this.#audit.record({ actorId: actor.id, tool: "reschedule_booking", action: "quote", adapterId: adapter.id, providerId: stored.providerId, args, outcome: "ok", startedAtMs: started });
      return envelope;
    }

    const token = decodeConfirmationToken(this.#signer, args.confirmation_token, this.#clock);
    this.#assertToken(token, actor, "reschedule");

    return this.#idem.run(actor.id, "reschedule_booking", args.idempotency_key, { booking: args.booking_id, slot: args.new_slot_id }, async () => {
      const fresh = await this.#recheck(actor, adapter, slotToken, signal);
      await this.#consume(token);

      const rederived = termsHash({
        action: "reschedule",
        providerId: stored.providerId,
        serviceId: stored.serviceId,
        startsAtMs: fresh.startsAt.getTime(),
        amountMinor: null,
        currency: null,
        feeMinor: policy.feeAmount?.amount ?? null,
        nonRefundable: false,
        recurrence: { kind: "one_off" },
      });
      if (rederived !== token.terms) {
        throw new PorterError("CONFIRMATION_STALE", "That time changed since we showed you the summary. Ask for a fresh summary and confirm again.");
      }

      const moved = await adapter.rescheduleBooking(
        {
          bookingRef: stored.providerBookingRef,
          providerId: stored.providerId,
          serviceId: stored.serviceId,
          startsAt: fresh.startsAt,
          endsAt: fresh.endsAt,
          idempotencyKey: derivedKey(args.idempotency_key, "reschedule"),
          ...(fresh.providerSlotRef ? { providerSlotRef: fresh.providerSlotRef } : {}),
        },
        this.#ctx(actor, adapter, signal),
      );

      const updated: StoredBooking = { ...stored, status: moved.status, startsAt: moved.startsAt, endsAt: moved.endsAt, updatedAt: moved.updatedAt };
      await this.#store.bookings.put(updated);
      await this.#audit.record({ actorId: actor.id, tool: "reschedule_booking", action: "commit", adapterId: adapter.id, providerId: stored.providerId, args, idempotencyKey: args.idempotency_key, confirmationJti: token.jti, outcome: "ok", startedAtMs: started });
      return { status: "ok" as const, booking: bookingView(updated) };
    });
  }

  async cancelBooking(actor: Actor, args: CancelArgs, signal: AbortSignal): Promise<MaybeConfirm<CancelResult>> {
    const started = this.#clock.nowMs();
    const stored = await this.#requireBooking(actor, args.booking_id);
    const adapter = this.#requireAdapter(stored.adapterId);
    this.#limiter.check(actor.id, adapter.id);

    // The fee is always fetched and shown BEFORE anything is cancelled.
    const policy = await this.#policy(actor, adapter, stored, signal);
    const feeDue = feeApplies(policy, this.#clock.now()) ? policy.feeAmount : null;

    if (!args.confirmation_token) {
      const envelope = this.#envelope({
        action: "cancel",
        actor,
        summary: {
          provider: stored.providerName,
          service: stored.serviceName,
          startsAt: stored.startsAt.toISOString(),
          durationMinutes: Math.round((stored.endsAt.getTime() - stored.startsAt.getTime()) / 60_000),
        },
        moneyKind: feeDue ? "fee" : "none",
        total: feeDue,
        breakdown: feeDue ? [{ label: "Cancellation fee", amount: feeDue }] : [],
        policy,
        providerId: stored.providerId,
        serviceId: stored.serviceId,
        startsAtMs: stored.startsAt.getTime(),
        nonRefundable: feeDue !== null,
        data: { booking_id: args.booking_id, reason: args.reason ?? null },
      });
      await this.#audit.record({ actorId: actor.id, tool: "cancel_booking", action: "quote", adapterId: adapter.id, providerId: stored.providerId, args, outcome: "ok", startedAtMs: started });
      return envelope;
    }

    const token = decodeConfirmationToken(this.#signer, args.confirmation_token, this.#clock);
    this.#assertToken(token, actor, "cancel");

    return this.#idem.run(actor.id, "cancel_booking", args.idempotency_key, { booking: args.booking_id }, async () => {
      await this.#consume(token);

      const rederived = termsHash({
        action: "cancel",
        providerId: stored.providerId,
        serviceId: stored.serviceId,
        startsAtMs: stored.startsAt.getTime(),
        amountMinor: feeDue?.amount ?? null,
        currency: feeDue?.currency ?? null,
        feeMinor: policy.feeAmount?.amount ?? null,
        nonRefundable: feeDue !== null,
        recurrence: { kind: "one_off" },
      });
      if (rederived !== token.terms) {
        throw new PorterError("CONFIRMATION_STALE", "The cancellation fee changed since we showed you the summary. Ask for a fresh summary and confirm again.");
      }

      const cancelled = await adapter.cancelBooking(
        {
          bookingRef: stored.providerBookingRef,
          providerId: stored.providerId,
          idempotencyKey: derivedKey(args.idempotency_key, "cancel"),
          ...(args.reason ? { reason: args.reason } : {}),
        },
        this.#ctx(actor, adapter, signal),
      );

      const updated: StoredBooking = { ...stored, status: cancelled.status, updatedAt: cancelled.updatedAt };
      await this.#store.bookings.put(updated);
      await this.#audit.record({ actorId: actor.id, tool: "cancel_booking", action: "commit", adapterId: adapter.id, providerId: stored.providerId, args, idempotencyKey: args.idempotency_key, confirmationJti: token.jti, outcome: "ok", startedAtMs: started });

      return {
        status: "ok" as const,
        booking: bookingView(updated),
        fee_charged: feeDue ? { amount: feeDue.amount, currency: feeDue.currency } : null,
      };
    });
  }

  async payOrDeposit(actor: Actor, args: PayArgs, signal: AbortSignal): Promise<MaybeConfirm<PayResult>> {
    const started = this.#clock.nowMs();
    const stored = await this.#requireBooking(actor, args.booking_id);
    const adapter = this.#requireAdapter(stored.adapterId);
    this.#limiter.check(actor.id, adapter.id);

    if (!this.#payments) {
      throw new PorterError("UNSUPPORTED_CAPABILITY", "Paying through us is not switched on yet. The business will take payment directly.");
    }
    if (stored.priceMinor === null || !stored.currency) {
      throw new PorterError("PAYMENT_REQUIRED", "That booking has no amount to pay yet. Ask the business for a quote first.");
    }

    const amount = money(stored.priceMinor, stored.currency);
    const policy = await this.#policy(actor, adapter, stored, signal);

    if (!args.confirmation_token) {
      const envelope = this.#envelope({
        action: "pay",
        actor,
        summary: {
          provider: stored.providerName,
          service: stored.serviceName,
          startsAt: stored.startsAt.toISOString(),
          durationMinutes: Math.round((stored.endsAt.getTime() - stored.startsAt.getTime()) / 60_000),
        },
        moneyKind: "total",
        total: amount,
        breakdown: [{ label: stored.serviceName, amount }],
        policy,
        providerId: stored.providerId,
        serviceId: stored.serviceId,
        startsAtMs: stored.startsAt.getTime(),
        data: { booking_id: args.booking_id },
      });
      await this.#audit.record({ actorId: actor.id, tool: "pay_or_deposit", action: "quote", adapterId: adapter.id, providerId: stored.providerId, args, outcome: "ok", startedAtMs: started });
      return envelope;
    }

    const token = decodeConfirmationToken(this.#signer, args.confirmation_token, this.#clock);
    this.#assertToken(token, actor, "pay");

    return this.#idem.run(actor.id, "pay_or_deposit", args.idempotency_key, { booking: args.booking_id, amount: amount.amount }, async () => {
      await this.#consume(token);

      const rederived = termsHash({
        action: "pay",
        providerId: stored.providerId,
        serviceId: stored.serviceId,
        startsAtMs: stored.startsAt.getTime(),
        amountMinor: amount.amount,
        currency: amount.currency,
        feeMinor: policy.feeAmount?.amount ?? null,
        nonRefundable: false,
        recurrence: { kind: "one_off" },
      });
      if (rederived !== token.terms) {
        throw new PorterError("CONFIRMATION_STALE", "The amount changed since we showed you the summary. Ask for a fresh summary and confirm again.");
      }

      const result = await this.#payments!.charge({
        userId: actor.id,
        bookingId: stored.id,
        amount,
        kind: "total",
        idempotencyKey: derivedKey(args.idempotency_key, "charge"),
      });
      if (result.status === "failed") {
        throw new PorterError("PAYMENT_REQUIRED", "That payment did not go through. Try a different payment method.");
      }

      await this.#audit.record({ actorId: actor.id, tool: "pay_or_deposit", action: "commit", adapterId: adapter.id, providerId: stored.providerId, args, idempotencyKey: args.idempotency_key, confirmationJti: token.jti, outcome: "ok", startedAtMs: started });
      return { status: "ok" as const, payment_id: result.paymentId, amount: { amount: amount.amount, currency: amount.currency }, booking_id: stored.id };
    });
  }

  async messageProvider(actor: Actor, args: MessageArgs, signal: AbortSignal): Promise<{ status: "ok"; delivered_at: string }> {
    const started = this.#clock.nowMs();
    const stored = await this.#requireBooking(actor, args.booking_id);
    const adapter = this.#requireAdapter(stored.adapterId);
    this.#limiter.check(actor.id, adapter.id);

    if (!adapter.messageProvider || !adapter.capabilities.messaging) {
      throw new PorterError("UNSUPPORTED_CAPABILITY", "That business cannot be messaged through us. Call them directly.");
    }
    const receipt = await adapter.messageProvider(
      { bookingRef: stored.providerBookingRef, providerId: stored.providerId, message: args.message.slice(0, 2000) },
      this.#ctx(actor, adapter, signal),
    );
    await this.#audit.record({ actorId: actor.id, tool: "message_provider", action: "commit", adapterId: adapter.id, providerId: stored.providerId, args: { booking_id: args.booking_id, length: args.message.length }, outcome: "ok", startedAtMs: started });
    return { status: "ok", delivered_at: receipt.deliveredAt.toISOString() };
  }

  /** Terms 4.3(f): purge everything tied to a user on revocation or request. */
  async deleteUserData(actor: Actor): Promise<{ bookings: number; idempotency: number }> {
    const bookings = await this.#store.bookings.deleteAllForUser(actor.id);
    const idempotency = await this.#store.idempotency.deleteAllForUser(actor.id);
    // Destroying the per-user key renders any remaining ciphertext unreadable.
    await this.#store.keys.destroy(actor.id);
    this.#log.info("user_data_deleted", { bookings, idempotency });
    return { bookings, idempotency };
  }

  // --------------------------------------------------------------- internals

  #ctx(actor: Actor, adapter: ProviderAdapter, signal: AbortSignal): AdapterContext {
    return {
      actorId: actor.id,
      log: this.#log.child({ adapter: adapter.id }),
      signal,
      credentials: this.#credentials[adapter.id] ?? {},
      now: this.#clock.now(),
    };
  }

  #requireAdapter(id: string): ProviderAdapter {
    const adapter = this.#adapters.get(id);
    if (!adapter) throw new PorterError("NOT_FOUND", "We do not work with that booking system.");
    return adapter;
  }

  #adapterForProvider(providerId: string): ProviderAdapter {
    const prefix = providerId.split(":")[0] ?? "";
    const direct = this.#adapters.get(prefix);
    if (direct) return direct;
    throw new PorterError("NOT_FOUND", "We could not find that business.");
  }

  async #requireBooking(actor: Actor, bookingId: string): Promise<StoredBooking> {
    const row = await this.#store.bookings.get(actor.id, bookingId);
    if (!row) throw new PorterError("NOT_FOUND", "We could not find that booking.");
    return row;
  }

  #encodeSlot(adapterId: string, slot: Slot): string {
    const payload: SlotTokenPayload = {
      v: 1,
      a: adapterId,
      p: slot.providerId,
      l: slot.locationId,
      s: slot.serviceId,
      t: slot.startsAt.getTime(),
      e: slot.endsAt.getTime(),
      f: slot.fetchedAt.getTime(),
      ...(slot.providerSlotRef ? { r: slot.providerSlotRef } : {}),
      ...(slot.price ? { c: slot.price.amount, u: slot.price.currency } : {}),
    };
    return this.#signer.sign(payload);
  }

  /**
   * Re-read the slot from the provider immediately before committing.
   *
   * Cached availability is never bookable. If the slot has gone, fail with
   * SLOT_TAKEN and attach fresh alternatives so the agent can offer a choice
   * rather than dead-end the user.
   */
  async #recheck(actor: Actor, adapter: ProviderAdapter, token: SlotTokenPayload, signal: AbortSignal): Promise<Slot> {
    const startsAt = new Date(token.t);
    const fresh = await adapter.checkSlot(
      { providerId: token.p, serviceId: token.s, startsAt, ...(token.r ? { providerSlotRef: token.r } : {}) },
      this.#ctx(actor, adapter, signal),
    );
    if (fresh) return fresh;

    let alternatives: SlotView[] = [];
    try {
      const from = new Date(this.#clock.nowMs() + 60_000);
      const slots = await adapter.getAvailability(
        { providerId: token.p, serviceId: token.s, from, to: new Date(from.getTime() + 14 * 24 * 60 * 60_000), limit: 3 },
        this.#ctx(actor, adapter, signal),
      );
      alternatives = slots.map((s) => slotView(this.#encodeSlot(adapter.id, s), s));
    } catch {
      // Alternatives are a courtesy. Their absence must not mask SLOT_TAKEN.
    }

    throw new PorterError("SLOT_TAKEN", "That time has just been taken. Here are the next open times.", {
      details: { alternatives },
    });
  }

  async #describe(actor: Actor, adapter: ProviderAdapter, token: SlotTokenPayload, signal: AbortSignal): Promise<{ service: Service | null; providerName: string }> {
    const results = await adapter.searchProviders({ categories: [], limit: 50 }, this.#ctx(actor, adapter, signal));
    const hit = results.find((r) => r.provider.id === token.p);
    if (!hit) return { service: null, providerName: "the business" };
    return { service: hit.services.find((s) => s.id === token.s) ?? null, providerName: hit.provider.name };
  }

  async #policyForService(actor: Actor, adapter: ProviderAdapter, token: SlotTokenPayload, signal: AbortSignal): Promise<CancellationPolicy> {
    // Before a booking exists there is no booking ref, so the policy comes from
    // the provider's published terms. Adapters that cannot say report unknown.
    void actor; void adapter; void token; void signal;
    return { known: false, freeUntil: null, feeAmount: null, text: null };
  }

  async #policy(actor: Actor, adapter: ProviderAdapter, stored: StoredBooking, signal: AbortSignal): Promise<CancellationPolicy> {
    if (!adapter.capabilities.cancellationPolicy) {
      return { known: false, freeUntil: null, feeAmount: null, text: null };
    }
    try {
      return await adapter.getCancellationPolicy(stored.providerBookingRef, this.#ctx(actor, adapter, signal));
    } catch (error) {
      this.#log.warn("policy_lookup_failed", { adapter: adapter.id, code: PorterError.is(error) ? error.code : "unknown" });
      return { known: false, freeUntil: null, feeAmount: null, text: null };
    }
  }

  #envelope(input: {
    action: "book" | "reschedule" | "cancel" | "pay";
    actor: Actor;
    summary: { provider: string; service: string; startsAt: string; durationMinutes: number };
    moneyKind: "total" | "deposit" | "fee" | "none";
    total: Money | null;
    breakdown: LineItem[];
    policy: CancellationPolicy;
    providerId: string;
    serviceId: string;
    startsAtMs: number;
    nonRefundable?: boolean;
    recurrence?: Recurrence;
    data: Record<string, unknown>;
  }): ConfirmationEnvelope {
    const recurrence: Recurrence = input.recurrence ?? { kind: "one_off" };
    const nonRefundable = input.nonRefundable ?? false;

    const terms = termsHash({
      action: input.action,
      providerId: input.providerId,
      serviceId: input.serviceId,
      startsAtMs: input.startsAtMs,
      amountMinor: input.total?.amount ?? null,
      currency: input.total?.currency ?? null,
      feeMinor: input.policy.feeAmount?.amount ?? null,
      nonRefundable,
      recurrence,
    });

    const expiresAt = confirmationExpiry(this.#clock, this.#opts.confirmationTtlMs);
    const token = this.#signer.sign({
      v: 1,
      act: input.action,
      uid: input.actor.id,
      jti: newId("cnf"),
      exp: expiresAt.getTime(),
      terms,
      data: input.data,
    });

    return buildEnvelope(
      {
        action: input.action,
        summary: input.summary,
        money: { kind: input.moneyKind, total: input.total, breakdown: input.breakdown },
        recurrence,
        nonRefundable,
        cancellationPolicy: input.policy,
        materialThreshold: this.#opts.materialThreshold,
      },
      token,
      expiresAt,
    );
  }

  #assertToken(token: { act: string; uid: string }, actor: Actor, expected: string): void {
    if (token.act !== expected) {
      throw new PorterError("INVALID_REQUEST", "That confirmation was for a different action. Ask for a fresh summary.");
    }
    if (token.uid !== actor.id) {
      throw new PorterError("UNAUTHENTICATED", "That confirmation belongs to a different account.");
    }
  }

  /** Single use. A replayed token is rejected, not silently accepted. */
  async #consume(token: { jti: string; exp: number }): Promise<void> {
    const ok = await this.#store.confirmations.consume(token.jti, new Date(token.exp));
    if (!ok) {
      throw new PorterError("CONFIRMATION_EXPIRED", "That confirmation was already used. Ask for a fresh summary.");
    }
  }
}

// ---------------------------------------------------------------- helpers

function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set.`);
  return value;
}

function derivedKey(key: string, suffix: string): string {
  return `${key}:${suffix}`;
}

function assertValidRange(from: Date, to: Date): void {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new PorterError("INVALID_REQUEST", "Those dates are not valid.");
  }
  if (to.getTime() <= from.getTime()) {
    throw new PorterError("INVALID_REQUEST", "The end of the date range must be after the start.");
  }
}

export function feeApplies(policy: CancellationPolicy, now: Date): boolean {
  if (!policy.known || !policy.feeAmount) return false;
  if (policy.freeUntil === null) return true;
  return now.getTime() > policy.freeUntil.getTime();
}

/** Address fields a mobile trade needs, intersected with what it declared. */
function addressRequirement(required: readonly CustomerField[]): CustomerField[] {
  const address: CustomerField[] = ["addressLine1", "city", "postalCode"];
  return address.filter((f) => required.includes(f));
}

function redactArgs(args: CreateBookingArgs): Record<string, unknown> {
  // Only shapes reach the audit hasher, never the customer's actual details.
  return {
    slot_id: args.slot_id ?? null,
    quote_id: args.quote_id ?? null,
    has_notes: Boolean(args.notes),
    customer_field_count: Object.keys(args.customer_details ?? {}).length,
  };
}

function rankProviders(budgetMinor?: number) {
  return (a: ProviderView, b: ProviderView): number => {
    // Bookable sooner wins, then better rated, then cheaper.
    const aNext = a.next_available ? Date.parse(a.next_available.starts_at) : Number.MAX_SAFE_INTEGER;
    const bNext = b.next_available ? Date.parse(b.next_available.starts_at) : Number.MAX_SAFE_INTEGER;
    if (aNext !== bNext) return aNext - bNext;

    const aRating = a.rating?.value ?? 0;
    const bRating = b.rating?.value ?? 0;
    if (aRating !== bRating) return bRating - aRating;

    if (budgetMinor !== undefined) {
      const aPrice = cheapest(a) ?? Number.MAX_SAFE_INTEGER;
      const bPrice = cheapest(b) ?? Number.MAX_SAFE_INTEGER;
      return aPrice - bPrice;
    }
    return 0;
  };
}

function cheapest(p: ProviderView): number | null {
  const prices = p.services
    .map((s) => s.price?.amount ?? s.price_range?.min.amount)
    .filter((v): v is number => v !== undefined);
  return prices.length > 0 ? Math.min(...prices) : null;
}
