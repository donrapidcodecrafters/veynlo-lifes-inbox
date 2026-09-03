"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { resolveUiLocale, resolveFormattingLocale, type SupportedUiLocale } from "@veynlo/core";
import { loadMessages } from "./messages";

/**
 * §38.2 "Internationalization" — admin-console counterpart to apps/web's `src/i18n/provider.tsx`
 * (see that file and `@veynlo/core`'s `util/locale.ts` for the full design rationale).
 *
 * One deliberate difference from apps/web: there is no per-*admin* locale preference to route
 * through here. `admins` (services/api's operator accounts, distinct from the `users` table §38.2
 * actually targets) has no stored locale column — this console is used by a small number of
 * internal support/superadmin staff, not the consumer-facing `users.locale` preference this pass
 * was scoped to wire up. This provider therefore only resolves device/browser locale (via the
 * request's `Accept-Language` header, refined by `navigator.language` once mounted) against
 * English, falling back to English by default. Adding a real per-admin locale preference later is a
 * schema + this provider's fallback-chain change, not a re-architecture — the same message-bundle
 * loading and `NextIntlClientProvider` wiring below is unaffected either way.
 */
export function LocaleProvider({
  initialUiLocale,
  initialFormattingLocale,
  children,
}: {
  initialUiLocale: SupportedUiLocale;
  initialFormattingLocale: string;
  children: ReactNode;
}) {
  const [browserLocale, setBrowserLocale] = useState<string | null>(null);

  useEffect(() => {
    setBrowserLocale(navigator.language ?? null);
  }, []);

  const uiLocale = useMemo(() => resolveUiLocale(browserLocale, initialUiLocale), [browserLocale, initialUiLocale]);
  const formattingLocale = useMemo(
    () => resolveFormattingLocale(browserLocale, initialFormattingLocale),
    [browserLocale, initialFormattingLocale],
  );
  const messages = useMemo(() => loadMessages(uiLocale), [uiLocale]);

  return (
    <NextIntlClientProvider locale={formattingLocale} messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}
