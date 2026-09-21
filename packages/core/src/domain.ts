import type { Money, UntrustedText } from "@porter/shared";
import type { ServiceCategory } from "./taxonomy.js";
import type { CustomerDetails } from "./customer.js";

/**
 * The normalised domain. Every adapter maps its platform onto these shapes.
 *
 * Text fields that originate from a provider are typed `UntrustedText`, so
 * they cannot be serialised into a tool response without passing through
 * `sanitize()` first.
 */

export interface Address {
  readonly line1: UntrustedText;
  readonly line2?: UntrustedText;
  readonly city: UntrustedText;
  readonly region: UntrustedText;
  readonly postalCode: UntrustedText;
  readonly countryCode: string;
  readonly lat?: number;
  readonly lon?: number;
}

export interface Provider {
  readonly id: string;
  readonly adapterId: string;
  readonly name: UntrustedText;
  readonly description?: UntrustedText;
  /** Genuine provider rating only. Never synthesised, never blended. */
  readonly rating?: { readonly value: number; readonly count: number; readonly source: string };
  readonly locations: readonly Location[];
  readonly categories: readonly ServiceCategory[];
  /** Provider categories the adapter could not map. Kept for observability. */
  readonly unmappedCategories?: readonly string[];
}

export interface Location {
  readonly id: string;
  readonly name: UntrustedText;
  readonly address: Address;
  readonly timezone: string;
  /** Present for mobile trades. Absent means the customer travels to them. */
  readonly serviceRadiusKm?: number;
}

export interface Service {
  readonly id: string;
  readonly providerId: string;
  readonly locationId: string;
  readonly name: UntrustedText;
  readonly description?: UntrustedText;
  readonly category: ServiceCategory | null;
  readonly durationMinutes: number;
  /** Absent when the service is quote-required. */
  readonly price?: Money;
  readonly priceRange?: { readonly min: Money; readonly max: Money };
  readonly quoteRequired: boolean;
  readonly depositRequired?: Money;
}

export interface Slot {
  readonly providerId: string;
  readonly locationId: string;
  readonly serviceId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly price?: Money;
  /** When this slot was read from the provider. Drives staleness checks. */
  readonly fetchedAt: Date;
  /** Opaque provider-side handle, when the platform issues one. */
  readonly providerSlotRef?: string;
}

export interface SlotHold {
  readonly ref: string;
  readonly expiresAt: Date;
}

export interface Quote {
  readonly id: string;
  readonly adapterId: string;
  readonly providerId: string;
  readonly serviceId?: string;
  readonly summary: UntrustedText;
  readonly price?: Money;
  readonly priceRange?: { readonly min: Money; readonly max: Money };
  readonly expiresAt: Date;
  readonly depositRequired?: Money;
  /** Slots the provider offered alongside the quote, when it did. */
  readonly offeredSlots?: readonly Slot[];
}

export type BookingStatus = "pending" | "confirmed" | "completed" | "cancelled" | "no_show";

export interface CancellationPolicy {
  /**
   * False when the provider platform does not expose a policy. Porter says
   * "unknown" rather than inventing a fee — a wrong fee is worse than an
   * absent one, and Terms section 4.1 requires accuracy.
   */
  readonly known: boolean;
  readonly freeUntil: Date | null;
  readonly feeAmount: Money | null;
  readonly text: UntrustedText | null;
}

export interface Booking {
  readonly id: string;
  readonly adapterId: string;
  readonly providerId: string;
  readonly locationId: string;
  readonly serviceId: string;
  readonly status: BookingStatus;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly price?: Money;
  readonly deposit?: Money;
  readonly cancellationPolicy: CancellationPolicy;
  /** Provider's own identifier, needed for later operations. */
  readonly providerBookingRef: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type PaymentStatus = "none" | "deposit_paid" | "paid" | "refunded" | "failed";

export interface Payment {
  readonly id: string;
  readonly bookingId: string;
  readonly amount: Money;
  readonly kind: "deposit" | "total";
  readonly status: PaymentStatus;
  readonly createdAt: Date;
}

/** Valid booking state transitions. Core owns this; adapters never decide it. */
const TRANSITIONS: Readonly<Record<BookingStatus, readonly BookingStatus[]>> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["completed", "cancelled", "no_show"],
  completed: [],
  cancelled: [],
  no_show: [],
};

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: BookingStatus, to: BookingStatus): void {
  if (from === to) return;
  if (!canTransition(from, to)) {
    throw new Error(`Invalid booking transition: ${from} -> ${to}`);
  }
}

export type { CustomerDetails };
