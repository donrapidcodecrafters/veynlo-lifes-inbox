import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "critical";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

const variantClasses: Record<Variant, string> = {
  primary: "bg-brand text-on-brand border border-brand hover:bg-brand-hover active:bg-brand-active shadow-xs",
  secondary: "bg-surface text-primary border border-border-default hover:bg-subtle",
  // Every button carries a visible outline. Ghost previously rendered as bare text, so nothing told a
  // user it was a control — a "Dismiss" under a card read as a caption. The other variants get a
  // border in their own fill colour so the box geometry matches across variants in a shared row.
  ghost: "bg-transparent text-primary border border-border-default hover:bg-subtle",
  // Not literal white: --text-on-brand is white in light and near-black in dark, which is what a
  // saturated fill needs in each theme. Hard-coded white measured 3.82:1 against the corrected dark
  // critical red; the token measures 4.64:1 there and 4.91:1 in light.
  critical: "bg-critical text-on-brand border border-critical hover:brightness-95",
};

/**
 * A MINIMUM height, not a fixed one.
 *
 * These were `h-8`/`h-10`/`h-12`. A label that wraps is taller than its box, and with a fixed height the
 * text does not shrink the button — it escapes it: found on the Connections page at 390px, where a
 * "Connect task app" button rendered its first line ABOVE its own outline, so the word sat on the card
 * background with the border drawn through the middle of the label. The button still measured a tidy 40px,
 * which is why a height assertion did not catch it.
 *
 * `min-h-*` leaves every single-line button exactly where it was (content is well under the minimum) and
 * lets a wrapping one grow to contain its own text. The vertical padding matters for the same reason:
 * without it a two-line label sits flush against the border once the button does grow.
 */
const sizeClasses: Record<Size, string> = {
  sm: "min-h-8 px-3 py-1 text-sm gap-1.5",
  md: "min-h-10 px-4 py-1.5 text-[0.9375rem] gap-2",
  lg: "min-h-12 px-5 py-2 text-base gap-2",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", loading, disabled, children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn(
          "inline-flex items-center justify-center rounded-lg font-medium transition-colors duration-150",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]",
          variantClasses[variant],
          sizeClasses[size],
          className,
        )}
        aria-busy={loading || undefined}
        {...props}
      >
        {loading && (
          <span
            className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
            aria-hidden="true"
          />
        )}
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";
