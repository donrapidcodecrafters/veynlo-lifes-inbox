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
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeInitScript() }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
