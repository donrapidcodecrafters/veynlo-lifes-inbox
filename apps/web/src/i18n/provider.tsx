"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { resolveUiLocale, resolveFormattingLocale, type SupportedUiLocale } from "@veynlo/core";
import { useSession } from "@/hooks/use-session";
import { loadMessages } from "./messages";

/**
 * §38.2 "Internationalization" client-side locale plumbing — see `@veynlo/core`'s `util/locale.ts`
 * for the full design rationale (why UI-language and Intl-formatting locale are resolved
 * separately, the fallback chain, and how to add a locale). This component is the one place that
 * turns that resolution into an actual `next-intl` context every `useTranslations()`/`useLocale()`
 * call site reads from.
 *
 * `initialUiLocale`/`initialFormattingLocale` come from the root layout's server-side guess (the
 * request's `Accept-Language` header) so a guest sees correctly-formatted numbers/dates on the very
 * first paint, before any client JS has run. Once mounted, this refines that guess using the
 * browser's own `navigator.language` (guest) and then — once the session loads — the signed-in
 * user's stored `users.locale` preference, which always wins when present.
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
  const { user } = useSession();
  const [browserLocale, setBrowserLocale] = useState<string | null>(null);

  useEffect(() => {
    // `navigator.language` isn't available during SSR — setting it post-mount only ever *refines*
    // the server's Accept-Language-derived guess, it never contradicts what was already rendered.
    setBrowserLocale(navigator.language ?? null);
  }, []);

  const uiLocale = useMemo(
    () => resolveUiLocale(user?.locale, browserLocale, initialUiLocale),
    [user?.locale, browserLocale, initialUiLocale],
  );
  const formattingLocale = useMemo(
    () => resolveFormattingLocale(user?.locale, browserLocale, initialFormattingLocale),
    [user?.locale, browserLocale, initialFormattingLocale],
  );
  const messages = useMemo(() => loadMessages(uiLocale), [uiLocale]);

  return (
    <NextIntlClientProvider locale={formattingLocale} messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}
