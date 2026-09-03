"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { NAV_ITEMS } from "./nav-items";
import { NavIcon } from "./nav-icon";
import { cn } from "@/lib/cn";
import { useSession } from "@/hooks/use-session";

/**
 * Mobile: bottom tab bar, thumb-reachable. Desktop (md+): persistent left
 * rail with labels and more breathing room — not a stretched phone layout.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { user } = useSession();
  const t = useTranslations("nav");

  return (
    <div className="min-h-dvh bg-canvas md:flex">
      <aside className="hidden md:flex md:w-60 md:flex-col md:border-r md:border-border-subtle md:py-6">
        <div className="px-6 pb-8">
          <span className="text-lg font-semibold tracking-tight text-primary">Veynlo</span>
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-3">
          {NAV_ITEMS.map((item) => {
            const active = pathname?.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-[0.9375rem] font-medium transition-colors",
                  active ? "bg-brand-subtle text-brand-subtle-text" : "text-secondary hover:bg-subtle",
                )}
                aria-current={active ? "page" : undefined}
              >
                <NavIcon icon={item.icon} className="size-5 shrink-0" />
                {t(item.labelKey)}
              </Link>
            );
          })}
        </nav>
        {user && (
          <div className="mx-3 mt-4 rounded-lg bg-subtle px-3 py-2.5">
            <p className="truncate text-sm font-medium text-primary">{user.displayName}</p>
            <p className="truncate text-xs text-tertiary">{user.email}</p>
          </div>
        )}
      </aside>

      <div className="flex min-h-dvh flex-1 flex-col">
        <main className="flex-1 pb-20 md:pb-0">
          <div className="mx-auto w-full max-w-[var(--width-panel)] px-4 py-6 md:px-8 md:py-8">{children}</div>
        </main>
      </div>

      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-50 flex border-t border-border-subtle bg-surface/95 backdrop-blur md:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {NAV_ITEMS.map((item) => {
          const active = pathname?.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex flex-1 flex-col items-center gap-1 py-2.5 text-xs font-medium",
                active ? "text-brand" : "text-tertiary",
              )}
              aria-current={active ? "page" : undefined}
            >
              <NavIcon icon={item.icon} className="size-6" />
              {t(item.labelKey)}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
