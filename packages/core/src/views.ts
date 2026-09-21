import { formatMoney, sanitize, type Money } from "@porter/shared";
import type { Booking, Provider, Service, Slot } from "./domain.js";
import type { StoredBooking } from "./ports.js";

/**
 * Agent-facing shapes.
 *
 * Every provider-supplied string passes through `sanitize()` on the way out.
 * This is the only place domain objects become tool output, so it is the one
 * place that has to get the untrusted-text handling right.
 */

export interface MoneyView {
  readonly amount: number;
  readonly currency: string;
  readonly formatted: string;
}

export const moneyView = (m: Money): MoneyView => ({
  amount: m.amount,
  currency: m.currency,
  formatted: formatMoney(m),
});

export interface ProviderView {
  readonly provider_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly city: string;
  readonly region: string;
  readonly postal_code: string;
  readonly rating: { value: number; count: number; source: string } | null;
  readonly categories: readonly string[];
  readonly services: readonly ServiceView[];
  readonly next_available: SlotView | null;
}

export interface ServiceView {
  readonly service_id: string;
  readonly name: string;
  readonly description: string | null;
  readonly category: string | null;
  readonly duration_minutes: number;
  readonly price: MoneyView | null;
  readonly price_range: { min: MoneyView; max: MoneyView } | null;
  readonly quote_required: boolean;
  readonly deposit_required: MoneyView | null;
}

export interface SlotView {
  readonly slot_id: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly price: MoneyView | null;
}

export interface BookingView {
  readonly booking_id: string;
  readonly status: string;
  readonly provider: string;
  readonly service: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly price: MoneyView | null;
}

export function serviceView(s: Service): ServiceView {
  return {
    service_id: s.id,
    name: sanitize(s.name, { maxLength: 120, label: "service name" }),
    description: s.description ? sanitize(s.description, { maxLength: 300, label: "service description" }) : null,
    category: s.category,
    duration_minutes: s.durationMinutes,
    price: s.price ? moneyView(s.price) : null,
    price_range: s.priceRange ? { min: moneyView(s.priceRange.min), max: moneyView(s.priceRange.max) } : null,
    quote_required: s.quoteRequired,
    deposit_required: s.depositRequired ? moneyView(s.depositRequired) : null,
  };
}

export function slotView(slotId: string, s: Slot): SlotView {
  return {
    slot_id: slotId,
    starts_at: s.startsAt.toISOString(),
    ends_at: s.endsAt.toISOString(),
    price: s.price ? moneyView(s.price) : null,
  };
}

export function providerView(
  p: Provider,
  services: readonly Service[],
  nextAvailable: SlotView | null,
): ProviderView {
  const loc = p.locations[0];
  return {
    provider_id: p.id,
    name: sanitize(p.name, { maxLength: 120, label: "business name" }),
    description: p.description ? sanitize(p.description, { maxLength: 300, label: "business description" }) : null,
    city: loc ? sanitize(loc.address.city, { maxLength: 80, label: "city" }) : "",
    region: loc ? sanitize(loc.address.region, { maxLength: 40, label: "region" }) : "",
    postal_code: loc ? sanitize(loc.address.postalCode, { maxLength: 20, label: "postal code" }) : "",
    rating: p.rating ? { value: p.rating.value, count: p.rating.count, source: sanitize(p.rating.source, { maxLength: 60 }) } : null,
    categories: p.categories,
    services: services.map(serviceView),
    next_available: nextAvailable,
  };
}

export function bookingView(b: StoredBooking): BookingView {
  return {
    booking_id: b.id,
    status: b.status,
    provider: b.providerName,
    service: b.serviceName,
    starts_at: b.startsAt.toISOString(),
    ends_at: b.endsAt.toISOString(),
    price: b.priceMinor !== null && b.currency ? moneyView({ amount: b.priceMinor, currency: b.currency }) : null,
  };
}

export function bookingViewFromDomain(b: Booking, providerName: string, serviceName: string): BookingView {
  return {
    booking_id: b.id,
    status: b.status,
    provider: sanitize(providerName, { maxLength: 120, label: "business name" }),
    service: sanitize(serviceName, { maxLength: 120, label: "service name" }),
    starts_at: b.startsAt.toISOString(),
    ends_at: b.endsAt.toISOString(),
    price: b.price ? moneyView(b.price) : null,
  };
}
