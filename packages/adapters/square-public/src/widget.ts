/**
 * Square's public booking page carries its whole state in one place.
 *
 * A page at book.squareup.com/appointments/<site>/location/<loc>/services
 * renders a `<meta name="widget" content="...">` tag holding the complete
 * booking widget model as HTML-entity-encoded JSON: the business, its
 * services and variations, staff, categories, the location, fees, and the
 * cancellation and deposit configuration.
 *
 * Two things follow from that, and both matter.
 *
 * It is far more robust than HTML scraping. These are stable field names in a
 * server-rendered data model, not CSS classes. A redesign changes the markup;
 * it does not rename `price_cents`.
 *
 * And it is richer than Square's official API in one respect: no-show fees
 * are carried **per service variation**, where the Bookings API exposes only
 * an account-level cancellation fee. For a business whose colour service
 * forfeits $120 and whose kids' cut forfeits $45, this is the accurate one.
 *
 * This is an internal, undocumented surface. It can change without notice,
 * so every field is read defensively and a parse failure is reported rather
 * than guessed around.
 */

export interface SquareWidgetBusiness {
  readonly id?: string;
  readonly allow_user_cancel?: boolean;
  readonly cancellation_policy?: string | null;
  readonly display_cancellation_policy?: boolean;
  readonly no_show_protection_enabled?: boolean;
  /** Seconds before the appointment after which a fee applies. */
  readonly no_show_cutoff_time?: number | null;
  readonly no_show_flat_fee?: number | null;
  readonly deposits_enabled?: boolean;
  readonly deposit_charge_type?: string | null;
  readonly deposit_amount_cents?: number | null;
  readonly deposit_amount_percentage?: number | null;
  readonly currency_code?: string;
  readonly timezone?: string;
  readonly country?: string;
  /** Seconds of notice required before a booking. */
  readonly cutoff_time?: number | null;
  /** How far ahead bookings are accepted, in seconds. */
  readonly future_booking_limit_time?: number | null;
  readonly any_staff_booking_enabled?: boolean;
}

export interface SquareWidgetVariation {
  readonly id: string;
  readonly name?: string;
  readonly item_variation_token?: string;
  readonly price_type?: "fixed" | "variable" | string;
  readonly price_cents?: number | null;
  /** Free text such as "$120-$170" when pricing is variable. */
  readonly price_description?: string | null;
  readonly no_show_fee_cents?: number | null;
  readonly no_show_fee_percentage?: number | null;
  /** Seconds, not minutes. */
  readonly service_time?: number | null;
  readonly transition_time?: number | null;
  readonly staff_ids?: readonly string[];
  readonly is_visible_in_default_booking?: boolean;
}

export interface SquareWidgetService {
  readonly id: string;
  readonly name?: string;
  readonly description?: string | null;
  readonly category_token?: string | null;
  readonly price_cents?: number | null;
  readonly price_type?: string;
  readonly price_description?: string | null;
  readonly currency_code?: string;
  readonly no_show_fee_cents?: number | null;
  /** Seconds. */
  readonly time?: number | null;
  readonly staff_ids?: readonly string[];
  readonly item_variation_token?: string;
  readonly variations?: readonly SquareWidgetVariation[];
}

export interface SquareWidgetStaff {
  readonly id: string;
  readonly first_name?: string;
  readonly last_name?: string;
  readonly long_name?: string;
  readonly short_name?: string;
}

export interface SquareWidgetLocation {
  readonly name?: string;
  readonly address1?: string | null;
  readonly address2?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly zipcode?: string | null;
  readonly type?: string;
}

export interface SquareWidgetCategory {
  readonly id?: string;
  readonly token?: string;
  readonly name?: string;
}

export interface SquareWidget {
  readonly id?: string;
  readonly business?: SquareWidgetBusiness;
  readonly business_location_id?: string;
  readonly services?: readonly SquareWidgetService[];
  readonly staff?: readonly SquareWidgetStaff[];
  readonly categories?: readonly SquareWidgetCategory[];
  readonly locations?: readonly SquareWidgetLocation[];
}

/** Decode the HTML entities Square uses to embed the JSON in an attribute. */
export function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    // Ampersand last, or an escaped entity would be decoded twice.
    .replace(/&amp;/g, "&");
}

/** Pull the widget model out of a page. Returns null when it is not there. */
export function extractWidget(html: string): SquareWidget | null {
  const match = /<meta\s+name=["']widget["']\s+content=["']([\s\S]*?)["']\s*\/?>/i.exec(html);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(decodeEntities(match[1])) as SquareWidget;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Square states durations in seconds; Porter's domain is minutes throughout. */
export function secondsToMinutes(seconds: number | null | undefined, fallback = 60): number {
  return seconds && seconds > 0 ? Math.round(seconds / 60) : fallback;
}

/**
 * Read a price range out of free text such as "$120-$170".
 *
 * Only a clear low-to-high pair is accepted. Anything ambiguous returns null,
 * because a made-up range shown as a real one is worse than showing none.
 */
export function parsePriceDescription(text: string | null | undefined): { minMinor: number; maxMinor: number } | null {
  if (!text) return null;
  const numbers = [...text.matchAll(/\$?\s*([\d][\d,]*(?:\.\d{1,2})?)/g)].map((m) =>
    Math.round(Number.parseFloat(m[1]!.replace(/,/g, "")) * 100),
  );
  const valid = numbers.filter((n) => Number.isFinite(n) && n > 0);
  if (valid.length < 2) return null;

  const minMinor = Math.min(...valid);
  const maxMinor = Math.max(...valid);
  return maxMinor > minMinor ? { minMinor, maxMinor } : null;
}
