/**
 * Stripe wire types, taken from the published API reference.
 *
 * Only the subset Porter uses. Field names are Stripe's.
 */
export type StripePaymentIntentStatus =
  | "requires_payment_method"
  | "requires_confirmation"
  | "requires_action"
  | "processing"
  | "requires_capture"
  | "canceled"
  | "succeeded";

export interface StripePaymentIntent {
  readonly id: string;
  readonly object: "payment_intent";
  readonly amount: number;
  readonly currency: string;
  readonly status: StripePaymentIntentStatus;
  readonly customer?: string | null;
  readonly payment_method?: string | null;
  readonly application_fee_amount?: number | null;
  readonly on_behalf_of?: string | null;
  readonly transfer_data?: { readonly destination?: string } | null;
  readonly latest_charge?: string | null;
  readonly next_action?: {
    readonly type?: string;
    readonly redirect_to_url?: { readonly url?: string; readonly return_url?: string };
  } | null;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly livemode?: boolean;
}

export interface StripeRefund {
  readonly id: string;
  readonly object: "refund";
  readonly amount: number;
  readonly currency: string;
  readonly status: "pending" | "succeeded" | "failed" | "canceled" | "requires_action";
  readonly payment_intent?: string;
}

export type StripeErrorType =
  | "card_error"
  | "invalid_request_error"
  | "api_error"
  | "idempotency_error"
  | "rate_limit_error"
  | "authentication_error";

export interface StripeError {
  readonly type: StripeErrorType;
  readonly code?: string;
  readonly decline_code?: string;
  /** Written for developers, not people. Never surfaced to the agent. */
  readonly message?: string;
  readonly param?: string;
  readonly payment_intent?: { readonly id?: string; readonly status?: StripePaymentIntentStatus };
}
