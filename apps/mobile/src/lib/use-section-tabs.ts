import { useCallback, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

export interface SectionTabOption<T extends string> {
  value: T;
  label: string;
}

/**
 * Backs a `SectionTabs` strip (components/section-tabs.tsx) with AsyncStorage — the mobile counterpart of
 * apps/web's identical `useSectionTabs` (hooks/use-section-tabs.ts), which persists the same choice in the
 * URL's `?tab=` param instead. Mobile has no URL to bookmark/reload, so "remembers the user's last view"
 * here means: the next time this screen mounts, it restores whatever tab was last selected — same
 * AsyncStorage-backed "just works across app restarts, not synced across devices" tier as this app's other
 * lightweight UI-preference stores (theme-store.ts uses SecureStore instead only because it predates this
 * one and didn't want a second native dependency; a tab selection isn't sensitive enough to need that).
 *
 * `storageKey` must be unique per screen (e.g. "veynlo_section_tab_life") so Life and Home don't collide.
 * Starts at `defaultValue` (mirrors web's own choice not to persist the default tab) and swaps to the
 * stored value, if any and still valid, once the async read resolves — so the very first render (and any
 * render before the read finishes) is never wrong, just briefly the default.
 */
export function useSectionTabs<T extends string>(storageKey: string, options: readonly SectionTabOption<T>[], defaultValue: T) {
  const [tab, setTabState] = useState<T>(defaultValue);

  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(storageKey)
      .then((stored) => {
        if (cancelled || !stored) return;
        if (options.some((o) => o.value === stored)) setTabState(stored as T);
      })
      .catch(() => {
        // Best-effort — same "a failed read just keeps the default" stance as this app's other
        // AsyncStorage-backed caches (trip-offline-cache.ts, emergency-binder-cache.ts).
      });
    return () => {
      cancelled = true;
    };
    // Read once, on mount only — mirrors web's identical one-shot restore-from-storage. `options` is
    // expected to be a stable module-level constant at every call site, so it's safe to omit here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectTab = useCallback(
    (next: T) => {
      setTabState(next);
      AsyncStorage.setItem(storageKey, next).catch(() => {
        // Best-effort — a failed write just means the next visit falls back to defaultValue, not a crash.
      });
    },
    [storageKey],
  );

  return [tab, selectTab] as const;
}
