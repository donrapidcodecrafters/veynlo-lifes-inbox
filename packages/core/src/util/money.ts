import { z } from "zod";
import { DEFAULT_FORMATTING_LOCALE } from "./locale";

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

/** §38.2 "Currency" — `locale` defaults to `DEFAULT_FORMATTING_LOCALE`, not a hardcoded literal,
 * so a caller with a resolved active locale (see `util/locale.ts`) can pass it through. */
export function formatMoney(value: Money, locale: string = DEFAULT_FORMATTING_LOCALE): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: value.currency,
    currencyDisplay: "symbol",
  }).format(value.minorUnits / 100);
}

/**
 * FIN-007 "Financial privacy mode ... amounts and account names to be hidden." One shared placeholder so
 * every surface that masks a dollar amount (web/mobile Home, `NotificationDispatchService`'s brief copy,
 * `WidgetsService`'s projections) renders the exact same string rather than each inventing its own — a
 * literal "$•,•••.••" would misleadingly imply a real digit count, so this is a plain, length-independent
 * placeholder instead.
 */
export const MASKED_AMOUNT_PLACEHOLDER = "••••";

/** Redacts any dollar-amount-shaped substring (e.g. "$1,234.56", "$50") out of free text — used for
 * server-composed copy (attention-item reasonText embedded into daily-brief bodies) where there's no
 * single Money value to swap for MASKED_AMOUNT_PLACEHOLDER, only prose that already has one baked in. */
export function redactDollarAmounts(text: string): string {
  return text.replace(/\$\d[\d,]*(?:\.\d{2})?/g, MASKED_AMOUNT_PLACEHOLDER);
}
