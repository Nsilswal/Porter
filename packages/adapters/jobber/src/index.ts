import {
  PorterError,
  assertNotAborted,
  money,
  untrusted,
  type HttpClient,
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
  Quote,
  QuoteRequest,
  RescheduleRequest,
  SearchQuery,
  SearchResult,
  Service,
  Slot,
} from "@porter/adapter-contract";
import type { Provider, ServiceCategory } from "@porter/core";
import {
  ACCOUNT_QUERY,
  CLIENT_CREATE,
  JOBBER_API_VERSION,
  JOBBER_ENDPOINT,
  PROPERTY_CREATE,
  REQUEST_ARCHIVE,
  REQUEST_CREATE,
  REQUEST_EDIT,
  REQUEST_QUERY,
  REQUESTS_QUERY,
  type GraphQLResponse,
  type JobberAccount,
  type JobberRequest,
  type UserError,
} from "./api.js";
import { mapJobberError, mapRequestStatus, windowsFor, type ServiceOffering } from "./map.js";

export * from "./api.js";
export * from "./map.js";

export interface JobberAdapterOptions {
  readonly http: HttpClient;
  readonly endpoint?: string;
  readonly apiVersion?: string;
  readonly id?: string;
  /**
   * What this business offers.
   *
   * Jobber is field-service software, not a consumer catalog: it manages
   * jobs, quotes and invoices for one business, and publishes no list of
   * bookable services. So the offering list is established when the business
   * connects its account, rather than read from the API. Swapping this for a
   * live query is a one-method change if Jobber later exposes one.
   */
  readonly offerings?: readonly ServiceOffering[];
  /** Arrival windows the business accepts, as [startHour, endHour) local. */
  readonly arrivalWindows?: readonly (readonly [number, number])[];
  /** Days ahead that requests are accepted for. */
  readonly bookingHorizonDays?: number;
}

const DEFAULT_OFFERINGS: readonly ServiceOffering[] = [
  { key: "plumbing-leak", name: "Leak diagnosis and repair", category: "home.plumbing.leak", durationMinutes: 120, quoteRequired: true },
  { key: "plumbing-drain", name: "Drain clearing", category: "home.plumbing.drain", durationMinutes: 90, priceMinor: 22000 },
  { key: "hvac-repair", name: "AC or furnace repair", category: "home.hvac.repair", durationMinutes: 120, quoteRequired: true },
  { key: "hvac-maintenance", name: "Seasonal tune-up", category: "home.hvac.maintenance", durationMinutes: 90, priceMinor: 18900 },
  { key: "electrical-repair", name: "Electrical repair", category: "home.electrical.repair", durationMinutes: 90, quoteRequired: true },
  { key: "handyman", name: "Handyman visit", category: "home.handyman.general", durationMinutes: 60, priceMinor: 9500 },
];

const DEFAULT_WINDOWS: readonly (readonly [number, number])[] = [
  [8, 12],
  [12, 16],
];

/**
 * Jobber adapter — home services.
 *
 * Jobber works differently from Square in a way that matters, and the
 * difference is handled here rather than pushed into core.
 *
 * Square publishes open slots: you book a specific minute with a specific
 * person, and it is confirmed immediately. Jobber has no open-slot API at
 * all. A customer asks for work in an arrival window, and the business
 * schedules it afterwards.
 *
 * So for Jobber:
 *
 *   - `getAvailability` returns *requestable arrival windows*, not confirmed
 *     slots. They are real options, but the business still has to accept.
 *   - `createBooking` creates a Jobber Request and the booking comes back
 *     `pending`, not `confirmed`. That is what Porter's pending state is for.
 *   - `slotHold` is false: there is nothing to hold.
 *   - `cancellationPolicy` is false: Jobber publishes none, so Porter reports
 *     the policy as unknown rather than implying free cancellation.
 *
 * None of that required a change to core, which is the point of the
 * capability flags.
 */
export class JobberAdapter implements ProviderAdapter {
  readonly id: string;
  readonly displayName = "Jobber";
  readonly capabilities: AdapterCapabilities;

  readonly #http: HttpClient;
  readonly #endpoint: string;
  readonly #apiVersion: string;
  readonly #offerings: readonly ServiceOffering[];
  readonly #windows: readonly (readonly [number, number])[];
  readonly #horizonDays: number;
  /** Windows this adapter has already requested, so it will not re-offer one. */
  readonly #requested = new Map<string, string>();
  #account: { value: JobberAccount; fetchedAt: number } | null = null;

  constructor(options: JobberAdapterOptions) {
    this.id = options.id ?? "jobber";
    this.#http = options.http;
    this.#endpoint = options.endpoint ?? JOBBER_ENDPOINT;
    this.#apiVersion = options.apiVersion ?? JOBBER_API_VERSION;
    this.#offerings = options.offerings ?? DEFAULT_OFFERINGS;
    this.#windows = options.arrivalWindows ?? DEFAULT_WINDOWS;
    this.#horizonDays = options.bookingHorizonDays ?? 21;

    this.capabilities = {
      slotHold: false,
      quoting: true,
      reschedule: true,
      cancellationPolicy: false,
      messaging: false,
      remoteBookingList: true,
      categories: [...new Set(this.#offerings.map((o) => o.category))],
      // A visit happens at an address, so unlike Square the address is
      // genuinely required. Core will refuse before contacting Jobber if it
      // is missing, rather than creating a half-formed request.
      requiredCustomerFields: ["givenName", "phone", "addressLine1", "city", "postalCode"],
      optionalCustomerFields: ["familyName", "email", "addressLine2", "region", "notes"],
    };
  }

  // ------------------------------------------------------------------ reads

  async searchProviders(query: SearchQuery, ctx: AdapterContext): Promise<SearchResult[]> {
    assertNotAborted(ctx.signal, this.id);
    const account = await this.#accountInfo(ctx);
    const wanted = new Set(query.categories);

    const offerings = wanted.size === 0 ? this.#offerings : this.#offerings.filter((o) => wanted.has(o.category));
    if (offerings.length === 0) return [];

    if (query.maxPriceMinor !== undefined) {
      const priced = offerings.map((o) => o.priceMinor).filter((v): v is number => v !== undefined);
      // Quote-required work has no comparable price, so a budget filter must
      // not silently hide it.
      if (priced.length > 0 && Math.min(...priced) > query.maxPriceMinor && !offerings.some((o) => o.quoteRequired)) {
        return [];
      }
    }

    const services = offerings.map((o) => this.#service(o));
    const provider = this.#provider(account, services);
    const next = this.#windowSlots(offerings[0]!, query.timeWindow?.from ?? ctx.now, this.#horizonEnd(ctx), 1, ctx)[0];

    return [next ? { provider, services, nextAvailable: next } : { provider, services }];
  }

  async getAvailability(query: AvailabilityQuery, ctx: AdapterContext): Promise<Slot[]> {
    assertNotAborted(ctx.signal, this.id);
    const offering = this.#offering(query.serviceId);
    return this.#windowSlots(offering, query.from, query.to, query.limit, ctx);
  }

  async checkSlot(
    query: { providerId: string; serviceId: string; startsAt: Date; providerSlotRef?: string },
    ctx: AdapterContext,
  ): Promise<Slot | null> {
    assertNotAborted(ctx.signal, this.id);
    const offering = this.#offering(query.serviceId);
    const from = new Date(query.startsAt.getTime() - 60_000);
    const to = new Date(query.startsAt.getTime() + 60_000);
    const slots = this.#windowSlots(offering, from, to, 5, ctx);
    return slots.find((s) => s.startsAt.getTime() === query.startsAt.getTime()) ?? null;
  }

  async getQuote(request: QuoteRequest, ctx: AdapterContext): Promise<Quote> {
    assertNotAborted(ctx.signal, this.id);
    const account = await this.#accountInfo(ctx);
    const offering = request.category
      ? (this.#offerings.find((o) => o.category === request.category) ?? this.#offerings[0]!)
      : this.#offerings.find((o) => o.quoteRequired)!;

    // Jobber quotes are written by the business after they see the job, so
    // Porter does not fabricate a number here. It records the request and
    // reports the business's published range, if it has one.
    return {
      id: `${this.id}:quote:${offering.key}:${ctx.now.getTime()}`,
      adapterId: this.id,
      providerId: `${this.id}:${account.id}`,
      serviceId: `${this.id}:${account.id}:${offering.key}`,
      summary: untrusted(
        `${offering.name}. The business will confirm a price after reviewing the job${request.photoUrls?.length ? " and the photos" : ""}.`,
      ),
      expiresAt: new Date(ctx.now.getTime() + 14 * 86_400_000),
      ...(offering.priceRangeMinor
        ? { priceRange: { min: money(offering.priceRangeMinor[0]), max: money(offering.priceRangeMinor[1]) } }
        : {}),
      offeredSlots: this.#windowSlots(offering, new Date(ctx.now.getTime() + 86_400_000), this.#horizonEnd(ctx), 3, ctx),
    };
  }

  /**
   * Jobber publishes no cancellation policy, so Porter says so.
   *
   * Reporting "free cancellation" on the strength of missing data would be a
   * false statement about someone else's business.
   */
  async getCancellationPolicy(bookingRef: string, ctx: AdapterContext): Promise<CancellationPolicy> {
    assertNotAborted(ctx.signal, this.id);
    await this.#requestById(bookingRef, ctx);
    return { known: false, freeUntil: null, feeAmount: null, text: null };
  }

  async listBookings(query: ListQuery, ctx: AdapterContext): Promise<Booking[]> {
    assertNotAborted(ctx.signal, this.id);
    const account = await this.#accountInfo(ctx);
    const data = await this.#graphql<{ requests: { nodes: JobberRequest[] } }>(
      REQUESTS_QUERY,
      { first: Math.min(query.limit, 50) },
      ctx,
    );
    return (data.requests?.nodes ?? [])
      .filter((r) => (query.since ? new Date(r.arrivalWindow?.startAt ?? 0) >= query.since : true))
      .map((r) => this.#booking(account.id, r, ctx));
  }

  // ----------------------------------------------------------------- writes

  async createBooking(request: CreateBookingRequest, ctx: AdapterContext): Promise<Booking> {
    assertNotAborted(ctx.signal, this.id);
    const account = await this.#accountInfo(ctx);
    const offering = this.#offering(request.serviceId);

    const key = this.#windowKey(offering.key, request.startsAt);
    const already = this.#requested.get(key);
    if (already) {
      throw new PorterError("SLOT_TAKEN", "That arrival window has already been requested. Pick another one.");
    }

    const clientId = await this.#createClient(request.customer, ctx);
    const propertyId = await this.#createProperty(clientId, request.customer, ctx);

    const created = await this.#graphql<{ requestCreate: { request: JobberRequest; userErrors: UserError[] } }>(
      REQUEST_CREATE,
      {
        input: {
          clientId,
          propertyId,
          title: offering.name,
          ...(request.notes ? { instructions: request.notes.slice(0, 2000) } : {}),
          arrivalWindow: { startAt: request.startsAt.toISOString(), endAt: request.endsAt.toISOString() },
        },
      },
      ctx,
    );

    assertNoUserErrors(created.requestCreate?.userErrors, this.id);
    const jobberRequest = created.requestCreate?.request;
    if (!jobberRequest) throw new PorterError("ADAPTER_DOWN", "That business's system did not record the request.");

    this.#requested.set(key, jobberRequest.id);
    return this.#booking(account.id, jobberRequest, ctx, offering);
  }

  async rescheduleBooking(request: RescheduleRequest, ctx: AdapterContext): Promise<Booking> {
    assertNotAborted(ctx.signal, this.id);
    const account = await this.#accountInfo(ctx);
    const offering = this.#offering(request.serviceId);
    const existing = await this.#requestById(request.bookingRef, ctx);

    const key = this.#windowKey(offering.key, request.startsAt);
    const holder = this.#requested.get(key);
    if (holder && holder !== request.bookingRef) {
      throw new PorterError("SLOT_TAKEN", "That arrival window has already been requested. Pick another one.");
    }

    const edited = await this.#graphql<{ requestEdit: { request: JobberRequest; userErrors: UserError[] } }>(
      REQUEST_EDIT,
      {
        id: request.bookingRef,
        input: { arrivalWindow: { startAt: request.startsAt.toISOString(), endAt: request.endsAt.toISOString() } },
      },
      ctx,
    );

    assertNoUserErrors(edited.requestEdit?.userErrors, this.id);
    const updated = edited.requestEdit?.request ?? existing;

    for (const [k, v] of this.#requested) {
      if (v === request.bookingRef) this.#requested.delete(k);
    }
    this.#requested.set(key, request.bookingRef);
    return this.#booking(account.id, updated, ctx, offering);
  }

  async cancelBooking(request: CancelRequest, ctx: AdapterContext): Promise<Booking> {
    assertNotAborted(ctx.signal, this.id);
    const account = await this.#accountInfo(ctx);
    const existing = await this.#requestById(request.bookingRef, ctx);

    const archived = await this.#graphql<{ requestArchive: { request: JobberRequest; userErrors: UserError[] } }>(
      REQUEST_ARCHIVE,
      { id: request.bookingRef },
      ctx,
    );
    assertNoUserErrors(archived.requestArchive?.userErrors, this.id);

    for (const [k, v] of this.#requested) {
      if (v === request.bookingRef) this.#requested.delete(k);
    }

    const result = archived.requestArchive?.request ?? existing;
    const booking = this.#booking(account.id, result, ctx);
    // Jobber's archive is how a request ends; Porter reports it as cancelled.
    return { ...booking, status: "cancelled" };
  }

  // --------------------------------------------------------------- internals

  async #graphql<T>(query: string, variables: Record<string, unknown>, ctx: AdapterContext): Promise<T> {
    assertNotAborted(ctx.signal, this.id);
    const token = ctx.credentials.accessToken;
    if (!token) {
      throw new PorterError("PROVIDER_UNAVAILABLE", "That business's system is not connected.", {
        details: { adapter: this.id },
      });
    }

    let response;
    try {
      response = await this.#http.send({
        method: "POST",
        url: this.#endpoint,
        headers: {
          authorization: `Bearer ${token}`,
          "x-jobber-graphql-version": this.#apiVersion,
        },
        body: { query, variables },
        signal: ctx.signal,
      });
    } catch (error) {
      if (PorterError.is(error)) throw error;
      throw new PorterError("ADAPTER_DOWN", "That business's system is not responding right now. Try again in a moment.", {
        details: { adapter: this.id },
        cause: error,
      });
    }

    const payload = (response.body ?? {}) as GraphQLResponse<T>;

    // GraphQL answers 200 with an errors array, so status alone is not enough.
    if (response.status >= 400 || (payload.errors && payload.errors.length > 0)) {
      throw mapJobberError(response.status, payload.errors, this.id);
    }
    if (!payload.data) {
      throw new PorterError("ADAPTER_DOWN", "That business's system returned nothing. Try again in a moment.", {
        details: { adapter: this.id },
      });
    }

    // Jobber throttles on a points budget, not a request count. Warn early so
    // this is visible before calls start failing.
    const throttle = payload.extensions?.cost?.throttleStatus;
    if (throttle?.currentlyAvailable !== undefined && throttle.maximumAvailable !== undefined) {
      if (throttle.currentlyAvailable < throttle.maximumAvailable * 0.15) {
        ctx.log.warn("jobber_query_budget_low", {
          currentlyAvailable: throttle.currentlyAvailable,
          maximumAvailable: throttle.maximumAvailable,
        });
      }
    }

    return payload.data;
  }

  async #accountInfo(ctx: AdapterContext): Promise<JobberAccount> {
    if (this.#account && ctx.now.getTime() - this.#account.fetchedAt < 5 * 60_000) return this.#account.value;
    const data = await this.#graphql<{ account: JobberAccount }>(ACCOUNT_QUERY, {}, ctx);
    if (!data.account) throw new PorterError("PROVIDER_UNAVAILABLE", "That business's account is not available.");
    this.#account = { value: data.account, fetchedAt: ctx.now.getTime() };
    return data.account;
  }

  async #requestById(id: string, ctx: AdapterContext): Promise<JobberRequest> {
    const data = await this.#graphql<{ request: JobberRequest | null }>(REQUEST_QUERY, { id }, ctx);
    if (!data.request) throw new PorterError("NOT_FOUND", "We could not find that booking.");
    return data.request;
  }

  async #createClient(customer: CreateBookingRequest["customer"], ctx: AdapterContext): Promise<string> {
    const data = await this.#graphql<{ clientCreate: { client: { id: string }; userErrors: UserError[] } }>(
      CLIENT_CREATE,
      {
        input: {
          ...(customer.givenName ? { firstName: customer.givenName } : {}),
          ...(customer.familyName ? { lastName: customer.familyName } : {}),
          ...(customer.email ? { emails: [{ description: "MAIN", primary: true, address: customer.email }] } : {}),
          ...(customer.phone ? { phones: [{ description: "MAIN", primary: true, number: customer.phone }] } : {}),
        },
      },
      ctx,
    );
    assertNoUserErrors(data.clientCreate?.userErrors, this.id);
    const id = data.clientCreate?.client?.id;
    if (!id) throw new PorterError("ADAPTER_DOWN", "That business's system could not record your details.");
    return id;
  }

  async #createProperty(clientId: string, customer: CreateBookingRequest["customer"], ctx: AdapterContext): Promise<string> {
    const data = await this.#graphql<{ propertyCreate: { property: { id: string }; userErrors: UserError[] } }>(
      PROPERTY_CREATE,
      {
        clientId,
        input: {
          address: {
            ...(customer.addressLine1 ? { street1: customer.addressLine1 } : {}),
            ...(customer.addressLine2 ? { street2: customer.addressLine2 } : {}),
            ...(customer.city ? { city: customer.city } : {}),
            ...(customer.region ? { province: customer.region } : {}),
            ...(customer.postalCode ? { postalCode: customer.postalCode } : {}),
            country: "United States",
          },
        },
      },
      ctx,
    );
    assertNoUserErrors(data.propertyCreate?.userErrors, this.id);
    const id = data.propertyCreate?.property?.id;
    if (!id) throw new PorterError("ADAPTER_DOWN", "That business's system could not record the address.");
    return id;
  }

  #offering(serviceId: string): ServiceOffering {
    const key = serviceId.split(":").pop() ?? serviceId;
    const offering = this.#offerings.find((o) => o.key === key);
    if (!offering) throw new PorterError("NOT_FOUND", "We could not find that service.");
    return offering;
  }

  #service(offering: ServiceOffering): Service {
    const providerId = `${this.id}:${this.#account?.value.id ?? "account"}`;
    return {
      id: `${providerId}:${offering.key}`,
      providerId,
      locationId: providerId,
      name: untrusted(offering.name),
      category: offering.category,
      durationMinutes: offering.durationMinutes,
      quoteRequired: offering.quoteRequired ?? false,
      ...(offering.priceMinor !== undefined ? { price: money(offering.priceMinor) } : {}),
      ...(offering.priceRangeMinor
        ? { priceRange: { min: money(offering.priceRangeMinor[0]), max: money(offering.priceRangeMinor[1]) } }
        : {}),
    };
  }

  #provider(account: JobberAccount, services: readonly Service[]): Provider {
    return {
      id: `${this.id}:${account.id}`,
      adapterId: this.id,
      name: untrusted(account.name ?? "Home services business"),
      locations: [
        {
          id: `${this.id}:${account.id}`,
          name: untrusted(account.name ?? "Service area"),
          timezone: "UTC",
          address: {
            line1: untrusted(""),
            city: untrusted(""),
            region: untrusted(""),
            postalCode: untrusted(""),
            countryCode: "US",
          },
          // Mobile trade: they travel to the customer.
          serviceRadiusKm: 40,
        },
      ],
      categories: [...new Set(services.map((s) => s.category).filter((c): c is ServiceCategory => c !== null))],
    };
  }

  #windowSlots(offering: ServiceOffering, from: Date, to: Date, limit: number, ctx: AdapterContext): Slot[] {
    const providerId = `${this.id}:${this.#account?.value.id ?? "account"}`;
    return windowsFor({
      offering,
      windows: this.#windows,
      from,
      to,
      now: ctx.now,
      limit,
      horizonEnd: this.#horizonEnd(ctx),
      providerId,
      serviceId: `${providerId}:${offering.key}`,
      isTaken: (startsAt) => this.#requested.has(this.#windowKey(offering.key, startsAt)),
    });
  }

  #horizonEnd(ctx: AdapterContext): Date {
    return new Date(ctx.now.getTime() + this.#horizonDays * 86_400_000);
  }

  #windowKey(offeringKey: string, startsAt: Date): string {
    return `${offeringKey}|${startsAt.toISOString()}`;
  }

  #booking(accountId: string, request: JobberRequest, ctx: AdapterContext, offering?: ServiceOffering): Booking {
    const startsAt = new Date(request.arrivalWindow?.startAt ?? ctx.now.toISOString());
    const endsAt = new Date(request.arrivalWindow?.endAt ?? startsAt.getTime() + 2 * 60 * 60_000);
    const providerId = `${this.id}:${accountId}`;
    const price: Money | undefined = offering?.priceMinor !== undefined ? money(offering.priceMinor) : undefined;

    return {
      id: request.id,
      adapterId: this.id,
      providerId,
      locationId: providerId,
      serviceId: `${providerId}:${offering?.key ?? "unknown"}`,
      // Jobber requests start unscheduled: the business confirms afterwards.
      status: mapRequestStatus(request.requestStatus),
      startsAt,
      endsAt,
      cancellationPolicy: { known: false, freeUntil: null, feeAmount: null, text: null },
      providerBookingRef: request.id,
      createdAt: new Date(request.createdAt ?? ctx.now.toISOString()),
      updatedAt: new Date(request.updatedAt ?? request.createdAt ?? ctx.now.toISOString()),
      ...(price ? { price } : {}),
    };
  }
}

function assertNoUserErrors(errors: readonly UserError[] | undefined, adapterId: string): void {
  if (!errors || errors.length === 0) return;
  // userErrors carry business-rule failures. The text is Jobber's, so it is
  // not repeated to the agent.
  throw new PorterError("INVALID_REQUEST", "That business could not accept those details.", {
    details: { adapter: adapterId, fields: errors.flatMap((e) => e.path ?? []) },
  });
}

export function createJobberAdapter(options: JobberAdapterOptions): JobberAdapter {
  return new JobberAdapter(options);
}
