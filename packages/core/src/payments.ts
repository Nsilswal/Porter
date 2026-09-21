import type { Money } from "@porter/shared";

/**
 * Payment port.
 *
 * Milestone 4 implements this with Stripe Connect in test mode. Milestone 2
 * ships the confirmation flow and the port, with a recording implementation,
 * so the tool surface is complete and the money path is exercised end to end
 * without touching a real payment rail.
 *
 * Why Connect rather than Link: Stripe Link's connector-side mechanics are
 * undocumented, and the Muse Connector Terms are silent on payments. Charging
 * through Porter's own Stripe account is the only fully specified design
 * today. See docs/muse-requirements.md section 7.
 */
export interface ChargeRequest {
  readonly userId: string;
  readonly bookingId: string;
  readonly amount: Money;
  readonly kind: "deposit" | "total";
  readonly idempotencyKey: string;
}

export interface ChargeResult {
  readonly paymentId: string;
  readonly status: "succeeded" | "requires_action" | "failed";
  readonly amount: Money;
}

export interface PaymentGateway {
  readonly id: string;
  charge(request: ChargeRequest): Promise<ChargeResult>;
}

/** Records charges in memory. Used by tests and by demo mode. */
export class RecordingPaymentGateway implements PaymentGateway {
  readonly id = "recording";
  readonly charges: ChargeRequest[] = [];
  #counter = 0;

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const existing = this.charges.find((c) => c.idempotencyKey === request.idempotencyKey);
    if (existing) {
      return { paymentId: `pay_replay_${request.idempotencyKey}`, status: "succeeded", amount: existing.amount };
    }
    this.charges.push(request);
    return { paymentId: `pay_${++this.#counter}`, status: "succeeded", amount: request.amount };
  }
}
