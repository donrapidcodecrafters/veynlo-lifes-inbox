"use client";

import { useId } from "react";
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
 *
 * Caught by a real automated-accessibility test, not assumed: `id` used to be optional with no fallback,
 * so a call site that forgot to pass one produced a switch with NO accessible name at all (the visible
 * `<label>` had no `for`, and the button itself has no text content beyond an `aria-hidden` thumb) — a
 * real `button-name` violation. `useId()` guarantees a stable id exists either way, so this can never
 * regress to an unlabeled control again regardless of what a future call site does.
 */
export function Switch({ checked, onCheckedChange, disabled, label, description, id }: SwitchProps) {
  const generatedId = useId();
  const switchId = id ?? generatedId;
  return (
    <div className="flex items-center justify-between gap-4 py-1">
      <div className="min-w-0">
        <label htmlFor={switchId} className="block text-[0.9375rem] font-medium text-primary">
          {label}
        </label>
        {description && <p className="mt-0.5 text-sm text-tertiary">{description}</p>}
      </div>
      <button
        id={switchId}
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
            // Tailwind v4's `translate-x-*` sets the CSS `translate` shorthand, which needs a paired
            // `--tw-translate-y` (from a `translate-y-*` class) to be a valid value — without one, the
            // whole property computes to invalid and the thumb never actually moves. `left-*` sidesteps
            // that composition entirely.
            "absolute top-0.5 size-5 rounded-full bg-white shadow-sm transition-[left] duration-150",
            checked ? "left-[18px]" : "left-0.5",
          )}
          aria-hidden="true"
        />
      </button>
    </div>
  );
}
