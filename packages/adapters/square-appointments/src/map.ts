import { PorterError, money, untrusted, type Money } from "@porter/shared";
import type { Booking, CancellationPolicy, Location, Provider, Service, ServiceCategory, Slot } from "@porter/core";
import { isServiceCategory } from "@porter/core";
import {
  serviceDurationMinutes,
  type SquareBooking,
  type SquareBookingStatus,
  type SquareBusinessBookingProfile,
  type SquareCatalogObject,
  type SquareError,
  type SquareLocation,
} from "./api.js";

/**
 * Square -> Porter mapping.
 *
 * Everything Square returns that a merchant typed is wrapped as
 * `untrusted()`. That includes business names, service names and the
 * cancellation policy text, all of which are free-text fields in the Square
 * dashboard and therefore an injection surface.
 */

/**
 * Square has no taxonomy Porter can rely on: sellers name their own catalog
 * categories and service names. So mapping is by keyword over the seller's
 * own text, and anything that does not match maps to null rather than a
 * guess. A null-category service stays searchable by text but is never
 * auto-matched, which is the rule in core/taxonomy.ts.
 */
const KEYWORD_CATEGORIES: readonly (readonly [RegExp, ServiceCategory])[] = [
  [/\bbalayage|highlight|colou?r|toner|gloss\b/i, "beauty.hair.color"],
  [/\bblow\s?dry|blowout|styling|updo\b/i, "beauty.hair.styling"],
  [/\bbarber|fade|clipper|beard\b/i, "beauty.barber"],
  [/\bhair\s?cut|haircut|\bcut\b|trim\b/i, "beauty.haircut"],
  [/\bpedicure|pedi\b/i, "beauty.nails.pedicure"],
  [/\bmanicure|mani\b|gel\s?nails?|acrylic/i, "beauty.nails.manicure"],
  [/\blash|extensions?\s+lash|brow\s?lamination\b/i, "beauty.lashes"],
  [/\bwax|waxing|sugaring\b/i, "beauty.waxing"],
  [/\bmassage|deep\s?tissue|swedish\b/i, "beauty.massage"],
  [/\bfacial|peel|microderm/i, "beauty.facial"],
  [/\bmake\s?up|makeup\b/i, "beauty.makeup"],
];

export function inferCategory(...texts: readonly (string | undefined)[]): ServiceCategory | null {
  const haystack = texts.filter(Boolean).join(" ");
  if (!haystack.trim()) return null;
  for (const [pattern, category] of KEYWORD_CATEGORIES) {
    if (pattern.test(haystack)) return category;
  }
  return null;
}

export function mapLocation(adapterId: string, loc: SquareLocation): Location {
  const a = loc.address ?? {};
  return {
    id: `${adapterId}:${loc.id}`,
    name: untrusted(loc.name ?? loc.business_name ?? "Location"),
    timezone: loc.timezone ?? "UTC",
    address: {
      line1: untrusted(a.address_line_1 ?? ""),
      city: untrusted(a.locality ?? ""),
      region: untrusted(a.administrative_district_level_1 ?? ""),
      postalCode: untrusted(a.postal_code ?? ""),
      countryCode: a.country ?? "US",
      ...(a.address_line_2 ? { line2: untrusted(a.address_line_2) } : {}),
      ...(loc.coordinates?.latitude !== undefined ? { lat: loc.coordinates.latitude } : {}),
      ...(loc.coordinates?.longitude !== undefined ? { lon: loc.coordinates.longitude } : {}),
    },
  };
}

export function mapProvider(
  adapterId: string,
  loc: SquareLocation,
  services: readonly Service[],
  unmapped: readonly string[],
): Provider {
  const categories = [...new Set(services.map((s) => s.category).filter((c): c is ServiceCategory => c !== null))];
  return {
    id: `${adapterId}:${loc.id}`,
    adapterId,
    name: untrusted(loc.business_name ?? loc.name ?? "Business"),
    locations: [mapLocation(adapterId, loc)],
    categories,
    ...(loc.description ? { description: untrusted(loc.description) } : {}),
    // Square exposes no rating on a location, so Porter reports none rather
    // than sourcing one elsewhere. Policies forbid false engagement signals.
    ...(unmapped.length > 0 ? { unmappedCategories: unmapped } : {}),
  };
}

export interface MappedVariation {
  readonly service: Service;
  readonly variationId: string;
  readonly variationVersion: number;
  readonly teamMemberIds: readonly string[];
}

export function mapServiceVariation(
  adapterId: string,
  locationId: string,
  item: SquareCatalogObject,
  variation: SquareCatalogObject,
  categoryName: string | undefined,
): MappedVariation | null {
  const v = variation.item_variation_data;
  if (!v || v.available_for_booking === false) return null;

  const itemName = item.item_data?.name ?? "";
  const variationName = v.name ?? "";
  const fullName = variationName && variationName !== itemName ? `${itemName} — ${variationName}` : itemName;

  const price: Money | undefined =
    v.pricing_type === "VARIABLE_PRICING" || v.price_money?.amount === undefined
      ? undefined
      : money(v.price_money.amount, v.price_money.currency ?? "USD");

  const service: Service = {
    id: `${adapterId}:${locationId}:${variation.id}`,
    providerId: `${adapterId}:${locationId}`,
    locationId: `${adapterId}:${locationId}`,
    name: untrusted(fullName || "Service"),
    category: inferCategory(itemName, variationName, item.item_data?.description, categoryName),
    durationMinutes: serviceDurationMinutes(v.service_duration),
    // Square's appointments are priced, not quoted. VARIABLE_PRICING means
    // the seller sets the price in person, which Porter surfaces honestly as
    // quote-required rather than inventing a number.
    quoteRequired: price === undefined,
    ...(item.item_data?.description ? { description: untrusted(item.item_data.description) } : {}),
    ...(price ? { price } : {}),
  };

  return {
    service,
    variationId: variation.id,
    variationVersion: variation.version ?? 0,
    teamMemberIds: v.team_member_ids ?? [],
  };
}

export function mapSlot(
  adapterId: string,
  locationId: string,
  serviceId: string,
  startAt: string,
  durationMinutes: number,
  fetchedAt: Date,
  price: Money | undefined,
  teamMemberId: string | undefined,
): Slot {
  const startsAt = new Date(startAt);
  return {
    providerId: `${adapterId}:${locationId}`,
    locationId: `${adapterId}:${locationId}`,
    serviceId,
    startsAt,
    endsAt: new Date(startsAt.getTime() + durationMinutes * 60_000),
    fetchedAt,
    // The team member is part of the slot's identity: Square books a specific
    // person, and losing it would silently rebook with someone else.
    ...(teamMemberId ? { providerSlotRef: teamMemberId } : {}),
    ...(price ? { price } : {}),
  };
}

export function mapBookingStatus(status: SquareBookingStatus | undefined): Booking["status"] {
  switch (status) {
    case "ACCEPTED":
      return "confirmed";
    case "PENDING":
      return "pending";
    case "CANCELLED_BY_CUSTOMER":
    case "CANCELLED_BY_SELLER":
    case "DECLINED":
      return "cancelled";
    case "NO_SHOW":
      return "no_show";
    default:
      return "pending";
  }
}

export function mapBooking(
  adapterId: string,
  booking: SquareBooking,
  durationMinutes: number,
  policy: CancellationPolicy,
  price: Money | undefined,
): Booking {
  const startsAt = new Date(booking.start_at ?? new Date().toISOString());
  const segment = booking.appointment_segments?.[0];
  const locationId = booking.location_id ?? "unknown";
  return {
    id: booking.id,
    adapterId,
    providerId: `${adapterId}:${locationId}`,
    locationId: `${adapterId}:${locationId}`,
    serviceId: `${adapterId}:${locationId}:${segment?.service_variation_id ?? "unknown"}`,
    status: mapBookingStatus(booking.status),
    startsAt,
    endsAt: new Date(startsAt.getTime() + (segment?.duration_minutes ?? durationMinutes) * 60_000),
    cancellationPolicy: policy,
    providerBookingRef: booking.id,
    createdAt: new Date(booking.created_at ?? startsAt),
    updatedAt: new Date(booking.updated_at ?? booking.created_at ?? startsAt),
    ...(price ? { price } : {}),
  };
}

/**
 * Cancellation policy from the seller's booking profile.
 *
 * `known` is false whenever the seller has not configured one. Porter says
 * "unknown" instead of reporting a zero fee, because a wrong fee is worse
 * than an absent one and Terms 4.1 requires accuracy.
 */
export function mapCancellationPolicy(
  profile: SquareBusinessBookingProfile | undefined,
  startsAt: Date,
): CancellationPolicy {
  const settings = profile?.business_appointment_settings;
  if (!settings) return { known: false, freeUntil: null, feeAmount: null, text: null };

  const windowSeconds = settings.cancellation_window_seconds;
  const feeAmount = settings.cancellation_fee_money?.amount;

  // Neither a window nor a fee means nothing was configured. Do not claim
  // "free cancellation" on the strength of missing data.
  if (windowSeconds === undefined && feeAmount === undefined) {
    return { known: false, freeUntil: null, feeAmount: null, text: null };
  }

  return {
    known: true,
    freeUntil: windowSeconds !== undefined ? new Date(startsAt.getTime() - windowSeconds * 1000) : null,
    feeAmount: feeAmount !== undefined && feeAmount > 0 ? money(feeAmount, settings.cancellation_fee_money?.currency ?? "USD") : null,
    text: settings.cancellation_policy_text ? untrusted(settings.cancellation_policy_text) : null,
  };
}

/**
 * Square errors -> Porter's closed taxonomy.
 *
 * Unmapped codes become ADAPTER_DOWN. Square's `detail` string is never
 * surfaced to the agent: it is provider-controlled text.
 */
export function mapSquareError(status: number, errors: readonly SquareError[] | undefined, adapterId: string): PorterError {
  const first = errors?.[0];
  const code = first?.code ?? "";

  switch (code) {
    case "BAD_REQUEST":
    case "VALUE_EMPTY":
    case "INVALID_TIME":
    case "INVALID_VALUE":
      return new PorterError("INVALID_REQUEST", "That request was not valid for this business.", { details: { adapter: adapterId } });
    case "NOT_FOUND":
      return new PorterError("NOT_FOUND", "We could not find that at this business.", { details: { adapter: adapterId } });
    case "CONFLICT":
    case "BOOKING_CONFLICT":
    case "TIME_SLOT_UNAVAILABLE":
      return new PorterError("SLOT_TAKEN", "That time was just taken. Pick another one.", { details: { adapter: adapterId } });
    case "RATE_LIMITED":
      return new PorterError("RATE_LIMITED", "That booking system is busy. Try again shortly.", { retryAfterSeconds: 5, details: { adapter: adapterId } });
    case "UNAUTHORIZED":
    case "ACCESS_TOKEN_EXPIRED":
    case "ACCESS_TOKEN_REVOKED":
    case "INSUFFICIENT_SCOPES":
      return new PorterError("PROVIDER_UNAVAILABLE", "We have lost access to that business's booking system. It needs reconnecting.", { details: { adapter: adapterId } });
    default:
      break;
  }

  if (status === 404) return new PorterError("NOT_FOUND", "We could not find that at this business.", { details: { adapter: adapterId } });
  if (status === 409) return new PorterError("SLOT_TAKEN", "That time was just taken. Pick another one.", { details: { adapter: adapterId } });
  if (status === 429) return new PorterError("RATE_LIMITED", "That booking system is busy. Try again shortly.", { retryAfterSeconds: 5, details: { adapter: adapterId } });
  if (status === 401 || status === 403) {
    return new PorterError("PROVIDER_UNAVAILABLE", "We have lost access to that business's booking system. It needs reconnecting.", { details: { adapter: adapterId } });
  }

  return new PorterError("ADAPTER_DOWN", "That booking system is not responding right now. Try again in a moment.", {
    details: { adapter: adapterId },
  });
}
