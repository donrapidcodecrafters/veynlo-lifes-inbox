"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { NAV_ITEMS } from "./nav-items";
import { NavIcon } from "./nav-icon";
import { cn } from "@/lib/cn";
import { useSession } from "@/hooks/use-session";

/**
 * Mobile: bottom tab bar, thumb-reachable. Desktop (md+): persistent left
 * rail with labels and more breathing room — not a stretched phone layout.
 *
 * The tab bar is a normal flex sibling of `<main>`, NOT `position: fixed` — real iOS Safari has a long-
 * standing class of bugs where a fixed-position element visually detaches/overlaps content mid-scroll
 * (especially as the toolbar auto-hides), which a `fixed` bottom nav hits constantly on a real phone even
 * though it looks fine in a desktop-browser device-emulation check. Structuring this as a capped-height
 * flex column with `<main>` as the only internally-scrolling region sidesteps that whole bug class: the
 * nav always occupies real, reserved space at the bottom of the column, so it can never overlap anything.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { user } = useSession();

  return (
    <div className="flex h-dvh flex-col bg-canvas md:flex-row">
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
              >
                <NavIcon icon={item.icon} className="size-5 shrink-0" />
                {item.label}
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

      {/* min-w-0 matters once md:flex-row kicks in — without it this column refuses to shrink below its
          content's preferred width (e.g. an unwrapped long document title), pushing the whole shell wider
          than the viewport instead of letting that content truncate/wrap within its own column. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[var(--width-panel)] px-4 py-6 md:px-8 md:py-8">{children}</div>
        </main>

        <nav
          aria-label="Primary"
          className="flex shrink-0 border-t border-border-subtle bg-surface/95 backdrop-blur md:hidden"
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
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </div>
  );
}
