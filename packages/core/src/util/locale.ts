/**
 * §38.2 "Internationalization" — canonical locale-resolution rules shared by every client
 * (`apps/web`, `apps/admin`, `apps/mobile`). This is the ONE place that decides which shipped
 * translation bundle a screen renders and which BCP-47 tag drives `Intl` number/date/currency
 * formatting — every app-specific i18n provider (next-intl for web/admin, i18next for mobile)
 * calls into these two functions rather than re-implementing the fallback chain per platform.
 *
 * ## The gap this closes
 * Before this module existed, no i18n library was wired up anywhere in this codebase and every
 * UI string was a hardcoded English literal, even though `users.locale` (packages/db/src/schema/
 * identity.ts) has been stored per-user since the very first migration. This is the architecture
 * §53.1 demands ("a future domain/capability should be addable ... without changing foundations")
 * applied to language: with this plumbing in place, shipping a second locale is "add a translated
 * JSON file and one entry in `SUPPORTED_UI_LOCALES`," not a re-architecture.
 *
 * ## Two different questions, two different answers
 * "What language is the UI?" and "How should this number/date look?" are NOT the same question —
 * a UK-based English speaker (`en-GB`) reads the same English copy as a US one (`en-US`), but
 * expects `£`, DD/MM dates, and different thousands grouping. So:
 *   - `resolveUiLocale()` collapses any BCP-47 tag down to one of the message bundles this app
 *     actually ships (today: only `"en"`) — this picks WHICH JSON file of translated strings to
 *     load.
 *   - `resolveFormattingLocale()` keeps the full regional tag (e.g. `"en-GB"`) and only rejects it
 *     if `Intl` itself can't parse it — this is what gets passed straight to `Intl.NumberFormat` /
 *     `Intl.DateTimeFormat` so currency symbols, date order, and digit grouping stay regionally
 *     correct even before a translated bundle for that language exists.
 *
 * ## Fallback chain (both functions), per §38.2 "Locale":
 *   1. The signed-in user's stored `users.locale` preference (once a session is loaded).
 *   2. The device/browser locale (guest/pre-auth screens, or before the session loads).
 *   3. `DEFAULT_UI_LOCALE` / `DEFAULT_FORMATTING_LOCALE` (English / en-US).
 * Callers pass candidates most-preferred-first, e.g. `resolveUiLocale(user?.locale, browserLocale)`.
 *
 * ## Adding a new locale (once real translations exist — see the deferred-work note below)
 *   1. Add the shipped bundle's base language tag to `SUPPORTED_UI_LOCALES` below.
 *   2. Add the matching `messages/<locale>.json` file to each app (mirrors `messages/en.json`'s
 *      keys exactly) and register it in that app's message loader.
 *   3. Nothing else changes: the fallback chain, the provider wiring, and every `t("...")` call
 *      site keep working unmodified — a user whose `users.locale` now resolves to the new locale
 *      picks it up automatically.
 *
 * ## What this pass deliberately did NOT do
 * Real translation into any non-English language requires either a paid translation vendor or
 * substantial human review to be trustworthy — machine-translating UI copy and shipping it
 * unreviewed would be worse than not translating at all (silently wrong dates/legal/financial
 * copy in a life-admin app). `SUPPORTED_UI_LOCALES` therefore intentionally lists only `"en"`
 * today. That's a deferred, cost-gated follow-up, not a gap in this architecture.
 */

/** Every locale this app currently ships a translated message bundle for. English-only today —
 * see this file's own header comment for why, and "Adding a new locale" for how to extend it. */
export const SUPPORTED_UI_LOCALES = ["en"] as const;
export type SupportedUiLocale = (typeof SUPPORTED_UI_LOCALES)[number];

export const DEFAULT_UI_LOCALE: SupportedUiLocale = "en";

/** Used when no candidate locale (user preference, device/browser) is present or parseable —
 * matches `users.locale`'s own column default (packages/db/src/schema/identity.ts). */
export const DEFAULT_FORMATTING_LOCALE = "en-US";

/**
 * Resolves which shipped message bundle to render, given locale candidates in preference order
 * (typically `[user?.locale, deviceLocale]`). A candidate is matched on its base language subtag
 * (`"en-GB"` -> `"en"`) so a regional variant of a supported language still finds its bundle.
 * Falls back to `DEFAULT_UI_LOCALE` when nothing matches — including every candidate being
 * null/undefined/empty, or naming a language not yet translated.
 */
export function resolveUiLocale(...candidates: Array<string | null | undefined>): SupportedUiLocale {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const base = candidate.toLowerCase().split(/[-_]/)[0];
    const match = (SUPPORTED_UI_LOCALES as readonly string[]).find((locale) => locale === base);
    if (match) return match as SupportedUiLocale;
  }
  return DEFAULT_UI_LOCALE;
}

/**
 * Resolves the full BCP-47 tag to hand `Intl.NumberFormat`/`Intl.DateTimeFormat`, given locale
 * candidates in preference order. Unlike `resolveUiLocale`, this keeps regional precision (e.g.
 * `"en-GB"` stays `"en-GB"`, it does not collapse to `"en"`) since `Intl` needs the full tag to
 * pick the right currency symbol/date order/grouping — those differ by region even when the UI
 * language is the same. Falls back to `DEFAULT_FORMATTING_LOCALE` when nothing matches, including
 * a candidate `Intl` itself rejects as malformed.
 */
export function resolveFormattingLocale(...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      // Throws a RangeError on a genuinely malformed tag rather than silently handing garbage to
      // Intl.NumberFormat/DateTimeFormat below, which would throw at format time instead.
      Intl.getCanonicalLocales(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return DEFAULT_FORMATTING_LOCALE;
}
