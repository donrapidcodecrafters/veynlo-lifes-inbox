import { useEffect, type ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { resolveUiLocale, resolveFormattingLocale } from "@veynlo/core";
import i18n, { getDeviceLocale, setActiveFormattingLocale } from "./i18n";
import { useAuth } from "./auth-context";

/**
 * §38.2 "Internationalization" — see `lib/i18n/index.ts`'s doc comment for the overall design.
 * `lib/i18n/index.ts` already initializes i18next synchronously (device locale vs. English) so the
 * very first render has a resolved language; this provider's job is purely to react to the one thing
 * that can change it after launch: the signed-in user's stored `users.locale` preference (see
 * `auth-context.tsx`'s `SessionUser.locale`) loading in after the device-locale guess. Mirrors
 * apps/web's `src/i18n/provider.tsx` fallback chain: user preference > device locale > English.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();

  useEffect(() => {
    const deviceLocale = getDeviceLocale();
    const uiLocale = resolveUiLocale(user?.locale, deviceLocale);
    const formattingLocale = resolveFormattingLocale(user?.locale, deviceLocale);
    if (i18n.language !== uiLocale) void i18n.changeLanguage(uiLocale);
    setActiveFormattingLocale(formattingLocale);
  }, [user?.locale]);

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
