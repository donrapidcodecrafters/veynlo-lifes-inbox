"use client";

import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * A collapsed group of same-kind things, with optional nesting.
 *
 * Built for DEF-104 — Home returned 125 items with 55 of one kind, burying today's actual tasks eight
 * swipes down — but the rule is deliberately not Home's. Any list where one kind arrives in bulk uses this:
 * recalls on a vehicle, results in a search, categories in the inbox.
 *
 * The nesting is Don's shape: a group opens to reveal SUBGROUPS, each collapsed, which open to reveal the
 * records themselves inline on the same screen. No navigation until the user taps an actual record.
 *
 * Accessibility, which matters more here than on most components because the whole control IS the
 * disclosure:
 *
 *   - `aria-expanded` on the button, so the state is announced rather than only drawn as a chevron;
 *   - `aria-controls` pointing at the region it opens, so a screen reader can move between them;
 *   - the count is part of the accessible NAME, not a decoration — "Vehicle recalls, 55 items" is the
 *     whole point of a collapsed group and a label that omitted it would hide what the card is for;
 *   - `defaultOpen` is honoured so a caller can open one level while leaving its children shut.
 */
export function CollapsibleGroup({
  label,
  count,
  defaultOpen = false,
  tone = "default",
  meta,
  badge,
  children,
  className,
}: {
  label: string;
  count: number;
  /**
   * The urgency of what is INSIDE. Without it a collapsed group of 55 "important" recalls rendered with no
   * badge at all, directly above single "useful" items that each had one — so the group read as less
   * important than the least important thing on the screen. A summary must not rank below what it summarises.
   */
  badge?: ReactNode;
  defaultOpen?: boolean;
  /** `critical` for a group whose contents need attention now — matches the badge tones used elsewhere. */
  tone?: "default" | "critical" | "warning";
  /** A short line under the label: the representative item's due date, a jurisdiction, anything clarifying. */
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const regionId = useId();

  return (
    <div className={cn("rounded-lg border border-border-subtle bg-surface", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={regionId}
        // The count belongs in the NAME. A group card exists to say how many things it holds.
        aria-label={`${label}, ${count} ${count === 1 ? "item" : "items"}`}
        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-subtle"
      >
        <span className="flex min-w-0 items-center gap-2">
          {badge}
          <span
            className={cn(
              "block truncate text-sm font-medium",
              tone === "critical" ? "text-critical-subtle-text" : tone === "warning" ? "text-warning-subtle-text" : "text-primary",
            )}
          >
            {label}
          </span>
          {meta && <span className="mt-0.5 block truncate text-xs text-tertiary">{meta}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span className="rounded-full bg-subtle px-2 py-0.5 text-xs font-semibold tabular-nums text-secondary">{count}</span>
          <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            className={cn("h-4 w-4 text-tertiary transition-transform", open && "rotate-180")}
          >
            <path d="M5 7.5 10 12.5 15 7.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </button>
      {/* Rendered only when open: an unbounded group's members are exactly what must not all mount at once
          (DEF-105), and `hidden` would keep every one of them in the DOM. */}
      {open && (
        <div id={regionId} className="space-y-1.5 border-t border-border-subtle px-3 py-2.5">
          {children}
        </div>
      )}
    </div>
  );
}
