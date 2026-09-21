import { randomBytes } from "node:crypto";
import type {
  AuditRecord,
  AuditStore,
  BookingStore,
  ConfirmationStore,
  IdempotencyRecord,
  IdempotencyStore,
  KeyStore,
  Store,
  StoredBooking,
} from "@porter/core";
import type { BookingStatus } from "@porter/core";

/**
 * In-memory store.
 *
 * Powers the test suite and local demo mode, and is the reference the Postgres
 * implementation is checked against. Same interface, same semantics — the
 * atomic reserve in particular, which is what makes idempotency work.
 */

class MemoryBookingStore implements BookingStore {
  readonly #rows = new Map<string, StoredBooking>();
  #key(userId: string, id: string): string {
    return `${userId}|${id}`;
  }
  async put(booking: StoredBooking): Promise<void> {
    this.#rows.set(this.#key(booking.userId, booking.id), booking);
  }
  async get(userId: string, bookingId: string): Promise<StoredBooking | null> {
    return this.#rows.get(this.#key(userId, bookingId)) ?? null;
  }
  async list(userId: string, status?: BookingStatus): Promise<StoredBooking[]> {
    return [...this.#rows.values()]
      .filter((r) => r.userId === userId && (status ? r.status === status : true))
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
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

class MemoryIdempotencyStore implements IdempotencyStore {
  readonly #rows = new Map<string, IdempotencyRecord>();
  #key(userId: string, tool: string, key: string): string {
    return `${userId}|${tool}|${key}`;
  }

  /**
   * Insert-if-absent. Returns the existing row when there is one, so the
   * caller can replay, conflict, or wait. Single-threaded JS gives atomicity
   * here for free; Postgres gets it from a unique index and ON CONFLICT.
   */
  async reserve(record: Omit<IdempotencyRecord, "responseCipher" | "state"> & { state: "in_flight" }): Promise<IdempotencyRecord | null> {
    const k = this.#key(record.userId, record.tool, record.key);
    const existing = this.#rows.get(k);
    if (existing) {
      if (existing.expiresAt.getTime() > Date.now()) return existing;
      this.#rows.delete(k);
    }
    this.#rows.set(k, { ...record, responseCipher: null });
    return null;
  }

  async complete(userId: string, tool: string, key: string, responseCipher: string): Promise<void> {
    const k = this.#key(userId, tool, key);
    const row = this.#rows.get(k);
    if (row) this.#rows.set(k, { ...row, state: "completed", responseCipher });
  }

  async release(userId: string, tool: string, key: string): Promise<void> {
    this.#rows.delete(this.#key(userId, tool, key));
  }

  async get(userId: string, tool: string, key: string): Promise<IdempotencyRecord | null> {
    return this.#rows.get(this.#key(userId, tool, key)) ?? null;
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
    this.#spent.set(jti, expiresAt);
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
    return key;
  }
  async destroy(userId: string): Promise<void> {
    this.#keys.delete(userId);
  }
}

class MemoryAuditStore implements AuditStore {
  readonly rows: AuditRecord[] = [];
  #seq = 0;
  async append(record: AuditRecord): Promise<void> {
    this.rows.push({ ...record, seq: ++this.#seq });
  }
  async list(actorId: string, limit = 100): Promise<AuditRecord[]> {
    return this.rows.filter((r) => r.actorId === actorId).slice(-limit);
  }
}

export interface MemoryStore extends Store {
  readonly auditRows: AuditRecord[];
}

export function createMemoryStore(): MemoryStore {
  const audit = new MemoryAuditStore();
  return {
    bookings: new MemoryBookingStore(),
    idempotency: new MemoryIdempotencyStore(),
    confirmations: new MemoryConfirmationStore(),
    keys: new MemoryKeyStore(),
    audit,
    get auditRows() {
      return audit.rows;
    },
  };
}
