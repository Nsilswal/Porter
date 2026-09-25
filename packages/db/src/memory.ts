import { randomBytes } from "node:crypto";
import type {
  AuditRecord,
  AuditStore,
  BookingStore,
  BookingMutationStore,
  ConfirmationStore,
  IdempotencyRecord,
  IdempotencyOperation,
  IdempotencyStore,
  KeyStore,
  PaymentRecord,
  Store,
  StoredBooking,
} from "@porter/core";
import type { BookingStatus } from "@porter/core";
import { MemoryPaymentProfileStore, MemoryPaymentStore } from "@porter/core";

/**
 * In-memory store.
 *
 * Powers the test suite and local demo mode, and is the reference the Postgres
 * implementation is checked against. Same interface, same semantics — the
 * atomic reserve in particular, which is what makes idempotency work.
 */

class MemoryBookingStore implements BookingStore {
  constructor(
    private readonly rows: Map<string, StoredBooking>,
    private readonly payments: MemoryPaymentStore,
    private readonly mutations: Map<string, BookingMutationOwner>,
  ) {}
  async put(booking: StoredBooking): Promise<void> {
    const existing = this.rows.get(booking.id);
    if (existing && (
      existing.userId !== booking.userId
      || existing.adapterId !== booking.adapterId
      || existing.providerBookingRef !== booking.providerBookingRef
      || existing.providerId !== booking.providerId
      || existing.locationId !== booking.locationId
      || existing.serviceId !== booking.serviceId
    )) {
      throw new Error("A booking's owner and provider identity cannot change");
    }
    for (const row of this.rows.values()) {
      if (row.id !== booking.id && row.adapterId === booking.adapterId && row.providerBookingRef === booking.providerBookingRef) {
        throw new Error("A provider booking reference already belongs to another booking");
      }
    }
    this.rows.set(booking.id, structuredClone({ ...booking, createdAt: existing?.createdAt ?? booking.createdAt }));
  }
  async get(userId: string, bookingId: string): Promise<StoredBooking | null> {
    const row = this.rows.get(bookingId);
    return row?.userId === userId ? structuredClone(row) : null;
  }
  async list(userId: string, status?: BookingStatus): Promise<StoredBooking[]> {
    return [...this.rows.values()]
      .filter((r) => r.userId === userId && (status ? r.status === status : true))
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.id.localeCompare(b.id))
      .map((row) => structuredClone(row));
  }
  async deleteAllForUser(userId: string): Promise<number> {
    let n = 0;
    for (const [k, v] of this.rows) {
      if (v.userId === userId) {
        this.rows.delete(k);
        this.mutations.delete(k);
        n++;
      }
    }
    await this.payments.deleteAllForUser(userId);
    return n;
  }
}

interface BookingMutationOwner {
  readonly userId: string;
  readonly tool: string;
  readonly key: string;
}

class MemoryBookingMutationStore implements BookingMutationStore {
  constructor(
    private readonly bookings: Map<string, StoredBooking>,
    private readonly rows: Map<string, BookingMutationOwner>,
  ) {}
  async acquire(userId: string, bookingId: string, tool: string, key: string): Promise<boolean> {
    if (this.bookings.get(bookingId)?.userId !== userId) {
      throw new Error("A booking mutation must belong to a booking owned by the same user");
    }
    if (this.rows.has(bookingId)) return false;
    this.rows.set(bookingId, { userId, tool, key });
    return true;
  }
  async release(userId: string, bookingId: string, tool: string, key: string): Promise<void> {
    const row = this.rows.get(bookingId);
    if (row?.userId === userId && row.tool === tool && row.key === key) this.rows.delete(bookingId);
  }
}

/** Match the database's composite booking/owner foreign key in demo mode. */
class LinkedMemoryPaymentStore extends MemoryPaymentStore {
  constructor(private readonly bookings: Map<string, StoredBooking>) { super(); }
  override async put(record: PaymentRecord): Promise<void> {
    if (this.bookings.get(record.bookingId)?.userId !== record.userId) {
      throw new Error("A payment must belong to a booking owned by the same user");
    }
    await super.put(record);
  }
}

class MemoryIdempotencyStore implements IdempotencyStore {
  readonly #rows = new Map<string, IdempotencyRecord>();
  #key(userId: string, tool: string, key: string): string {
    return JSON.stringify([userId, tool, key]);
  }

  /**
   * Insert-if-absent. Returns the existing row when there is one, so the
   * caller can replay, conflict, or wait. Single-threaded JS gives atomicity
   * here for free; Postgres gets it from a unique index and ON CONFLICT.
   */
  async reserve(record: Omit<IdempotencyRecord, "responseCipher" | "state" | "operation"> & { state: "in_flight" }): Promise<IdempotencyRecord | null> {
    const k = this.#key(record.userId, record.tool, record.key);
    const existing = this.#rows.get(k);
    // Expiry is retention metadata, never permission to repeat a side effect.
    if (existing) return structuredClone(existing);
    this.#rows.set(k, structuredClone({ ...record, responseCipher: null, operation: null }));
    return null;
  }

  async complete(userId: string, tool: string, key: string, responseCipher: string): Promise<void> {
    const k = this.#key(userId, tool, key);
    const row = this.#rows.get(k);
    if (!row) throw new Error("Cannot complete an unreserved idempotency key");
    if (row.state === "completed" && row.responseCipher !== responseCipher) {
      throw new Error("Cannot replace a completed idempotency response");
    }
    this.#rows.set(k, { ...row, state: "completed", responseCipher });
  }

  async markUncertain(userId: string, tool: string, key: string, operation: IdempotencyOperation): Promise<void> {
    const k = this.#key(userId, tool, key);
    const row = this.#rows.get(k);
    if (!row || row.state === "completed") throw new Error("Cannot mark this idempotency key uncertain");
    const fields: readonly (keyof IdempotencyOperation)[] = ["adapterId", "providerId", "providerOperation", "idempotencyKey", "providerBookingRef"];
    if (row.operation && fields.some((field) => operation[field] !== row.operation?.[field])) {
      throw new Error("Cannot replace an uncertain operation's identity");
    }
    this.#rows.set(k, { ...row, state: "uncertain", operation: { ...operation } });
  }

  async release(userId: string, tool: string, key: string): Promise<void> {
    const k = this.#key(userId, tool, key);
    if (this.#rows.get(k)?.state === "in_flight") this.#rows.delete(k);
  }

  async get(userId: string, tool: string, key: string): Promise<IdempotencyRecord | null> {
    const row = this.#rows.get(this.#key(userId, tool, key));
    return row ? structuredClone(row) : null;
  }

  async deleteAllForUser(userId: string): Promise<number> {
    let n = 0;
    for (const [k, v] of this.#rows) {
      if (v.userId === userId) {
        this.#rows.delete(k);
        n++;
      }
    }
    return n;
  }
}

class MemoryConfirmationStore implements ConfirmationStore {
  readonly #spent = new Map<string, Date>();
  async consume(jti: string, expiresAt: Date): Promise<boolean> {
    if (this.#spent.has(jti)) return false;
    this.#spent.set(jti, new Date(expiresAt));
    return true;
  }
  async deleteExpired(now: Date): Promise<number> {
    let n = 0;
    for (const [k, exp] of this.#spent) {
      if (exp.getTime() <= now.getTime()) {
        this.#spent.delete(k);
        n++;
      }
    }
    return n;
  }
}

class MemoryKeyStore implements KeyStore {
  readonly #keys = new Map<string, Buffer>();
  async getOrCreate(userId: string): Promise<Buffer> {
    let key = this.#keys.get(userId);
    if (!key) {
      key = randomBytes(32);
      this.#keys.set(userId, key);
    }
    return Buffer.from(key);
  }
  async destroy(userId: string): Promise<void> {
    this.#keys.get(userId)?.fill(0);
    this.#keys.delete(userId);
  }
}

class MemoryAuditStore implements AuditStore {
  readonly rows: AuditRecord[] = [];
  #seq = 0;
  async append(record: AuditRecord): Promise<void> {
    this.rows.push(structuredClone({ ...record, seq: ++this.#seq }));
  }
  async list(actorId: string, limit = 100): Promise<AuditRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Audit limit must be a nonnegative integer");
    if (limit === 0) return [];
    return this.rows.filter((r) => r.actorId === actorId).slice(-limit).map((row) => structuredClone(row));
  }
}

export interface MemoryStore extends Store {
  readonly auditRows: AuditRecord[];
  readonly payments: MemoryPaymentStore;
  readonly paymentProfiles: MemoryPaymentProfileStore;
}

export function createMemoryStore(): MemoryStore {
  const audit = new MemoryAuditStore();
  const bookingRows = new Map<string, StoredBooking>();
  const mutations = new Map<string, BookingMutationOwner>();
  const payments = new LinkedMemoryPaymentStore(bookingRows);
  const paymentProfiles = new MemoryPaymentProfileStore();
  return {
    bookings: new MemoryBookingStore(bookingRows, payments, mutations),
    bookingMutations: new MemoryBookingMutationStore(bookingRows, mutations),
    idempotency: new MemoryIdempotencyStore(),
    confirmations: new MemoryConfirmationStore(),
    keys: new MemoryKeyStore(),
    audit,
    payments,
    paymentProfiles,
    get auditRows() {
      return audit.rows;
    },
  };
}
