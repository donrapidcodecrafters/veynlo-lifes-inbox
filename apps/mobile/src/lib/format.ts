export interface TemporalValueLike {
  precision: "instant" | "date" | "month" | "approximate" | "unknown";
  instantUtc: string | null;
  date: string | null;
  timezone: string | null;
  sourceText: string | null;
}

/**
 * PERS-004 "Naming and language" — "week start, time format." Mirrors apps/web's identical addition:
 * `timeFormat` is optional and defaults to `undefined` (the OS locale's own AM/PM-vs-24h convention, this
 * function's original behavior), so an existing call site that doesn't pass one is unaffected.
 *
 * §38.2 "Dates/times: locale-format display" — `locale` is likewise optional and defaults to
 * `undefined` (device default). A caller with the resolved active locale (`useActiveFormattingLocale()`
 * — see `lib/use-active-locale.ts`, itself sourced from the signed-in user's `users.locale`
 * preference via `lib/i18n-provider.tsx`) can pass it through instead.
 */
export function formatTemporal(value: TemporalValueLike | null | undefined, timeFormat?: "12h" | "24h", locale?: string): string | null {
  if (!value) return null;
  const hour12 = timeFormat === "24h" ? false : timeFormat === "12h" ? true : undefined;
  if (value.precision === "instant" && value.instantUtc) {
    return new Date(value.instantUtc).toLocaleString(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12 });
  }
  if (value.precision === "date" && value.date) {
    return new Date(`${value.date}T00:00:00`).toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" });
  }
  if (value.precision === "approximate" && value.sourceText) return value.sourceText;
  return null;
}

/** §38.2 "Currency: store amount + ISO currency" — `locale` defaults to `undefined` (device default)
 * for backward compatibility; pass the resolved active locale (see `formatTemporal` above) to format
 * according to the user's own locale preference instead. */
export function formatMoneyMinorUnits(minorUnits: number | null | undefined, currency: string | null | undefined, locale?: string): string | null {
  if (minorUnits == null || !currency) return null;
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(minorUnits / 100);
}

export function daysUntil(value: TemporalValueLike | null | undefined): number | null {
  if (!value) return null;
  const target = value.instantUtc ?? (value.date ? `${value.date}T00:00:00` : null);
  if (!target) return null;
  const diffMs = new Date(target).getTime() - Date.now();
  return Math.ceil(diffMs / 86_400_000);
}
