import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { headers } from "next/headers";
import { resolveUiLocale, resolveFormattingLocale } from "@veynlo/core";
import { themeInitScript } from "@/lib/theme-script";
import { ThemeProvider } from "@/hooks/use-theme";
import { LocaleProvider } from "@/i18n/provider";
import "@/styles/globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: {
    default: "Veynlo",
    template: "%s · Veynlo",
  },
  description: "Veynlo is the connective intelligence layer across your permitted digital life.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8f8fb" },
    { media: "(prefers-color-scheme: dark)", color: "#0e0f14" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Set by middleware.ts on every request — required so this app-authored inline script (unlike Next's
  // own internally-generated RSC-hydration scripts, which get nonced automatically) passes the CSP.
  const headerList = await headers();
  const nonce = headerList.get("x-nonce") ?? undefined;
  // §38.2 "Internationalization" — best guess available before any client JS runs (guest/pre-auth,
  // or before the session's `users.locale` preference has loaded). LocaleProvider below refines this
  // client-side using the browser's own locale and, once signed in, the user's stored preference —
  // see that component and @veynlo/core's util/locale.ts for the full fallback chain.
  const acceptLanguage = headerList.get("accept-language")?.split(",")[0]?.trim();
  const initialUiLocale = resolveUiLocale(acceptLanguage);
  const initialFormattingLocale = resolveFormattingLocale(acceptLanguage);
  return (
    <html lang={initialUiLocale} className={inter.variable} suppressHydrationWarning>
      <head>
        {/* suppressHydrationWarning: browsers deliberately hide a script's `nonce` attribute from
            getAttribute() reads after it's applied (an XSS-hardening measure), so React's hydration
            check always sees a mismatch here — a known, harmless quirk of nonce-based CSP with SSR,
            not a real bug (confirmed via a real headless-browser run: zero CSP violations, the script
            executes correctly either way). */}
        <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: themeInitScript() }} />
      </head>
      <body>
        <LocaleProvider initialUiLocale={initialUiLocale} initialFormattingLocale={initialFormattingLocale}>
          <ThemeProvider>{children}</ThemeProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}
