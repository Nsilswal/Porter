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
  ProviderAdapter,
  SearchQuery,
  SearchResult,
  Service,
  Slot,
} from "@porter/adapter-contract";
import type { Provider, ServiceCategory } from "@porter/core";
import { detectBlock, humanActionRequired } from "@porter/adapter-web";
import {
  extractWidget,
  parsePriceDescription,
  secondsToMinutes,
  type SquareWidget,
  type SquareWidgetService,
  type SquareWidgetVariation,
} from "./widget.js";

export * from "./widget.js";

/** A Square public booking site Porter knows about. */
export interface SquarePublicSource {
  readonly key: string;
  /** The page URL, e.g. https://book.squareup.com/appointments/<site>/location/<loc>/services */
  readonly url: string;
  readonly categories: readonly ServiceCategory[];
}

export interface SquarePublicAdapterOptions {
  readonly http: HttpClient;
  readonly id?: string;
  readonly sources: readonly SquarePublicSource[];
  readonly cacheTtlMs?: number;
}

interface CacheEntry {
  readonly widget: SquareWidget;
  readonly url: string;
  readonly fetchedAt: number;
}

/**
 * Reads Square's public booking pages.
 *
 * Where the `square-appointments` adapter needs a merchant to connect their
 * account, this one reads what a merchant already publishes for anyone to
 * see. That is the difference between covering the businesses who signed up
 * and covering the businesses who exist.
 *
 * What it gets: the business, its services and variations with real prices
 * and durations, staff, the location, the cancellation policy text, the
 * no-show cutoff, and per-variation no-show fees.
 *
 * What it does not get: live availability, which the page loads separately.
 * So `getAvailability` returns nothing rather than guessing, and booking
 * hands the user a deep link to the business's own page — the same
 * escalation the web adapter uses, and for the same reason. A wrong read
 * shows a wrong price, which the user sees before agreeing. A wrong write
 * books the wrong appointment, and nobody finds out until they turn up.
 *
 * When a merchant *has* connected their account, prefer the API adapter: it
 * has live availability and can actually complete a booking.
 */
export class SquarePublicAdapter implements ProviderAdapter {
  readonly id: string;
  readonly displayName = "Square public booking pages";
  readonly capabilities: AdapterCapabilities;

  readonly #http: HttpClient;
  readonly #sources: readonly SquarePublicSource[];
  readonly #cache = new Map<string, CacheEntry>();
  readonly #cacheTtlMs: number;

  constructor(options: SquarePublicAdapterOptions) {
    this.id = options.id ?? "square-public";
    this.#http = options.http;
    this.#sources = options.sources;
    this.#cacheTtlMs = options.cacheTtlMs ?? 15 * 60_000;

    this.capabilities = {
      slotHold: false,
      quoting: false,
      reschedule: false,
      // This one CAN report a policy, and a better one than the official API:
      // the page carries per-variation no-show fees.
      cancellationPolicy: true,
      messaging: false,
      remoteBookingList: false,
      categories: [...new Set(options.sources.flatMap((s) => s.categories))],
      // Nothing is submitted anywhere, so nothing is collected.
      requiredCustomerFields: [],
      optionalCustomerFields: [],
    };
  }

  async searchProviders(query: SearchQuery, ctx: AdapterContext): Promise<SearchResult[]> {
    assertNotAborted(ctx.signal, this.id);
    const wanted = new Set(query.categories);
    const results: SearchResult[] = [];

    for (const source of this.#sources) {
      if (results.length >= query.limit) break;
      if (wanted.size > 0 && !source.categories.some((c) => wanted.has(c))) continue;

      let entry: CacheEntry;
      try {
        entry = await this.#load(source, ctx);
      } catch (error) {
        // One unreachable page must not blank the whole search.
        ctx.log.warn("square_public_page_failed", { key: source.key, code: PorterError.is(error) ? error.code : "unknown" });
        continue;
      }

      const services = this.#services(source, entry.widget);
      if (services.length === 0) continue;

      if (query.maxPriceMinor !== undefined) {
        const priced = services.map((s) => s.price?.amount ?? s.priceRange?.min.amount).filter((v): v is number => v !== undefined);
        // Quote-required work has no comparable price, so a budget filter
        // must not silently hide it.
        if (priced.length > 0 && Math.min(...priced) > query.maxPriceMinor && !services.some((s) => s.quoteRequired)) continue;
      }

      results.push({ provider: this.#provider(source, entry.widget, services), services });
    }
    return results;
  }

  /**
   * The page loads open times separately, so Porter has none to offer.
   *
   * Returning invented slots would be exactly the "stale availability shown
   * as bookable" failure the whole design exists to prevent.
   */
  async getAvailability(query: AvailabilityQuery, ctx: AdapterContext): Promise<Slot[]> {
    assertNotAborted(ctx.signal, this.id);
    void query;
    return [];
  }

  async checkSlot(): Promise<Slot | null> {
    return null;
  }

  /**
   * The real cancellation terms, from the business's own published page.
   *
   * `no_show_cutoff_time` is seconds before the appointment after which a fee
   * applies, and the fee is carried per variation. When the business has not
   * switched no-show protection on, this reports unknown rather than free.
   */
  async getServiceCancellationPolicy(
    query: { providerId: string; serviceId: string; startsAt: Date },
    ctx: AdapterContext,
  ): Promise<CancellationPolicy> {
    assertNotAborted(ctx.signal, this.id);
    const source = this.#sourceFor(query.providerId);
    const entry = await this.#load(source, ctx);
    const business = entry.widget.business ?? {};

    const variation = this.#findVariation(entry.widget, query.serviceId);
    const feeMinor = variation?.no_show_fee_cents ?? business.no_show_flat_fee ?? null;
    const currency = business.currency_code ?? "USD";
    const cutoff = business.no_show_cutoff_time ?? null;
    const text = business.display_cancellation_policy === false ? null : (business.cancellation_policy ?? null);

    if (!business.no_show_protection_enabled && feeMinor === null && !text) {
      return { known: false, freeUntil: null, feeAmount: null, text: null };
    }

    return {
      known: true,
      freeUntil: cutoff !== null ? new Date(query.startsAt.getTime() - cutoff * 1000) : null,
      feeAmount: feeMinor !== null && feeMinor > 0 ? money(feeMinor, currency) : null,
      text: text ? untrusted(text) : null,
    };
  }

  async getCancellationPolicy(): Promise<CancellationPolicy> {
    // Without a booking of our own there is nothing to look up; the
    // pre-booking path above is the one that matters here.
    return { known: false, freeUntil: null, feeAmount: null, text: null };
  }

  async createBooking(request: CreateBookingRequest, ctx: AdapterContext): Promise<Booking> {
    assertNotAborted(ctx.signal, this.id);
    const source = this.#sourceFor(request.providerId);
    throw humanActionRequired("unknown", source.url, {
      provider_id: request.providerId,
      why: "This business has not connected its booking system to us. Open their Square page to pick a time and finish booking.",
    });
  }

  async rescheduleBooking(): Promise<Booking> {
    throw new PorterError("UNSUPPORTED_CAPABILITY", "That business's appointments have to be changed on their own booking page.");
  }

  async cancelBooking(request: CancelRequest): Promise<Booking> {
    void request;
    throw new PorterError("UNSUPPORTED_CAPABILITY", "That business's appointments have to be cancelled on their own booking page.");
  }

  // --------------------------------------------------------------- internals

  #sourceFor(providerId: string): SquarePublicSource {
    const key = providerId.startsWith(`${this.id}:`) ? providerId.slice(this.id.length + 1) : providerId;
    const source = this.#sources.find((s) => s.key === key);
    if (!source) throw new PorterError("NOT_FOUND", "We could not find that business.");
    return source;
  }

  async #load(source: SquarePublicSource, ctx: AdapterContext): Promise<CacheEntry> {
    const cached = this.#cache.get(source.key);
    if (cached && ctx.now.getTime() - cached.fetchedAt < this.#cacheTtlMs) return cached;

    const response = await this.#http.send({
      method: "GET",
      url: source.url,
      headers: { accept: "text/html,application/xhtml+xml", "user-agent": "PorterBot/0.1 (+https://porter.example/bot)" },
      signal: ctx.signal,
    });

    const html = typeof response.body === "string" ? response.body : "";

    const block = detectBlock(response.status, html);
    if (block) throw humanActionRequired(block, source.url, { provider_id: `${this.id}:${source.key}` });
    if (response.status >= 400) {
      throw new PorterError("PROVIDER_UNAVAILABLE", "That business's booking page is not reachable right now.", { details: { adapter: this.id } });
    }

    const widget = extractWidget(html);
    if (!widget) {
      // The page shape changed, or this is not a Square booking page. Say so
      // rather than returning an empty business as though it were real.
      throw new PorterError("PROVIDER_UNAVAILABLE", "We could not read that business's booking page.", {
        details: { adapter: this.id, reason: "widget_not_found" },
      });
    }

    const entry: CacheEntry = { widget, url: source.url, fetchedAt: ctx.now.getTime() };
    this.#cache.set(source.key, entry);
    return entry;
  }

  #provider(source: SquarePublicSource, widget: SquareWidget, services: readonly Service[]): Provider {
    const location = widget.locations?.[0] ?? {};
    const providerId = `${this.id}:${source.key}`;
    return {
      id: providerId,
      adapterId: this.id,
      name: untrusted(location.name ?? "Business"),
      locations: [
        {
          id: providerId,
          name: untrusted(location.name ?? "Location"),
          timezone: widget.business?.timezone ?? "UTC",
          address: {
            line1: untrusted(location.address1 ?? ""),
            city: untrusted(location.city ?? ""),
            region: untrusted(location.state ?? ""),
            postalCode: untrusted(location.zipcode ?? ""),
            countryCode: widget.business?.country ?? "US",
            ...(location.address2 ? { line2: untrusted(location.address2) } : {}),
          },
        },
      ],
      categories: [...new Set(services.map((s) => s.category).filter((c): c is ServiceCategory => c !== null))],
    };
  }

  /**
   * Flatten services to their bookable variations.
   *
   * A Square service is a menu heading; the variation is what someone books,
   * and it carries its own price, duration and no-show fee. Collapsing them
   * would lose exactly the detail the user needs to decide.
   */
  #services(source: SquarePublicSource, widget: SquareWidget): Service[] {
    const providerId = `${this.id}:${source.key}`;
    const currency = widget.business?.currency_code ?? "USD";
    const category = source.categories[0] ?? null;
    const out: Service[] = [];

    for (const service of widget.services ?? []) {
      const variations = (service.variations ?? []).filter((v) => v.is_visible_in_default_booking !== false);

      if (variations.length === 0) {
        out.push(this.#service(providerId, service.id, service.name ?? "Service", service.description ?? null, secondsToMinutes(service.time), service.price_cents ?? null, service.price_description ?? null, service.price_type, currency, category));
        continue;
      }

      for (const variation of variations) {
        const name = variation.name && variation.name !== service.name ? `${service.name} — ${variation.name}` : (service.name ?? "Service");
        out.push(
          this.#service(
            providerId,
            variation.item_variation_token ?? variation.id,
            name,
            service.description ?? null,
            secondsToMinutes(variation.service_time ?? service.time),
            variation.price_cents ?? null,
            variation.price_description ?? null,
            variation.price_type ?? service.price_type,
            currency,
            category,
          ),
        );
      }
    }
    return out;
  }

  #service(
    providerId: string,
    id: string,
    name: string,
    description: string | null,
    durationMinutes: number,
    priceCents: number | null,
    priceDescription: string | null,
    priceType: string | undefined,
    currency: string,
    category: ServiceCategory | null,
  ): Service {
    // "variable" means the business prices it in person. A range in the
    // description is shown as a range; anything vaguer stays quote-required.
    const isVariable = priceType === "variable" || priceCents === null || priceCents === 0;
    const range = isVariable ? parsePriceDescription(priceDescription) : null;
    const price: Money | undefined = !isVariable && priceCents !== null ? money(priceCents, currency) : undefined;

    return {
      id: `${providerId}:${id}`,
      providerId,
      locationId: providerId,
      name: untrusted(name),
      category,
      durationMinutes,
      quoteRequired: price === undefined,
      ...(description ? { description: untrusted(stripHtml(description)) } : {}),
      ...(price ? { price } : {}),
      ...(range ? { priceRange: { min: money(range.minMinor, currency), max: money(range.maxMinor, currency) } } : {}),
    };
  }

  #findVariation(widget: SquareWidget, serviceId: string): SquareWidgetVariation | SquareWidgetService | undefined {
    const id = serviceId.split(":").pop();
    if (!id) return undefined;
    for (const service of widget.services ?? []) {
      for (const variation of service.variations ?? []) {
        if (variation.item_variation_token === id || variation.id === id) return variation;
      }
      if (service.id === id) return service;
    }
    return undefined;
  }
}

/** Square service descriptions carry merchant-authored HTML. */
function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/\s{2,}/g, " ").trim();
}

export function createSquarePublicAdapter(options: SquarePublicAdapterOptions): SquarePublicAdapter {
  return new SquarePublicAdapter(options);
}
