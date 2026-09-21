import { PorterError, money, type HttpClient, type Money } from "@porter/shared";
import type {
  ChargeFailureReason,
  ChargeRequest,
  ChargeResult,
  ChargeStatus,
  PaymentGateway,
  RefundRequest,
  RefundResult,
} from "@porter/core";

export * from "./types.js";
import type { StripeError, StripePaymentIntent, StripeRefund } from "./types.js";

export interface StripeGatewayOptions {
  readonly http: HttpClient;
  readonly secretKey: string;
  readonly baseUrl?: string;
  readonly apiVersion?: string;
  /** Porter's cut in basis points. 0 means none. */
  readonly applicationFeeBps?: number;
  /** Where the user completes bank authentication when one is demanded. */
  readonly returnUrl?: string;
}

const DEFAULT_BASE = "https://api.stripe.com";
const DEFAULT_API_VERSION = "2025-08-27.basil";

/**
 * Stripe gateway, using Connect destination charges.
 *
 * Porter is the merchant of record: the charge happens on Porter's account
 * and `transfer_data[destination]` moves the business's share immediately.
 * That fits a booking aggregator, where Porter handles the customer
 * relationship and the business does the work.
 *
 * Three things here are deliberate rather than incidental:
 *
 *  1. **Off-session.** An agent-initiated payment has nobody at a checkout
 *     page. `off_session: true` tells Stripe that, and
 *     `error_on_requires_action: true` makes it fail fast rather than sit in
 *     `requires_action` forever. The resulting `authentication_required`
 *     becomes a distinct Porter error the agent can act on.
 *  2. **Idempotency.** Stripe's own `Idempotency-Key` header, carrying the
 *     key Porter derived from the tool call, so the protection runs end to
 *     end rather than stopping at Porter's boundary.
 *  3. **No card data.** Porter sends saved references only. Entering card
 *     details is something Porter never does.
 */
export class StripeGateway implements PaymentGateway {
  readonly id = "stripe";
  readonly #http: HttpClient;
  readonly #secretKey: string;
  readonly #baseUrl: string;
  readonly #apiVersion: string;
  readonly #feeBps: number;
  readonly #returnUrl: string | undefined;

  constructor(options: StripeGatewayOptions) {
    if (!options.secretKey) throw new Error("Stripe secret key is required.");
    this.#http = options.http;
    this.#secretKey = options.secretKey;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
    this.#apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
    this.#feeBps = options.applicationFeeBps ?? 0;
    this.#returnUrl = options.returnUrl;
  }

  /** True when this gateway is pointed at test keys. */
  get isTestMode(): boolean {
    return this.#secretKey.startsWith("sk_test_") || this.#secretKey.startsWith("rk_test_");
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    const form: Record<string, string> = {
      amount: String(request.amount.amount),
      currency: request.amount.currency.toLowerCase(),
      customer: request.customerRef,
      payment_method: request.paymentMethodRef,
      confirm: "true",
      // Nobody is at a checkout page to answer a challenge.
      off_session: "true",
      error_on_requires_action: "true",
    };

    if (request.description) form.description = request.description.slice(0, 350);
    if (this.#returnUrl) form.return_url = this.#returnUrl;

    if (request.destinationAccountRef) {
      form["transfer_data[destination]"] = request.destinationAccountRef;
      // Funds are intended for the business, which puts their details on the
      // statement and settles fees against their account.
      form.on_behalf_of = request.destinationAccountRef;
      const fee = request.applicationFeeMinor ?? Math.floor((request.amount.amount * this.#feeBps) / 10_000);
      if (fee > 0) form.application_fee_amount = String(fee);
    }

    for (const [key, value] of Object.entries(request.metadata ?? {})) {
      form[`metadata[${key}]`] = value;
    }

    const response = await this.#post<StripePaymentIntent>("/v1/payment_intents", form, request.idempotencyKey);

    if ("error" in response) {
      const reason = mapFailureReason(response.error);
      // Stripe reports an off-session challenge as a card error, not a
      // separate status, so it is normalised back to requires_action here.
      if (reason === "authentication_required") {
        return {
          paymentId: response.error.payment_intent?.id ?? "unknown",
          status: "requires_action",
          amount: request.amount,
          reason,
        };
      }
      return { paymentId: response.error.payment_intent?.id ?? "unknown", status: "failed", amount: request.amount, reason };
    }

    return {
      paymentId: response.id,
      status: mapIntentStatus(response.status),
      amount: money(response.amount, response.currency.toUpperCase()),
      ...(response.next_action?.redirect_to_url?.url ? { actionUrl: response.next_action.redirect_to_url.url } : {}),
    };
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    const form: Record<string, string> = { payment_intent: request.paymentId };
    if (request.amount) form.amount = String(request.amount.amount);
    if (request.reason) form.reason = request.reason;

    const response = await this.#post<StripeRefund>("/v1/refunds", form, request.idempotencyKey);
    if ("error" in response) {
      throw new PorterError("PAYMENT_REQUIRED", "That refund did not go through.", {
        details: { gateway: this.id },
      });
    }

    const amount: Money = money(response.amount, response.currency.toUpperCase());
    return {
      refundId: response.id,
      status: response.status === "succeeded" ? "succeeded" : response.status === "failed" ? "failed" : "pending",
      amount,
    };
  }

  async #post<T>(path: string, form: Record<string, string>, idempotencyKey: string): Promise<T | { error: StripeError }> {
    let response;
    try {
      response = await this.#http.send({
        method: "POST",
        url: `${this.#baseUrl}${path}`,
        headers: {
          authorization: `Bearer ${this.#secretKey}`,
          "stripe-version": this.#apiVersion,
          // Stripe's own idempotency, carrying Porter's derived key.
          "idempotency-key": idempotencyKey.slice(0, 255),
          "content-type": "application/x-www-form-urlencoded",
        },
        // Stripe's API is form-encoded, not JSON.
        body: new URLSearchParams(form).toString(),
      });
    } catch (error) {
      if (PorterError.is(error)) throw error;
      throw new PorterError("PAYMENT_REQUIRED", "The payment system is not responding. Try again in a moment.", {
        details: { gateway: this.id },
        cause: error,
      });
    }

    const body = response.body as (T & { error?: StripeError }) | null;
    if (body && body.error) {
      // Separate the customer's problem from ours.
      //
      // A card error is something the user can act on: try another card.
      // A bad API key, a Stripe outage or a rate limit is an operational
      // fault on our side. Reporting those as a decline would tell the user
      // to fix their card when their card is fine, so they are thrown
      // instead and surface as a system error.
      if (body.error.type !== "card_error") {
        throw new PorterError("PAYMENT_REQUIRED", "The payment system is having a problem. Try again in a moment.", {
          details: { gateway: this.id, kind: "gateway_fault" },
        });
      }
      return { error: body.error };
    }

    if (response.status >= 400 || !body) {
      throw new PorterError("PAYMENT_REQUIRED", "The payment system rejected that request.", {
        details: { gateway: this.id },
      });
    }
    return body;
  }
}

function mapIntentStatus(status: StripePaymentIntent["status"]): ChargeStatus {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "requires_action":
    case "requires_confirmation":
    case "requires_payment_method":
      return "requires_action";
    case "processing":
      // Not settled yet, but not a failure either. Treated as pending money,
      // which for Porter's purposes means do not claim it succeeded.
      return "requires_action";
    case "canceled":
    default:
      return "failed";
  }
}

/**
 * Stripe error -> Porter's mapped reason.
 *
 * Stripe's own `message` is written for a developer, not a person, so it is
 * never passed through. The reason code drives the wording Porter uses.
 */
function mapFailureReason(error: StripeError): ChargeFailureReason {
  if (error.code === "authentication_required") return "authentication_required";
  if (error.decline_code === "insufficient_funds") return "insufficient_funds";
  if (error.code === "expired_card" || error.decline_code === "expired_card") return "expired_card";
  if (error.code === "card_declined" || error.type === "card_error") return "card_declined";
  if (error.code === "resource_missing") return "no_payment_method";
  return "gateway_error";
}

export function createStripeGateway(options: StripeGatewayOptions): StripeGateway {
  return new StripeGateway(options);
}
