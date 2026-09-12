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
  primary: "bg-brand text-on-brand hover:bg-brand-hover active:bg-brand-active shadow-xs",
  secondary: "bg-surface text-primary border border-border-default hover:bg-subtle",
  ghost: "bg-transparent text-primary hover:bg-subtle",
  // Not literal white: --text-on-brand is white in light and near-black in dark, which is what a
  // saturated fill needs in each theme. Hard-coded white measured 3.82:1 against the corrected dark
  // critical red; the token measures 4.64:1 there and 4.91:1 in light.
  critical: "bg-critical text-on-brand hover:brightness-95",
};

const sizeClasses: Record<Size, string> = {
  sm: "h-8 px-3 text-sm gap-1.5",
  md: "h-10 px-4 text-[0.9375rem] gap-2",
  lg: "h-12 px-5 text-base gap-2",
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
