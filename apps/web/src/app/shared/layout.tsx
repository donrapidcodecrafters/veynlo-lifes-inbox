import type { Metadata } from "next";

/**
 * `/shared/[token]` pages are long-lived bearer-token URLs — a leaked link (forwarded, screenshotted,
 * pasted somewhere public) must never end up indexed or re-crawled. The page itself is a client component
 * (`"use client"`, see page.tsx) and can't export metadata directly, so this server-component layout
 * carries it instead. Belt-and-suspenders with robots.ts's explicit /shared/ disallow — this is the half
 * that still holds even against a crawler that ignores robots.txt outright.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

export default function SharedLayout({ children }: { children: React.ReactNode }) {
  return children;
}
