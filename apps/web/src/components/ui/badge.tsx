import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type Tone = "neutral" | "critical" | "warning" | "info" | "positive" | "brand";

const toneClasses: Record<Tone, string> = {
  neutral: "bg-subtle text-secondary",
  critical: "bg-critical-subtle text-critical-subtle-text",
  warning: "bg-warning-subtle text-warning-subtle-text",
  info: "bg-info-subtle text-info-subtle-text",
  positive: "bg-positive-subtle text-positive-subtle-text",
  brand: "bg-brand-subtle text-brand-subtle-text",
};

/**
 * Every tone pairs a color with distinct wording — color is never the only
 * signal (WCAG 2.2: don't communicate meaning by color alone).
 */
export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium", toneClasses[tone])}>
      {children}
    </span>
  );
}
