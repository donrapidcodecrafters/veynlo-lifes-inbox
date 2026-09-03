"use client";

import { cn } from "@/lib/cn";

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
  description?: string;
  id?: string;
}

/**
 * Binary settings use a switch, never a checkbox (product requirement).
 * Built as `role="switch"` on a real button — the ARIA-correct pattern —
 * rather than a checkbox, for consistent cross-browser styling.
 */
export function Switch({ checked, onCheckedChange, disabled, label, description, id }: SwitchProps) {
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <div className="min-w-0">
        <label htmlFor={id} className="block text-[0.9375rem] font-medium text-primary">
          {label}
        </label>
        {description && <p className="mt-0.5 text-sm text-tertiary">{description}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className={cn(
          "relative h-6 w-10 shrink-0 rounded-full transition-colors duration-150",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          checked ? "bg-brand" : "bg-[var(--border-strong)]",
        )}
      >
        <span
          className={cn(
            // `left-0` is load-bearing, not decorative — with no explicit `left`, this absolutely
            // positioned span's base position falls back to the browser's "auto" static-position
            // algorithm, which real testing showed does NOT reliably resolve to 0 here: the thumb's
            // `translate-x` (meant to move it from a 2px-inset resting position to an 18px-inset one,
            // symmetric within the button's 40px width) instead compounded on top of an unpredictable
            // base offset, pushing the thumb's right edge visibly outside the button — and outside
            // whatever container the switch sits in — every time a switch was toggled on. Confirmed via
            // getBoundingClientRect on a live checked switch: thumb.right exceeded button.right by 18px
            // before this fix.
            "absolute left-0 top-0.5 size-5 rounded-full bg-white shadow-sm transition-transform duration-150",
            checked ? "translate-x-[18px]" : "translate-x-0.5",
          )}
          aria-hidden="true"
        />
      </button>
    </div>
  );
}
