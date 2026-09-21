import { PorterError } from "./errors.js";

/** Money is minor units plus a currency. Never a float. */
export interface Money {
  readonly amount: number; // minor units, e.g. cents
  readonly currency: string; // ISO 4217, uppercase
}

export const money = (amount: number, currency = "USD"): Money => {
  if (!Number.isInteger(amount)) {
    throw new PorterError("INVALID_REQUEST", "Amounts must be whole minor units.");
  }
  return { amount, currency: currency.toUpperCase() };
};

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount: a.amount + b.amount, currency: a.currency };
}

export function sumMoney(items: readonly Money[], currency = "USD"): Money {
  if (items.length === 0) return money(0, currency);
  return items.reduce((acc, m) => addMoney(acc, m));
}

export function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new PorterError("INVALID_REQUEST", "Cannot combine amounts in different currencies.", {
      details: { currencies: [a.currency, b.currency] },
    });
  }
}

/** Human-readable form for confirmation summaries. */
export function formatMoney(m: Money): string {
  const major = (m.amount / 100).toFixed(2);
  return m.currency === "USD" ? `$${major}` : `${major} ${m.currency}`;
}
