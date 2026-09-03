"use client";

import { useCallback, useEffect, useState } from "react";

export interface SectionTabOption<T extends string> {
  value: T;
  label: string;
}

/**
 * Backs a `SectionTabs` strip (see components/ui/section-tabs.tsx) with the URL's `?tab=` (or a custom
 * `paramName`) query param — the shared mechanism behind every "several full sections stacked on one
 * long-scrolling page" screen that's been split into tabs (Life, Home, ...), so they all persist/restore
 * the selected tab the same way instead of each page inventing its own.
 *
 * Reads the initial value from `window.location.search` in an effect on mount, then writes changes back
 * via `history.replaceState` — the same "avoid a Suspense boundary around useSearchParams() for a value
 * that's only ever read once" pattern this app already uses for a mount-only query read (see
 * sign-in/reset-password/emergency-binder's own identical doc comments). `replaceState` (not
 * `router.push`) means clicking through tabs never adds a browser-history entry — only the page's own
 * landing URL does — while a reload or a bookmarked `?tab=` link still lands on the right tab.
 *
 * The default tab (typically "all") is never written to the URL, so the plain, no-query page URL always
 * means "the default view" rather than needing its own explicit `?tab=all`.
 */
export function useSectionTabs<T extends string>(options: readonly SectionTabOption<T>[], defaultValue: T, paramName = "tab") {
  const [tab, setTab] = useState<T>(defaultValue);

  useEffect(() => {
    const fromQuery = new URLSearchParams(window.location.search).get(paramName);
    if (fromQuery && options.some((o) => o.value === fromQuery)) setTab(fromQuery as T);
    // Intentionally a one-shot "restore from the URL on mount" — not a subscription to it. `options` is
    // expected to be a stable module-level constant at every call site (mirrors the "All"/tab list
    // pattern below), so it's safe to omit from the dependency list here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectTab = useCallback(
    (next: T) => {
      setTab(next);
      const url = new URL(window.location.href);
      if (next === defaultValue) url.searchParams.delete(paramName);
      else url.searchParams.set(paramName, next);
      window.history.replaceState(null, "", `${url.pathname}${url.search}`);
    },
    [defaultValue, paramName],
  );

  return [tab, selectTab] as const;
}
