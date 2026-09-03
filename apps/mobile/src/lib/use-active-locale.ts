import { useSyncExternalStore } from "react";
import { getActiveFormattingLocale, subscribeActiveFormattingLocale } from "./i18n";

/**
 * §38.2 "Internationalization" — the resolved active formatting locale (see `lib/i18n/index.ts` and
 * `i18n-provider.tsx`) as reactive React state. A component that calls `lib/format.ts`'s Intl-based
 * date/money formatters needs to re-render when the signed-in user's `users.locale` preference loads
 * in after the initial device-locale guess, not only when its own data changes — `useSyncExternalStore`
 * is what makes that happen, since the underlying value lives outside React state (see that file's
 * own doc comment for why).
 */
export function useActiveFormattingLocale(): string {
  return useSyncExternalStore(subscribeActiveFormattingLocale, getActiveFormattingLocale, getActiveFormattingLocale);
}
