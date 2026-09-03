/**
 * §38.2 "Internationalization" — mobile counterpart to apps/web's `src/i18n/` (see that app's
 * `provider.tsx` and `@veynlo/core`'s `util/locale.ts` for the full design rationale: this repo's
 * canonical locale-resolution rules, shared by every client). This file is the i18next equivalent
 * of apps/web's `messages/index.ts` + provider setup, adapted to Expo/React Native's `react-i18next`
 * rather than `next-intl`.
 *
 * Device locale detection deliberately reuses `Intl.DateTimeFormat().resolvedOptions().locale`
 * (Hermes ships a real `Intl` implementation on this RN version) instead of adding a native module
 * like `expo-localization` — this app already relies on `Intl` for the same purpose elsewhere (see
 * `auth-context.tsx`'s sign-up `timezone` detection, and `lib/format.ts`), so this stays consistent
 * with that existing pattern without a new native dependency/prebuild step.
 *
 * See i18n-provider.tsx for how the active language actually gets set (device locale for guests,
 * the signed-in user's stored `users.locale` preference once a session loads).
 */
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { resolveUiLocale, resolveFormattingLocale, DEFAULT_UI_LOCALE, type SupportedUiLocale } from "@veynlo/core";
import en from "./en.json";

/** One entry per `SUPPORTED_UI_LOCALES` value — mirrors apps/web's `MESSAGES_BY_LOCALE`. Adding a
 * locale: drop a `<locale>.json` file next to `en.json` with the same keys and add it here; nothing
 * else in this module or `i18n-provider.tsx` changes. */
const RESOURCES: Record<SupportedUiLocale, { translation: typeof en }> = {
  en: { translation: en },
};

export function getDeviceLocale(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale ?? null;
  } catch {
    return null;
  }
}

const deviceLocale = getDeviceLocale();

void i18n.use(initReactI18next).init({
  resources: RESOURCES,
  lng: resolveUiLocale(deviceLocale),
  fallbackLng: DEFAULT_UI_LOCALE,
  interpolation: { escapeValue: false }, // React already escapes — see i18next's own React guidance.
  returnNull: false,
});

/**
 * The BCP-47 tag actually handed to `Intl.NumberFormat`/`DateTimeFormat` (see `lib/format.ts`) —
 * kept separately from `i18n.language` (which only ever holds a shipped UI bundle, e.g. `"en"`) so
 * regional formatting (currency symbol, date order) stays precise even when the UI language bundle
 * doesn't need to change. A minimal external store (module state + subscriber list) rather than a
 * plain variable, so `useActiveFormattingLocale()` (see `lib/use-active-locale.ts`) can re-render
 * components when `i18n-provider.tsx` updates this after the signed-in user's `users.locale`
 * preference loads — a plain mutable variable wouldn't notify anything already on screen.
 */
let activeFormattingLocale = resolveFormattingLocale(deviceLocale);
const formattingLocaleListeners = new Set<() => void>();

export function getActiveFormattingLocale(): string {
  return activeFormattingLocale;
}

export function setActiveFormattingLocale(locale: string): void {
  if (locale === activeFormattingLocale) return;
  activeFormattingLocale = locale;
  formattingLocaleListeners.forEach((listener) => listener());
}

export function subscribeActiveFormattingLocale(listener: () => void): () => void {
  formattingLocaleListeners.add(listener);
  return () => formattingLocaleListeners.delete(listener);
}

export default i18n;
