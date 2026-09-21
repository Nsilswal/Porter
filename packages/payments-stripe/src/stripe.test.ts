import { describe, expect, it } from "vitest";
import { PorterError, money } from "@porter/shared";
import { createStripeGateway } from "./index.js";
import { FakeStripe, STRIPE_TEST_KEY, type FakeStripeOutcome } from "./testing/fake-stripe.js";

function build(outcomes: FakeStripeOutcome[] = [], options: { feeBps?: number } = {}) {
  const fake = new FakeStripe({ outcomes });
  const gateway = createStripeGateway({
    http: fake,
    secretKey: STRIPE_TEST_KEY,
    baseUrl: "https://api.stripe.test",
    applicationFeeBps: options.feeBps ?? 0,
  });
  return { fake, gateway };
}

const baseCharge = {
  userId: "user_1",
  bookingId: "bk_1",
  amount: money(12000),
  kind: "total" as const,
  idempotencyKey: "idem-1",
  customerRef: "cus_1",
  paymentMethodRef: "pm_1",
};

describe("stripe gateway — request shape", () => {
  it("confirms off-session and fails fast rather than hanging on a challenge", async () => {
    const { fake, gateway } = build();
    await gateway.charge(baseCharge);

    const form = fake.requests[0]!.form;
    expect(form.confirm).toBe("true");
    // Nobody is at a checkout page to answer a 3-D Secure prompt.
    expect(form.off_session).toBe("true");
    expect(form.error_on_requires_action).toBe("true");
    expect(form.amount).toBe("12000");
    expect(form.currency).toBe("usd");
    expect(form.customer).toBe("cus_1");
    expect(form.payment_method).toBe("pm_1");
  });

  it("sends Porter's idempotency key as Stripe's own", async () => {
    const { fake, gateway } = build();
    await gateway.charge(baseCharge);
    expect(fake.requests[0]!.idempotencyKey).toBe("idem-1");
  });

  it("replays rather than double-charging on a repeated key", async () => {
    const { fake, gateway } = build();
    const first = await gateway.charge(baseCharge);
    const second = await gateway.charge(baseCharge);
    expect(second.paymentId).toBe(first.paymentId);
    // One PaymentIntent, even though two calls were made.
    expect(fake.intents.size).toBe(1);
  });

  it("builds a Connect destination charge when the business is known", async () => {
    const { fake, gateway } = build([], { feeBps: 500 });
    await gateway.charge({ ...baseCharge, destinationAccountRef: "acct_biz_1" });

    const form = fake.requests[0]!.form;
    expect(form["transfer_data[destination]"]).toBe("acct_biz_1");
    expect(form.on_behalf_of).toBe("acct_biz_1");
    // 5% of 12000.
    expect(form.application_fee_amount).toBe("600");
  });

  it("takes no application fee when there is no destination", async () => {
    const { fake, gateway } = build([], { feeBps: 500 });
    await gateway.charge(baseCharge);
    expect(fake.requests[0]!.form.application_fee_amount).toBeUndefined();
    expect(fake.requests[0]!.form["transfer_data[destination]"]).toBeUndefined();
  });

  it("passes only non-identifying metadata", async () => {
    const { fake, gateway } = build();
    await gateway.charge({ ...baseCharge, metadata: { booking_id: "bk_1", adapter: "mock", kind: "total" } });
    const form = fake.requests[0]!.form;
    expect(form["metadata[booking_id]"]).toBe("bk_1");
    // Anyone with dashboard access can read metadata, so nothing personal.
    expect(JSON.stringify(form)).not.toMatch(/@|\+?\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/);
  });

  it("form-encodes the body, as Stripe's API requires", async () => {
    const { fake, gateway } = build();
    await gateway.charge(baseCharge);
    // The fake parses with URLSearchParams, so a JSON body would come back empty.
    expect(Object.keys(fake.requests[0]!.form).length).toBeGreaterThan(5);
  });
});

describe("stripe gateway — outcomes", () => {
  it("reports success", async () => {
    const { gateway } = build();
    const result = await gateway.charge(baseCharge);
    expect(result.status).toBe("succeeded");
    expect(result.amount.amount).toBe(12000);
    expect(result.paymentId).toMatch(/^pi_/);
  });

  it("normalises an off-session challenge back to requires_action", async () => {
    // Stripe reports this as a card error, not as a status. It is the single
    // most important failure for an agent: nobody can answer the challenge.
    const { gateway } = build([{ kind: "authentication_required" }]);
    const result = await gateway.charge(baseCharge);
    expect(result.status).toBe("requires_action");
    expect(result.reason).toBe("authentication_required");
  });

  it("maps decline reasons to something a person can act on", async () => {
    const cases: [FakeStripeOutcome, string][] = [
      [{ kind: "insufficient_funds" }, "insufficient_funds"],
      [{ kind: "expired_card" }, "expired_card"],
      [{ kind: "declined" }, "card_declined"],
    ];
    for (const [outcome, expected] of cases) {
      const { gateway } = build([outcome]);
      const result = await gateway.charge(baseCharge);
      expect(result.status).toBe("failed");
      expect(result.reason).toBe(expected);
    }
  });

  it("raises a system error for our own faults, not a decline", async () => {
    // A Stripe outage or a bad key is not the cardholder's problem. Telling
    // them to try another card would send them down the wrong path.
    for (const outcome of [{ kind: "api_error" as const }]) {
      const { gateway } = build([outcome]);
      await expect(gateway.charge(baseCharge)).rejects.toSatisfy(
        (e: unknown) => PorterError.is(e) && (e.details as any).kind === "gateway_fault",
      );
    }
  });

  it("does not treat a processing payment as collected", async () => {
    const { gateway } = build([{ kind: "processing" }]);
    const result = await gateway.charge(baseCharge);
    // Money is in flight, not settled. Claiming success here would be wrong.
    expect(result.status).not.toBe("succeeded");
  });

  it("never repeats Stripe's developer-facing message", async () => {
    const { gateway } = build([{ kind: "declined" }]);
    const result = await gateway.charge(baseCharge);
    expect(JSON.stringify(result)).not.toContain("Your card was declined");
  });

  it("raises a system error on a bad API key, not a decline", async () => {
    const fake = new FakeStripe();
    const gateway = createStripeGateway({ http: fake, secretKey: "sk_test_wrong", baseUrl: "https://api.stripe.test" });
    await expect(gateway.charge(baseCharge)).rejects.toSatisfy(
      (e: unknown) => PorterError.is(e) && (e.details as any).kind === "gateway_fault",
    );
  });
});

describe("stripe gateway — refunds", () => {
  it("refunds a payment it made", async () => {
    const { gateway } = build();
    const charge = await gateway.charge(baseCharge);
    const refund = await gateway.refund({ paymentId: charge.paymentId, amount: money(12000), idempotencyKey: "r-1", reason: "requested_by_customer" });
    expect(refund.status).toBe("succeeded");
    expect(refund.amount.amount).toBe(12000);
  });

  it("errors on an unknown payment rather than reporting success", async () => {
    const { gateway } = build();
    await expect(gateway.refund({ paymentId: "pi_nope", idempotencyKey: "r-2" })).rejects.toSatisfy((e: unknown) => PorterError.is(e));
  });
});

describe("stripe gateway — test mode", () => {
  it("knows whether it is pointed at test keys", () => {
    const fake = new FakeStripe();
    expect(createStripeGateway({ http: fake, secretKey: "sk_test_abc" }).isTestMode).toBe(true);
    expect(createStripeGateway({ http: fake, secretKey: "sk_live_abc" }).isTestMode).toBe(false);
  });

  it("refuses to build without a key", () => {
    const fake = new FakeStripe();
    expect(() => createStripeGateway({ http: fake, secretKey: "" })).toThrow();
  });
});
