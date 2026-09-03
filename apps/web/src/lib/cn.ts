import { twMerge } from "tailwind-merge";

/**
 * Real bug found via live audit: a plain string-join gives no guarantee that a caller's override class
 * (e.g. `className="w-40"` passed to `Input`, whose own base classes hardcode `w-full`) actually wins —
 * CSS specificity for two same-weight utility classes is decided by which one appears LATER in Tailwind's
 * *compiled stylesheet*, not by className string order, and that compiled order depends on arbitrary
 * build-time class-discovery order. Confirmed live: a maintenance-record Cost input rendered at 862px
 * instead of the intended 160px on some pages, not others, backed by nothing but which class Tailwind's
 * scanner happened to encounter first. `twMerge` resolves same-property Tailwind utility conflicts
 * deterministically (last one wins), independent of build order.
 */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return twMerge(classes.filter(Boolean).join(" "));
}
