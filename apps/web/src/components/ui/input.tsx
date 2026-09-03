import { forwardRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(({ className, error, ...props }, ref) => {
  return (
    <input
      ref={ref}
      className={cn(
        "h-10 w-full rounded-lg border bg-surface px-3.5 text-[0.9375rem] text-primary placeholder:text-tertiary",
        "transition-colors duration-150",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]",
        // No page currently renders a disabled Input, but the component (unlike Button/Switch, both of
        // which already style their disabled state) had nothing here — the moment one did, it would've
        // looked identical to an editable field. Matches Button/Switch's own disabled treatment.
        "disabled:cursor-not-allowed disabled:bg-subtle disabled:opacity-60",
        error ? "border-critical" : "border-border-default focus:border-border-focus",
        className,
      )}
      aria-invalid={Boolean(error) || undefined}
      {...props}
    />
  );
});
Input.displayName = "Input";

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(({ className, error, ...props }, ref) => {
  return (
    <textarea
      ref={ref}
      className={cn(
        "w-full rounded-lg border bg-surface px-3.5 py-2.5 text-[0.9375rem] text-primary placeholder:text-tertiary",
        "transition-colors duration-150",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]",
        "disabled:cursor-not-allowed disabled:bg-subtle disabled:opacity-60",
        error ? "border-critical" : "border-border-default focus:border-border-focus",
        className,
      )}
      aria-invalid={Boolean(error) || undefined}
      {...props}
    />
  );
});
Textarea.displayName = "Textarea";

export function FieldError({ children }: { children?: string }) {
  if (!children) return null;
  return (
    <p role="alert" className="mt-1.5 text-sm text-critical">
      {children}
    </p>
  );
}

export function Label({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-secondary">
      {children}
    </label>
  );
}
