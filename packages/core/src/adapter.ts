import type { Logger } from "@porter/shared";
import type {
  Booking,
  CancellationPolicy,
  CustomerDetails,
  Provider,
  Quote,
  Slot,
  SlotHold,
  Service,
} from "./domain.js";
import type { ServiceCategory } from "./taxonomy.js";
import type { CustomerField } from "./customer.js";

/**
 * The single interface every provider platform implements.
 *
 * Adding Vagaro, Boulevard, Housecall Pro, ServiceTitan, Mindbody or MoeGo
 * later means writing one of these and passing the conformance suite. It must
 * not mean editing core. Two things make that work:
 *
 *   1. `capabilities`, which lets platforms differ in what they support.
 *      Core reads it and degrades rather than failing.
 *   2. `requiredCustomerFields`, which is how Terms section 4.3(e) data
 *      minimisation is enforced: core projects the customer record down to
 *      exactly what this adapter declared before calling it.
 */
export interface AdapterCapabilities {
  /** Can hold a slot briefly while the user confirms. */
  readonly slotHold: boolean;
  /** Supports quote-required jobs via `getQuote`. */
  readonly quoting: boolean;
  /** Can move an existing booking rather than cancel-and-rebook. */
  readonly reschedule: boolean;
  /** Exposes a machine-readable cancellation policy. */
  readonly cancellationPolicy: boolean;
  /** Supports messaging a provider about a booking. */
  readonly messaging: boolean;
  /** Can list bookings made outside Porter. */
  readonly remoteBookingList: boolean;
  /** Categories this adapter can serve. Used to skip irrelevant searches. */
  readonly categories: readonly ServiceCategory[];
  /** Minimum customer fields this platform needs to create a booking. */
  readonly requiredCustomerFields: readonly CustomerField[];
  /** Fields it can use if present, but does not require. */
  readonly optionalCustomerFields: readonly CustomerField[];
}

/**
 * Per-call context. Adapters read no global state and never touch the database.
 * Credentials live here for the duration of one call only.
 */
export interface AdapterContext {
  /** Pseudonymous caller id. Never an email or a phone number. */
  readonly actorId: string;
  readonly log: Logger;
  readonly signal: AbortSignal;
  /** Decrypted provider credentials, scoped to this call. */
  readonly credentials: Readonly<Record<string, string>>;
  readonly now: Date;
}

export interface SearchQuery {
  readonly categories: readonly ServiceCategory[];
  readonly text?: string;
  readonly near?: { readonly lat: number; readonly lon: number } | { readonly postalCode: string };
  readonly radiusKm?: number;
  readonly timeWindow?: { readonly from: Date; readonly to: Date };
  readonly maxPriceMinor?: number;
  readonly currency?: string;
  readonly limit: number;
}

export interface SearchResult {
  readonly provider: Provider;
  readonly services: readonly Service[];
  /** Earliest slot the adapter knows of, when it can say cheaply. */
  readonly nextAvailable?: Slot;
}

export interface AvailabilityQuery {
  readonly providerId: string;
  readonly serviceId: string;
  readonly from: Date;
  readonly to: Date;
  readonly limit: number;
}

export interface QuoteRequest {
  readonly providerId: string;
  readonly jobDescription: string;
  readonly address: CustomerDetails;
  readonly photoUrls?: readonly string[];
  readonly category?: ServiceCategory;
}

export interface CreateBookingRequest {
  readonly providerId: string;
  readonly locationId: string;
  readonly serviceId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly providerSlotRef?: string;
  readonly holdRef?: string;
  readonly quoteId?: string;
  /** Already projected to this adapter's declared fields. See core/customer.ts. */
  readonly customer: CustomerDetails;
  readonly notes?: string;
  /** Forwarded to the platform when it supports its own idempotency. */
  readonly idempotencyKey: string;
}

export interface RescheduleRequest {
  readonly bookingRef: string;
  readonly providerId: string;
  readonly serviceId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly providerSlotRef?: string;
  readonly idempotencyKey: string;
}

export interface CancelRequest {
  readonly bookingRef: string;
  readonly providerId: string;
  readonly reason?: string;
  readonly idempotencyKey: string;
}

export interface ListQuery {
  readonly since?: Date;
  readonly limit: number;
}

export interface MessageRequest {
  readonly bookingRef: string;
  readonly providerId: string;
  readonly message: string;
}

export interface MessageReceipt {
  readonly deliveredAt: Date;
  readonly ref: string;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: AdapterCapabilities;

  searchProviders(query: SearchQuery, ctx: AdapterContext): Promise<SearchResult[]>;
  getAvailability(query: AvailabilityQuery, ctx: AdapterContext): Promise<Slot[]>;

  /**
   * Re-read a single slot immediately before committing a booking.
   *
   * Returns null when the slot is gone. Porter never books on cached
   * availability; Terms section 4.1 requires stale data to be fixed promptly,
   * and a double booking is the worst failure this product can have.
   */
  checkSlot(
    query: { providerId: string; serviceId: string; startsAt: Date; providerSlotRef?: string },
    ctx: AdapterContext,
  ): Promise<Slot | null>;

  getQuote?(request: QuoteRequest, ctx: AdapterContext): Promise<Quote>;
  holdSlot?(query: { providerId: string; serviceId: string; startsAt: Date; providerSlotRef?: string }, ctx: AdapterContext): Promise<SlotHold>;

  createBooking(request: CreateBookingRequest, ctx: AdapterContext): Promise<Booking>;
  rescheduleBooking(request: RescheduleRequest, ctx: AdapterContext): Promise<Booking>;
  cancelBooking(request: CancelRequest, ctx: AdapterContext): Promise<Booking>;
  getCancellationPolicy(bookingRef: string, ctx: AdapterContext): Promise<CancellationPolicy>;

  listBookings?(query: ListQuery, ctx: AdapterContext): Promise<Booking[]>;
  messageProvider?(request: MessageRequest, ctx: AdapterContext): Promise<MessageReceipt>;
}
