import type { Booking, BookingStatus } from "./domain.js";
import type { CustomerField } from "./customer.js";

/**
 * Storage ports.
 *
 * Core depends on these interfaces, never on a driver. The in-memory
 * implementation powers tests; the Drizzle/Postgres implementation powers
 * Railway. Swapping one for the other changes no core code.
 */

export interface StoredBooking {
  readonly id: string;
  readonly userId: string;
  readonly adapterId: string;
  readonly providerBookingRef: string;
  readonly status: BookingStatus;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly providerId: string;
  readonly locationId: string;
  readonly serviceId: string;
  /** Display copy, already sanitised. Cached so list_my_bookings is cheap. */
  readonly providerName: string;
  readonly serviceName: string;
  readonly priceMinor: number | null;
  readonly currency: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface BookingStore {
  put(booking: StoredBooking): Promise<void>;
  get(userId: string, bookingId: string): Promise<StoredBooking | null>;
  list(userId: string, status?: BookingStatus): Promise<StoredBooking[]>;
  /** Purge on user deletion or revocation. Terms section 4.3(f). */
  deleteAllForUser(userId: string): Promise<number>;
}

export type IdempotencyState = "in_flight" | "completed";

export interface IdempotencyRecord {
  readonly userId: string;
  readonly tool: string;
  readonly key: string;
  /** Hash of the request payload. The payload itself is never stored. */
  readonly argsHash: string;
  readonly state: IdempotencyState;
  /** Encrypted response envelope. Null while in flight. */
  readonly responseCipher: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface IdempotencyStore {
  /**
   * Reserve a key atomically. Returns the existing record when one is present,
   * so the caller can replay, conflict, or wait.
   */
  reserve(record: Omit<IdempotencyRecord, "responseCipher" | "state"> & { state: "in_flight" }): Promise<IdempotencyRecord | null>;
  complete(userId: string, tool: string, key: string, responseCipher: string): Promise<void>;
  release(userId: string, tool: string, key: string): Promise<void>;
  get(userId: string, tool: string, key: string): Promise<IdempotencyRecord | null>;
  deleteAllForUser(userId: string): Promise<number>;
}

/** Single-use confirmation tokens. Presence of a row means "already spent". */
export interface ConfirmationStore {
  consume(jti: string, expiresAt: Date): Promise<boolean>;
  deleteExpired(now: Date): Promise<number>;
}

/**
 * Per-user encryption keys.
 *
 * Idempotency responses can contain personal data. They are stored encrypted
 * under a per-user key; deleting the key renders every such record
 * inaccessible, which is what Terms section 4.3(f) asks for.
 */
export interface KeyStore {
  getOrCreate(userId: string): Promise<Buffer>;
  destroy(userId: string): Promise<void>;
}

/** Audit rows. No personal data, by construction. See audit.ts. */
export interface AuditRecord {
  readonly seq?: number;
  readonly at: Date;
  readonly actorId: string;
  readonly tool: string;
  readonly action: string;
  readonly adapterId: string | null;
  readonly providerId: string | null;
  readonly argsHash: string;
  readonly idempotencyKey: string | null;
  readonly confirmationJti: string | null;
  readonly outcome: "ok" | "error";
  readonly errorCode: string | null;
  readonly latencyMs: number;
  /** Customer field NAMES disclosed downstream. Never values. */
  readonly disclosedFields: readonly CustomerField[];
}

export interface AuditStore {
  append(record: AuditRecord): Promise<void>;
  list(actorId: string, limit?: number): Promise<AuditRecord[]>;
}

export interface Store {
  readonly bookings: BookingStore;
  readonly idempotency: IdempotencyStore;
  readonly confirmations: ConfirmationStore;
  readonly keys: KeyStore;
  readonly audit: AuditStore;
}

export type { Booking };
