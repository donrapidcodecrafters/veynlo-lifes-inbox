import type { SectionTabOption } from "@/hooks/use-section-tabs";

interface SectionTabsProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: readonly SectionTabOption<T>[];
  "aria-label": string;
}

/**
 * Pill tab strip for a page with several full data sections stacked below it (Life, Home, ...) — pairs
 * with the `useSectionTabs` hook, which backs `value`/`onChange` with the URL's `?tab=` param. Same
 * visual/markup shape as documents/page.tsx's own filter tabs (role="tablist"/role="tab", rounded-full
 * pill, brand-filled when active) rather than SegmentedControl's boxed/inset look — that one already
 * reads as "a single setting's 2-3 mutually exclusive values" (Theme, Week start, ...), not "which of
 * several sections is visible," and documents/page.tsx already established this exact look for the
 * latter. Wraps onto a second line on narrow viewports rather than scrolling horizontally, since 6-8 short
 * labels wrap cleanly and no other tab strip on this app's web side scrolls horizontally either.
 */
export function SectionTabs<T extends string>({ value, onChange, options, ...rest }: SectionTabsProps<T>) {
  return (
    <div role="tablist" aria-label={rest["aria-label"]} className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
            value === o.value ? "bg-brand text-on-brand" : "bg-subtle text-secondary hover:text-primary"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
