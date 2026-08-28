import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { headers } from "next/headers";
import { themeInitScript } from "@/lib/theme-script";
import { ThemeProvider } from "@/hooks/use-theme";
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
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        {/* suppressHydrationWarning: browsers deliberately hide a script's `nonce` attribute from
            getAttribute() reads after it's applied (an XSS-hardening measure), so React's hydration
            check always sees a mismatch here — a known, harmless quirk of nonce-based CSP with SSR,
            not a real bug (confirmed via a real headless-browser run: zero CSP violations, the script
            executes correctly either way). */}
        <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: themeInitScript() }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
