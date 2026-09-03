import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { headers } from "next/headers";
import { resolveUiLocale, resolveFormattingLocale } from "@veynlo/core";
import { LocaleProvider } from "@/i18n/provider";
import "@/styles/globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: {
    default: "Veynlo Admin",
    template: "%s · Veynlo Admin",
  },
  description: "Internal support console — metadata-only, audited access.",
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // §38.2 "Internationalization" — see src/i18n/provider.tsx's doc comment for why this console
  // only resolves device/browser locale (no per-admin preference exists to route through).
  const acceptLanguage = (await headers()).get("accept-language")?.split(",")[0]?.trim();
  const initialUiLocale = resolveUiLocale(acceptLanguage);
  const initialFormattingLocale = resolveFormattingLocale(acceptLanguage);
  return (
    <html lang={initialUiLocale} className={inter.variable}>
      <body>
        <LocaleProvider initialUiLocale={initialUiLocale} initialFormattingLocale={initialFormattingLocale}>
          {children}
        </LocaleProvider>
      </body>
    </html>
  );
}
