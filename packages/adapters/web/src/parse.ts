import { untrusted, type UntrustedText } from "@porter/shared";

/**
 * Extracting booking data from a public page.
 *
 * Structured data first, DOM shapes only as a fallback. A business's
 * JSON-LD or embedded state is far more stable than its markup: a CSS class
 * changes on a whim, a schema.org type does not. That matters more here than
 * in most scraping, because a page that parses wrongly does not error — it
 * books the wrong thing.
 *
 * Everything extracted is `UntrustedText`. Scraped page content is the single
 * most hostile input Porter takes: the business controls it, and so does
 * anyone who can get text onto their page.
 */

export interface ParsedService {
  readonly name: UntrustedText;
  readonly durationMinutes: number | null;
  readonly priceMinor: number | null;
  readonly currency: string | null;
  readonly externalRef: string | null;
}

export interface ParsedBusiness {
  readonly name: UntrustedText;
  readonly description: UntrustedText | null;
  readonly city: UntrustedText | null;
  readonly region: UntrustedText | null;
  readonly postalCode: UntrustedText | null;
  readonly telephone: UntrustedText | null;
  readonly services: readonly ParsedService[];
  readonly bookingUrl: string | null;
  /** How the data was obtained, so callers can weigh how much to trust it. */
  readonly source: "json-ld" | "embedded-state" | "dom";
}

/**
 * Pull every JSON-LD block out of a page.
 *
 * The obvious non-greedy regex is wrong on real pages. A JSON string
 * containing the literal text `</script>` — which happens both in sloppy
 * markup and in pages built to confuse a reader — ends the match early and
 * truncates the JSON. So each opening tag is closed at successive candidate
 * `</script>` positions, and the first one that parses wins.
 */
export function extractJsonLd(html: string): unknown[] {
  const out: unknown[] = [];
  const opening = /<script[^>]+type=["']application\/ld\+json["'][^>]*>/gi;
  let tag: RegExpExecArray | null;

  while ((tag = opening.exec(html)) !== null) {
    const start = tag.index + tag[0].length;
    let cursor = start;
    let raw: string | null = null;

    for (let attempt = 0; attempt < 8; attempt++) {
      const close = html.indexOf("</script", cursor);
      if (close === -1) break;
      const candidate = html.slice(start, close);
      try {
        JSON.parse(candidate.trim());
        raw = candidate;
        break;
      } catch {
        // That closing tag was inside a string. Try the next one.
        cursor = close + 8;
      }
    }

    if (raw === null) continue;
    opening.lastIndex = start + raw.length;

    try {
      const parsed = JSON.parse(raw.trim());
      // A @graph holds several entities in one block.
      if (parsed && typeof parsed === "object" && Array.isArray((parsed as any)["@graph"])) {
        out.push(...(parsed as any)["@graph"]);
      } else if (Array.isArray(parsed)) {
        out.push(...parsed);
      } else {
        out.push(parsed);
      }
    } catch {
      // A malformed block is skipped rather than failing the whole page.
    }
  }
  return out;
}

const BUSINESS_TYPES = new Set([
  "LocalBusiness",
  "HealthAndBeautyBusiness",
  "HairSalon",
  "BeautySalon",
  "DaySpa",
  "NailSalon",
  "HomeAndConstructionBusiness",
  "Plumber",
  "Electrician",
  "HVACBusiness",
  "HousePainter",
  "GeneralContractor",
  "Locksmith",
  "MovingCompany",
  "RoofingContractor",
  "ProfessionalService",
]);

function typesOf(node: unknown): string[] {
  const t = (node as any)?.["@type"];
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  return [];
}

export function parseBusiness(html: string, pageUrl: string): ParsedBusiness | null {
  const nodes = extractJsonLd(html);

  const business = nodes.find((n) => typesOf(n).some((t) => BUSINESS_TYPES.has(t)));
  if (business) {
    const b = business as any;
    const address = b.address ?? {};
    const services = parseOfferCatalog(b);
    return {
      name: untrusted(String(b.name ?? "")),
      description: b.description ? untrusted(String(b.description)) : null,
      city: address.addressLocality ? untrusted(String(address.addressLocality)) : null,
      region: address.addressRegion ? untrusted(String(address.addressRegion)) : null,
      postalCode: address.postalCode ? untrusted(String(address.postalCode)) : null,
      telephone: b.telephone ? untrusted(String(b.telephone)) : null,
      services,
      bookingUrl: findBookingUrl(b, html, pageUrl),
      source: "json-ld",
    };
  }

  // No structured data. Fall back to the title and any obvious booking link,
  // and report the weaker source so the caller knows what it is holding.
  const title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html)?.[1]?.trim();
  if (!title) return null;
  // Page titles are conventionally "Business Name | tagline". Split on the
  // separators used for that, but never on a plain hyphen: plenty of real
  // business names contain one.
  const name = title.split(/\s+[|·—–]\s+/)[0]?.trim() || title;
  return {
    name: untrusted(name),
    description: null,
    city: null,
    region: null,
    postalCode: null,
    telephone: null,
    services: [],
    bookingUrl: findBookingUrl(null, html, pageUrl),
    source: "dom",
  };
}

/** schema.org `hasOfferCatalog` is the usual home for a service list. */
function parseOfferCatalog(business: any): ParsedService[] {
  const catalog = business?.hasOfferCatalog;
  const items: any[] = catalog?.itemListElement ?? business?.makesOffer ?? [];
  const out: ParsedService[] = [];

  for (const entry of Array.isArray(items) ? items : []) {
    const offer = entry?.itemOffered ?? entry;
    const name = offer?.name ?? entry?.name;
    if (!name) continue;

    const price = entry?.price ?? entry?.priceSpecification?.price ?? offer?.offers?.price;
    const currency = entry?.priceCurrency ?? entry?.priceSpecification?.priceCurrency ?? offer?.offers?.priceCurrency;

    out.push({
      name: untrusted(String(name)),
      durationMinutes: parseIsoDuration(offer?.duration ?? entry?.duration),
      priceMinor: parsePriceMinor(price),
      currency: typeof currency === "string" ? currency.toUpperCase() : price !== undefined ? "USD" : null,
      externalRef: typeof offer?.["@id"] === "string" ? offer["@id"] : null,
    });
  }
  return out;
}

/** ISO 8601 durations, e.g. PT45M or PT1H30M. */
export function parseIsoDuration(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^P(?:([\d.]+)D)?T?(?:([\d.]+)H)?(?:([\d.]+)M)?/.exec(value.trim());
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const total = days * 1440 + hours * 60 + minutes;
  return total > 0 ? Math.round(total) : null;
}

/** Money as minor units. Never a float, and never a guess. */
export function parsePriceMinor(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/[^\d.,-]/g, "").replace(/,/g, "");
  if (!text) return null;
  const amount = Number.parseFloat(text);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return Math.round(amount * 100);
}

function findBookingUrl(business: any, html: string, pageUrl: string): string | null {
  const candidate =
    business?.potentialAction?.target?.urlTemplate ??
    business?.potentialAction?.target ??
    business?.potentialAction?.url;
  if (typeof candidate === "string") return absolutise(candidate, pageUrl);

  const link = /<a[^>]+href=["']([^"']+)["'][^>]*>(?:[^<]{0,40})book(?:\s+now)?/i.exec(html);
  return link?.[1] ? absolutise(link[1], pageUrl) : null;
}

function absolutise(href: string, pageUrl: string): string | null {
  try {
    return new URL(href, pageUrl).toString();
  } catch {
    return null;
  }
}
