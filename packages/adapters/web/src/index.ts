import {
  PorterError,
  assertNotAborted,
  money,
  untrusted,
  type HttpClient,
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
import { detectBlock, humanActionRequired } from "./escalation.js";
import { parseBusiness, type ParsedBusiness } from "./parse.js";

export * from "./escalation.js";
export * from "./parse.js";

/** A business Porter knows the public page of. */
export interface WebSource {
  readonly key: string;
  readonly url: string;
  readonly categories: readonly ServiceCategory[];
  /** Coarse location, for filtering before any page is fetched. */
  readonly postalCode?: string;
  readonly city?: string;
}

export interface WebAdapterOptions {
  readonly http: HttpClient;
  readonly id?: string;
  readonly sources: readonly WebSource[];
  readonly cacheTtlMs?: number;
  readonly maxConcurrent?: number;
}

interface CacheEntry {
  readonly parsed: ParsedBusiness;
  readonly url: string;
  readonly fetchedAt: number;
}

/**
 * Reads public booking pages.
 *
 * This adapter exists to cover businesses that are not on a platform Porter
 * integrates with. It is deliberately **read-only**, and that is a design
 * decision rather than an unfinished one.
 *
 * Reading a page and booking through one are different risks. A parser that
 * drifts on a read returns a wrong price, which the confirmation step catches
 * because the user sees it. A parser that drifts on a *write* submits the
 * wrong form and books the wrong appointment, and there is no error to catch
 * — the booking just happens. Porter's central promise is that it does not do
 * that.
 *
 * So writes escalate to the person, with a deep link to the business's own
 * booking page. That is the same pattern as a CAPTCHA or a bank asking for
 * 3-D Secure: when the agent cannot proceed safely, it explains and hands
 * over rather than pushing through.
 *
 * Scraped content is the most hostile input Porter takes — the business
 * controls the page, and so does anyone who can get text onto it. Everything
 * extracted is `UntrustedText` and cannot reach the agent unsanitised.
 */
export class WebAdapter implements ProviderAdapter {
  readonly id: string;
  readonly displayName = "Public booking pages";
  readonly capabilities: AdapterCapabilities;

  readonly #http: HttpClient;
  readonly #sources: readonly WebSource[];
  readonly #cache = new Map<string, CacheEntry>();
  readonly #cacheTtlMs: number;
  readonly #maxConcurrent: number;

  constructor(options: WebAdapterOptions) {
    this.id = options.id ?? "web";
    this.#http = options.http;
    this.#sources = options.sources;
    this.#cacheTtlMs = options.cacheTtlMs ?? 15 * 60_000;
    this.#maxConcurrent = options.maxConcurrent ?? 4;

    this.capabilities = {
      slotHold: false,
      quoting: false,
      // Everything that changes state is handed to the person.
      reschedule: false,
      cancellationPolicy: false,
      messaging: false,
      remoteBookingList: false,
      categories: [...new Set(options.sources.flatMap((s) => s.categories))],
      // Nothing is sent anywhere, because Porter does not submit these forms.
      requiredCustomerFields: [],
      optionalCustomerFields: [],
    };
  }

  async searchProviders(query: SearchQuery, ctx: AdapterContext): Promise<SearchResult[]> {
    assertNotAborted(ctx.signal, this.id);
    const wanted = new Set(query.categories);

    const candidates = this.#sources.filter((source) => {
      if (wanted.size > 0 && !source.categories.some((c) => wanted.has(c))) return false;
      if (query.near && "postalCode" in query.near && source.postalCode) {
        return source.postalCode === query.near.postalCode;
      }
      return true;
    });

    const results: SearchResult[] = [];
    // Fetch a few at a time. Hammering a small business's site in parallel is
    // both rude and the fastest way to get blocked.
    for (let i = 0; i < candidates.length && results.length < query.limit; i += this.#maxConcurrent) {
      const batch = candidates.slice(i, i + this.#maxConcurrent);
      const fetched = await Promise.all(batch.map((source) => this.#load(source, ctx).catch(() => null)));

      for (const [index, entry] of fetched.entries()) {
        if (!entry) continue;
        const source = batch[index]!;
        const provider = this.#toProvider(source, entry);
        const services = this.#toServices(source, entry);
        if (services.length === 0) continue;
        results.push({ provider, services });
        if (results.length >= query.limit) break;
      }
    }
    return results;
  }

  /**
   * Public pages rarely publish machine-readable open times, and guessing at
   * them would be exactly the "stale availability presented as bookable"
   * failure Porter exists to avoid. So this returns nothing and the booking
   * step sends the person to the business's own page.
   */
  async getAvailability(query: AvailabilityQuery, ctx: AdapterContext): Promise<Slot[]> {
    assertNotAborted(ctx.signal, this.id);
    void query;
    return [];
  }

  async checkSlot(): Promise<Slot | null> {
    return null;
  }

  async getCancellationPolicy(): Promise<CancellationPolicy> {
    // A page might state a policy in prose. Porter will not turn prose into a
    // number and present it as fact.
    return { known: false, freeUntil: null, feeAmount: null, text: null };
  }

  async createBooking(request: CreateBookingRequest, ctx: AdapterContext): Promise<Booking> {
    assertNotAborted(ctx.signal, this.id);
    const source = this.#sourceFor(request.providerId);
    const entry = await this.#load(source, ctx);
    const url = entry.parsed.bookingUrl ?? entry.url;

    throw humanActionRequired("unknown", url, {
      provider_id: request.providerId,
      why: "This business is not connected to a booking system we can write to. Open their page to finish booking.",
    });
  }

  async rescheduleBooking(): Promise<Booking> {
    throw new PorterError("UNSUPPORTED_CAPABILITY", "That business's appointments have to be changed on their own site.");
  }

  async cancelBooking(request: CancelRequest): Promise<Booking> {
    void request;
    throw new PorterError("UNSUPPORTED_CAPABILITY", "That business's appointments have to be cancelled on their own site.");
  }

  // --------------------------------------------------------------- internals

  #sourceFor(providerId: string): WebSource {
    const key = providerId.startsWith(`${this.id}:`) ? providerId.slice(this.id.length + 1) : providerId;
    const source = this.#sources.find((s) => s.key === key);
    if (!source) throw new PorterError("NOT_FOUND", "We could not find that business.");
    return source;
  }

  async #load(source: WebSource, ctx: AdapterContext): Promise<CacheEntry> {
    const cached = this.#cache.get(source.key);
    if (cached && ctx.now.getTime() - cached.fetchedAt < this.#cacheTtlMs) return cached;

    const response = await this.#http.send({
      method: "GET",
      url: source.url,
      headers: {
        accept: "text/html,application/xhtml+xml",
        // Identify honestly. A site that wants to refuse Porter should be able
        // to, and a contact address is how they tell us.
        "user-agent": "PorterBot/0.1 (+https://porter.example/bot)",
      },
      signal: ctx.signal,
    });

    const html = typeof response.body === "string" ? response.body : JSON.stringify(response.body ?? "");

    // Check for a wall before treating any of this as data. Parsing a block
    // page as content is how a scraper starts returning quiet nonsense.
    const block = detectBlock(response.status, html);
    if (block) throw humanActionRequired(block, source.url, { provider_id: `${this.id}:${source.key}` });

    if (response.status >= 400) {
      throw new PorterError("PROVIDER_UNAVAILABLE", "That business's site is not reachable right now.", {
        details: { adapter: this.id },
      });
    }

    const parsed = parseBusiness(html, source.url);
    if (!parsed) {
      throw new PorterError("PROVIDER_UNAVAILABLE", "We could not read that business's page.", {
        details: { adapter: this.id },
      });
    }

    const entry: CacheEntry = { parsed, url: source.url, fetchedAt: ctx.now.getTime() };
    this.#cache.set(source.key, entry);
    return entry;
  }

  #toProvider(source: WebSource, entry: CacheEntry): Provider {
    const p = entry.parsed;
    return {
      id: `${this.id}:${source.key}`,
      adapterId: this.id,
      name: p.name,
      locations: [
        {
          id: `${this.id}:${source.key}`,
          name: p.name,
          timezone: "UTC",
          address: {
            line1: untrusted(""),
            city: p.city ?? untrusted(source.city ?? ""),
            region: p.region ?? untrusted(""),
            postalCode: p.postalCode ?? untrusted(source.postalCode ?? ""),
            countryCode: "US",
          },
        },
      ],
      categories: [...source.categories],
      ...(p.description ? { description: p.description } : {}),
    };
  }

  #toServices(source: WebSource, entry: CacheEntry): Service[] {
    const providerId = `${this.id}:${source.key}`;
    const category = source.categories[0] ?? null;

    if (entry.parsed.services.length === 0) {
      // The page named no services, so Porter offers one honest placeholder
      // rather than inventing a menu.
      return [
        {
          id: `${providerId}:enquire`,
          providerId,
          locationId: providerId,
          name: untrusted("Booking on the business's own site"),
          category,
          durationMinutes: 60,
          quoteRequired: true,
        },
      ];
    }

    return entry.parsed.services.map((s, index) => ({
      id: `${providerId}:${s.externalRef ?? index}`,
      providerId,
      locationId: providerId,
      name: s.name,
      category,
      durationMinutes: s.durationMinutes ?? 60,
      // No price on the page means quote-required. It never means free.
      quoteRequired: s.priceMinor === null,
      ...(s.priceMinor !== null ? { price: money(s.priceMinor, s.currency ?? "USD") } : {}),
    }));
  }
}

export function createWebAdapter(options: WebAdapterOptions): WebAdapter {
  return new WebAdapter(options);
}
