import { z } from "zod";

/**
 * Money is always represented in integer minor units (e.g. cents) plus an
 * ISO 4217 currency code. Never use floating point for financial values
 * (spec "MONEY" section). Helpers below are the only sanctioned way to do
 * arithmetic on Money values so rounding/currency-mismatch bugs surface at
 * one chokepoint.
 */
export const MoneySchema = z.object({
  minorUnits: z.number().int(),
  currency: z.string().length(3),
});
export type Money = z.infer<typeof MoneySchema>;

export function money(amount: number, currency = "USD"): Money {
  return { minorUnits: Math.round(amount * 100), currency };
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new Error(`Cannot add mismatched currencies: ${a.currency} vs ${b.currency}`);
  }
  return { minorUnits: a.minorUnits + b.minorUnits, currency: a.currency };
}

export function subtractMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new Error(`Cannot subtract mismatched currencies: ${a.currency} vs ${b.currency}`);
  }
  return { minorUnits: a.minorUnits - b.minorUnits, currency: a.currency };
}

export function formatMoney(value: Money, locale = "en-US"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: value.currency,
    currencyDisplay: "symbol",
  }).format(value.minorUnits / 100);
}
