import type { Money } from "@porter/shared";

/**
 * Payment ports.
 *
 * Porter charges through its own Stripe account using Connect destination
 * charges, with the service business as the connected account. That design is
 * fully specified today; Stripe Link's connector-side mechanics are not, and
 * the Muse Connector Terms are silent on payments entirely. See
 * docs/muse-requirements.md section 7.
 */

export type ChargeKind = "deposit" | "total" | "cancellation_fee";

export type ChargeStatus =
  | "succeeded"
  /**
   * The bank wants the cardholder to authenticate.
   *
   * This is the case that matters most for an agent: the user is not at a
   * checkout page, so nobody can complete 3-D Secure on their behalf. Porter
   * must hand the agent something it can actually tell the person to do.
   */
  | "requires_action"
  | "failed";

/** Mapped failure reasons. Never a raw gateway string. */
export type ChargeFailureReason =
  | "authentication_required"
  | "card_declined"
  | "insufficient_funds"
  | "expired_card"
  | "no_payment_method"
  | "gateway_error";

export interface ChargeRequest {
  readonly userId: string;
  readonly bookingId: string;
  readonly amount: Money;
  readonly kind: ChargeKind;
  readonly idempotencyKey: string;
  /** Saved customer and payment method. Porter never handles raw card data. */
  readonly customerRef: string;
  readonly paymentMethodRef: string;
  /** The business's connected account, when Porter knows it. */
  readonly destinationAccountRef?: string;
  /** Porter's cut, in minor units. Zero or absent means none. */
  readonly applicationFeeMinor?: number;
  readonly description?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface ChargeResult {
  readonly paymentId: string;
  readonly status: ChargeStatus;
  readonly amount: Money;
  readonly reason?: ChargeFailureReason;
  /** Where the user must go to authenticate, when the bank demands it. */
  readonly actionUrl?: string;
}

export interface RefundRequest {
  readonly paymentId: string;
  readonly amount?: Money;
  readonly idempotencyKey: string;
  readonly reason?: "requested_by_customer" | "duplicate";
}

export interface RefundResult {
  readonly refundId: string;
  readonly status: "succeeded" | "pending" | "failed";
  readonly amount: Money;
}

export interface PaymentGateway {
  readonly id: string;
  charge(request: ChargeRequest): Promise<ChargeResult>;
  refund(request: RefundRequest): Promise<RefundResult>;
}

/**
 * The user's saved payment details.
 *
 * Porter stores references, never card numbers. Entering card details is
 * something Porter never does: the user saves a method with the gateway
 * directly, and Porter keeps the resulting opaque ids.
 */
export interface PaymentProfile {
  readonly customerRef: string;
  readonly paymentMethodRef: string;
  /** For display only, e.g. "Visa ending 4242". Never the full number. */
  readonly label: string;
}

export interface PaymentProfileStore {
  get(userId: string): Promise<PaymentProfile | null>;
  put(userId: string, profile: PaymentProfile): Promise<void>;
  deleteAllForUser(userId: string): Promise<number>;
}

/**
 * Where a business's money goes.
 *
 * Populated when a business is onboarded to Connect. When there is no entry,
 * Porter charges to its own account and settles with the business separately,
 * rather than guessing at a destination.
 */
export interface PayoutDirectory {
  lookup(adapterId: string, providerId: string): Promise<string | null>;
}

export interface PaymentRecord {
  readonly id: string;
  readonly userId: string;
  readonly bookingId: string;
  readonly gatewayId: string;
  readonly gatewayPaymentRef: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly kind: ChargeKind;
  readonly status: ChargeStatus | "refunded";
  readonly createdAt: Date;
}

export interface PaymentStore {
  put(record: PaymentRecord): Promise<void>;
  listForBooking(userId: string, bookingId: string): Promise<PaymentRecord[]>;
  listForUser(userId: string): Promise<PaymentRecord[]>;
  deleteAllForUser(userId: string): Promise<number>;
}

/** Records charges in memory. Used by tests and by demo mode. */
export class RecordingPaymentGateway implements PaymentGateway {
  readonly id = "recording";
  readonly charges: ChargeRequest[] = [];
  readonly refunds: RefundRequest[] = [];
  #counter = 0;
  #nextResult: Partial<ChargeResult> | null = null;

  /** Force the next charge to a given outcome, for tests. */
  setNextResult(result: Partial<ChargeResult>): void {
    this.#nextResult = result;
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const replay = this.charges.find((c) => c.idempotencyKey === request.idempotencyKey);
    if (replay) {
      return { paymentId: `pay_replay_${request.idempotencyKey}`, status: "succeeded", amount: replay.amount };
    }
    this.charges.push(request);
    const override = this.#nextResult;
    this.#nextResult = null;
    return { paymentId: `pay_${++this.#counter}`, status: "succeeded", amount: request.amount, ...override };
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    this.refunds.push(request);
    return {
      refundId: `re_${++this.#counter}`,
      status: "succeeded",
      amount: request.amount ?? { amount: 0, currency: "USD" },
    };
  }
}

/** In-memory payment profile store. */
export class MemoryPaymentProfileStore implements PaymentProfileStore {
  readonly #rows = new Map<string, PaymentProfile>();
  async get(userId: string): Promise<PaymentProfile | null> {
    const profile = this.#rows.get(userId);
    return profile ? structuredClone(profile) : null;
  }
  async put(userId: string, profile: PaymentProfile): Promise<void> {
    this.#rows.set(userId, structuredClone(profile));
  }
  async deleteAllForUser(userId: string): Promise<number> {
    return this.#rows.delete(userId) ? 1 : 0;
  }
}

/** In-memory payout directory. */
export class MemoryPayoutDirectory implements PayoutDirectory {
  readonly #rows = new Map<string, string>();
  set(adapterId: string, providerId: string, accountRef: string): void {
    this.#rows.set(JSON.stringify([adapterId, providerId]), accountRef);
  }
  async lookup(adapterId: string, providerId: string): Promise<string | null> {
    return this.#rows.get(JSON.stringify([adapterId, providerId])) ?? null;
  }
}

/** In-memory payment records. */
export class MemoryPaymentStore implements PaymentStore {
  readonly rows: PaymentRecord[] = [];
  async put(record: PaymentRecord): Promise<void> {
    const existing = this.rows.findIndex((r) => r.id === record.id);
    if (existing < 0) {
      this.rows.push(structuredClone(record));
      return;
    }
    const previous = this.rows[existing]!;
    if (previous.userId !== record.userId || previous.bookingId !== record.bookingId || previous.gatewayId !== record.gatewayId || previous.gatewayPaymentRef !== record.gatewayPaymentRef) {
      throw new Error("Payment identity cannot be changed.");
    }
    this.rows[existing] = structuredClone({ ...record, createdAt: previous.createdAt });
  }
  async listForBooking(userId: string, bookingId: string): Promise<PaymentRecord[]> {
    return this.rows.filter((r) => r.userId === userId && r.bookingId === bookingId).map((record) => structuredClone(record));
  }
  async listForUser(userId: string): Promise<PaymentRecord[]> {
    return this.rows.filter((r) => r.userId === userId).map((record) => structuredClone(record));
  }
  async deleteAllForUser(userId: string): Promise<number> {
    let n = 0;
    for (let i = this.rows.length - 1; i >= 0; i--) {
      if (this.rows[i]!.userId === userId) {
        this.rows.splice(i, 1);
        n++;
      }
    }
    return n;
  }
}
