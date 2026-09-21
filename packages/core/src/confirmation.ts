import { formatMoney, sanitize, stableHash, type Clock, type Money } from "@porter/shared";
import type { Booking, CancellationPolicy } from "./domain.js";

/**
 * The confirmation envelope.
 *
 * Every mutating tool returns one of these *before* it commits. The first call
 * quotes and changes nothing; the second call passes `confirmationToken` and
 * commits. There is no single-call path that books, cancels with a fee, or
 * charges money.
 *
 * Two platform rules shape the fields:
 *
 *  - Muse Connector Policies, "Fail to disclose material terms before financial
 *    commitment": the user must see cost, frequency, cancellation terms and
 *    penalties. Hence `money`, `recurrence`, `cancellationPolicy` and
 *    `nonRefundable` are all mandatory.
 *
 *  - Terms section 7.2: Muse may paraphrase this content, and "incidental
 *    deviations will not constitute a breach". So the displayed text is never
 *    the record of what was agreed. The signed token is, and the commit step
 *    re-derives the terms hash and refuses if anything moved.
 */
export interface LineItem {
  readonly label: string;
  readonly amount: Money;
}

export type Recurrence =
  | { readonly kind: "one_off" }
  | { readonly kind: "recurring"; readonly everyDays: number; readonly endsAt: string | null };

export interface ConfirmationSummary {
  readonly provider: string;
  readonly service: string;
  readonly startsAt: string;
  readonly durationMinutes: number;
  readonly location?: string;
}

export interface ConfirmationMoney {
  readonly amount: number;
  readonly currency: string;
  readonly formatted: string;
  readonly kind: "total" | "deposit" | "fee" | "none";
  readonly breakdown: readonly { label: string; amount: number; formatted: string }[];
}

export interface ConfirmationPolicyView {
  readonly known: boolean;
  readonly freeUntil: string | null;
  readonly feeAmount: number | null;
  readonly feeFormatted: string | null;
  readonly text: string | null;
}

export interface ConfirmationEnvelope {
  readonly status: "confirmation_required";
  readonly action: "book" | "reschedule" | "cancel" | "pay";
  readonly summary: ConfirmationSummary;
  readonly money: ConfirmationMoney;
  readonly recurrence: Recurrence;
  readonly nonRefundable: boolean;
  readonly cancellationPolicy: ConfirmationPolicyView;
  /** Set when the amount crosses the configured material threshold. */
  readonly requiresExplicitApproval: boolean;
  readonly humanSummary: string;
  readonly confirmationToken: string;
  readonly expiresAt: string;
}

export interface BuildEnvelopeInput {
  readonly action: ConfirmationEnvelope["action"];
  readonly summary: ConfirmationSummary;
  readonly money: { readonly kind: ConfirmationMoney["kind"]; readonly total: Money | null; readonly breakdown: readonly LineItem[] };
  readonly recurrence?: Recurrence;
  readonly nonRefundable?: boolean;
  readonly cancellationPolicy: CancellationPolicy;
  readonly materialThreshold: Money;
}

/**
 * Canonical hash of the terms being confirmed.
 *
 * Derived from the machine-readable values only, never from prose, so a
 * reworded policy string does not invalidate a confirmation while a changed
 * price always does.
 */
export function termsHash(input: {
  action: string;
  providerId: string;
  serviceId: string;
  startsAtMs: number;
  amountMinor: number | null;
  currency: string | null;
  feeMinor: number | null;
  nonRefundable: boolean;
  recurrence: Recurrence;
}): string {
  return stableHash(input);
}

export function policyView(policy: CancellationPolicy): ConfirmationPolicyView {
  return {
    known: policy.known,
    freeUntil: policy.freeUntil ? policy.freeUntil.toISOString() : null,
    feeAmount: policy.feeAmount ? policy.feeAmount.amount : null,
    feeFormatted: policy.feeAmount ? formatMoney(policy.feeAmount) : null,
    text: policy.text ? sanitize(policy.text, { maxLength: 300, label: "cancellation policy" }) : null,
  };
}

export function buildEnvelope(
  input: BuildEnvelopeInput,
  confirmationToken: string,
  expiresAt: Date,
): ConfirmationEnvelope {
  const { total } = input.money;
  const recurrence: Recurrence = input.recurrence ?? { kind: "one_off" };
  const policy = policyView(input.cancellationPolicy);

  const money: ConfirmationMoney = {
    amount: total?.amount ?? 0,
    currency: total?.currency ?? input.materialThreshold.currency,
    formatted: total ? formatMoney(total) : "no charge now",
    kind: input.money.kind,
    breakdown: input.money.breakdown.map((li) => ({
      label: li.label,
      amount: li.amount.amount,
      formatted: formatMoney(li.amount),
    })),
  };

  const requiresExplicitApproval =
    total !== null &&
    total.currency === input.materialThreshold.currency &&
    total.amount >= input.materialThreshold.amount;

  return {
    status: "confirmation_required",
    action: input.action,
    summary: input.summary,
    money,
    recurrence,
    nonRefundable: input.nonRefundable ?? false,
    cancellationPolicy: policy,
    requiresExplicitApproval,
    humanSummary: humanSummary(input.action, input.summary, money, recurrence, policy, input.nonRefundable ?? false),
    confirmationToken,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * A short prose summary for the agent to read out.
 *
 * Kept deliberately terse and front-loaded with the numbers, because section
 * 7.2 lets the agent paraphrase it. The structured fields above remain the
 * authority; this is a convenience, not the contract.
 */
function humanSummary(
  action: ConfirmationEnvelope["action"],
  summary: ConfirmationSummary,
  money: ConfirmationMoney,
  recurrence: Recurrence,
  policy: ConfirmationPolicyView,
  nonRefundable: boolean,
): string {
  const when = new Date(summary.startsAt).toUTCString();
  const parts: string[] = [];

  switch (action) {
    case "book":
      parts.push(`Book ${summary.service} at ${summary.provider} on ${when}.`);
      break;
    case "reschedule":
      parts.push(`Move ${summary.service} at ${summary.provider} to ${when}.`);
      break;
    case "cancel":
      parts.push(`Cancel ${summary.service} at ${summary.provider} on ${when}.`);
      break;
    case "pay":
      parts.push(`Pay for ${summary.service} at ${summary.provider}.`);
      break;
  }

  parts.push(money.kind === "none" ? "No charge now." : `${labelFor(money.kind)}: ${money.formatted}.`);
  if (recurrence.kind === "recurring") {
    parts.push(`Repeats every ${recurrence.everyDays} days${recurrence.endsAt ? ` until ${recurrence.endsAt}` : ""}.`);
  }
  if (nonRefundable) parts.push("This charge is non-refundable.");

  if (!policy.known) {
    parts.push("Cancellation policy: not published by this business.");
  } else if (policy.feeFormatted) {
    parts.push(
      policy.freeUntil
        ? `Free to cancel until ${new Date(policy.freeUntil).toUTCString()}, then ${policy.feeFormatted}.`
        : `Cancellation fee: ${policy.feeFormatted}.`,
    );
  } else {
    parts.push("Free to cancel.");
  }

  return parts.join(" ");
}

function labelFor(kind: ConfirmationMoney["kind"]): string {
  switch (kind) {
    case "deposit":
      return "Deposit";
    case "fee":
      return "Fee";
    case "total":
      return "Total";
    default:
      return "Amount";
  }
}

export function confirmationExpiry(clock: Clock, ttlMs = 10 * 60_000): Date {
  return new Date(clock.nowMs() + ttlMs);
}
