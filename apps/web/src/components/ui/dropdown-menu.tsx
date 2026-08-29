"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

export interface DropdownMenuItem {
  label: string;
  onSelect: () => void;
  tone?: "default" | "critical";
  disabled?: boolean;
}

/**
 * A small set of secondary actions collapsed behind one "More" trigger, so a card doesn't have to lay
 * out every possible action as its own button — the primary action(s) stay real buttons; everything
 * else lives here. Hand-rolled (no headless-UI/Radix dependency in this app yet) — closes on outside
 * click and on Escape, matching the behavior a native <select>/menu would give for free.
 */
export function DropdownMenu({ items, label = "More", triggerClassName }: { items: DropdownMenuItem[]; label?: string; triggerClassName?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (items.length === 0) return null;

  return (
    <div ref={ref} className="relative inline-block">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={triggerClassName}
      >
        {label}
        <span aria-hidden="true" className="ml-1">
          ⋯
        </span>
      </Button>
      {open && (
        <div role="menu" className="absolute right-0 z-20 mt-1 min-w-[180px] rounded-lg border border-border-default bg-surface py-1 shadow-sm">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={cn(
                "block w-full px-3 py-2 text-left text-sm hover:bg-subtle disabled:opacity-50 disabled:cursor-not-allowed",
                item.tone === "critical" ? "text-critical" : "text-primary",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
