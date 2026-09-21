import type { HttpClient, HttpRequest, HttpResponse } from "@porter/shared";
import type { StripeError, StripePaymentIntent, StripeRefund } from "../types.js";

/**
 * A wire-level fake of Stripe.
 *
 * Form-encoded in, JSON out, with real `Idempotency-Key` replay and Stripe's
 * own error envelope. Same caveat as the provider fakes: shapes come from
 * Stripe's published reference, not recorded traffic. Stripe's API is very
 * well documented, so these are solid, but a test-mode smoke run against real
 * `sk_test_` keys is still the thing that proves it.
 */
export type FakeStripeOutcome =
  | { kind: "succeeded" }
  | { kind: "authentication_required" }
  | { kind: "declined"; declineCode?: string }
  | { kind: "insufficient_funds" }
  | { kind: "expired_card" }
  | { kind: "api_error" }
  | { kind: "processing" };

export interface FakeStripeOptions {
  readonly secretKey?: string;
  /** Outcome for the next charge, then the queue falls back to succeeded. */
  readonly outcomes?: readonly FakeStripeOutcome[];
}

export class FakeStripe implements HttpClient {
  readonly intents = new Map<string, StripePaymentIntent>();
  readonly refunds: StripeRefund[] = [];
  readonly requests: { path: string; form: Record<string, string>; idempotencyKey: string | undefined }[] = [];
  readonly #idempotency = new Map<string, unknown>();
  readonly #outcomes: FakeStripeOutcome[];
  readonly #secretKey: string;
  #counter = 0;

  constructor(options: FakeStripeOptions = {}) {
    this.#secretKey = options.secretKey ?? "sk_test_fake";
    this.#outcomes = [...(options.outcomes ?? [])];
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    const url = new URL(request.url);
    const auth = request.headers?.authorization ?? "";
    if (auth !== `Bearer ${this.#secretKey}`) {
      return json(401, { error: { type: "authentication_error", message: "Invalid API Key" } satisfies StripeError });
    }

    const form = Object.fromEntries(new URLSearchParams(String(request.body ?? "")));
    const idempotencyKey = request.headers?.["idempotency-key"];
    this.requests.push({ path: url.pathname, form, idempotencyKey });

    // Stripe replays the original response for a repeated key.
    if (idempotencyKey && this.#idempotency.has(idempotencyKey)) {
      return json(200, this.#idempotency.get(idempotencyKey));
    }

    let result: { status: number; body: unknown };
    if (url.pathname === "/v1/payment_intents") result = this.#createIntent(form);
    else if (url.pathname === "/v1/refunds") result = this.#createRefund(form);
    else result = { status: 404, body: { error: { type: "invalid_request_error", code: "resource_missing" } } };

    // Failed calls are not cached, so a retry can genuinely retry.
    if (idempotencyKey && result.status < 400) this.#idempotency.set(idempotencyKey, result.body);
    return json(result.status, result.body);
  }

  #createIntent(form: Record<string, string>): { status: number; body: unknown } {
    const id = `pi_${++this.#counter}`;
    const amount = Number(form.amount ?? 0);
    const currency = form.currency ?? "usd";
    const outcome = this.#outcomes.shift() ?? { kind: "succeeded" as const };

    switch (outcome.kind) {
      case "authentication_required":
        // Stripe reports an off-session challenge as a card error.
        return {
          status: 402,
          body: {
            error: {
              type: "card_error",
              code: "authentication_required",
              message: "The payment requires authentication.",
              payment_intent: { id, status: "requires_action" },
            } satisfies StripeError,
          },
        };
      case "declined":
        return {
          status: 402,
          body: {
            error: {
              type: "card_error",
              code: "card_declined",
              decline_code: outcome.declineCode ?? "generic_decline",
              message: "Your card was declined.",
              payment_intent: { id, status: "requires_payment_method" },
            } satisfies StripeError,
          },
        };
      case "insufficient_funds":
        return {
          status: 402,
          body: {
            error: { type: "card_error", code: "card_declined", decline_code: "insufficient_funds", message: "Insufficient funds.", payment_intent: { id } } satisfies StripeError,
          },
        };
      case "expired_card":
        return {
          status: 402,
          body: { error: { type: "card_error", code: "expired_card", message: "Card expired.", payment_intent: { id } } satisfies StripeError },
        };
      case "api_error":
        return { status: 500, body: { error: { type: "api_error", message: "Something went wrong." } satisfies StripeError } };
      case "processing":
      case "succeeded":
      default: {
        const intent: StripePaymentIntent = {
          id,
          object: "payment_intent",
          amount,
          currency,
          status: outcome.kind === "processing" ? "processing" : "succeeded",
          customer: form.customer ?? null,
          payment_method: form.payment_method ?? null,
          latest_charge: `ch_${this.#counter}`,
          livemode: false,
          ...(form["transfer_data[destination]"] ? { transfer_data: { destination: form["transfer_data[destination]"] } } : {}),
          ...(form.on_behalf_of ? { on_behalf_of: form.on_behalf_of } : {}),
          ...(form.application_fee_amount ? { application_fee_amount: Number(form.application_fee_amount) } : {}),
          metadata: Object.fromEntries(
            Object.entries(form)
              .filter(([k]) => k.startsWith("metadata["))
              .map(([k, v]) => [k.slice(9, -1), v]),
          ),
        };
        this.intents.set(id, intent);
        return { status: 200, body: intent };
      }
    }
  }

  #createRefund(form: Record<string, string>): { status: number; body: unknown } {
    const intentId = form.payment_intent;
    const intent = intentId ? this.intents.get(intentId) : undefined;
    if (!intent) {
      return { status: 404, body: { error: { type: "invalid_request_error", code: "resource_missing", param: "payment_intent" } satisfies StripeError } };
    }
    const refund: StripeRefund = {
      id: `re_${++this.#counter}`,
      object: "refund",
      amount: Number(form.amount ?? intent.amount),
      currency: intent.currency,
      status: "succeeded",
      payment_intent: intent.id,
    };
    this.refunds.push(refund);
    return { status: 200, body: refund };
  }
}

function json(status: number, body: unknown): HttpResponse {
  return { status, headers: { "content-type": "application/json" }, body };
}

export const STRIPE_TEST_KEY = "sk_test_fake";
