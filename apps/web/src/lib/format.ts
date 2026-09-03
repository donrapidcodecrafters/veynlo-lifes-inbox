export interface TemporalValueLike {
  precision: "instant" | "date" | "month" | "approximate" | "unknown";
  instantUtc: string | null;
  date: string | null;
  timezone: string | null;
  sourceText: string | null;
}

/**
 * PERS-004 "Naming and language" — "week start, time format." `timeFormat` is optional and defaults to
 * `undefined` (the browser/OS locale's own AM/PM-vs-24h convention, this function's original behavior)
 * so every existing call site that doesn't pass one is unaffected; a caller that has the user's stored
 * `personalizationPreferences.timeFormat` (see `usePersonalizationPreferences`) can pass it through to
 * make the 12h/24h choice an explicit user preference instead of an unconfigurable locale guess.
 *
 * §38.2 "Dates/times: locale-format display" — `locale` is likewise optional and defaults to
 * `undefined` (system/browser default, same backward-compatible convention). A caller with the
 * resolved active locale (`useLocale()` from `next-intl`, itself sourced from the signed-in user's
 * `users.locale` preference — see `@veynlo/core`'s `util/locale.ts` and `src/i18n/provider.tsx`) can
 * pass it through so date formatting reflects that preference instead of only ever the browser's.
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

/** Same `timeFormat`/`locale` convention as `formatTemporal` above, for a plain JS `Date` (e.g. a
 * denormalized `*Sort` column) rather than a `TemporalValue`. */
export function formatTimeOfDay(date: Date, timeFormat?: "12h" | "24h", locale?: string): string {
  const hour12 = timeFormat === "24h" ? false : timeFormat === "12h" ? true : undefined;
  return date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit", hour12 });
}

/** §38.2 "Currency: store amount + ISO currency" — `locale` defaults to `undefined` (system/browser
 * default) for backward compatibility; pass the resolved active locale (see `formatTemporal` above)
 * to format the same amount/currency according to the user's own locale preference instead. */
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
