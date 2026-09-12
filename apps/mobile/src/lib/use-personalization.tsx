import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/api-client";

/** PERS-004/PERS-005 — mirrors apps/web's identical hook (see apps/web/src/hooks/use-personalization.ts).
 * No SWR on mobile (this app fetches with plain useState/useEffect, same pattern as (tabs)/settings.tsx's
 * own `NotificationPreferences` state), so this is a small local-state hook instead of a cache wrapper. */
export interface PersonalizationPreferences {
  preferredName: string | null;
  weekStart: "sunday" | "monday";
  timeFormat: "12h" | "24h";
  askResponseStyle: "concise" | "balanced" | "detailed";
  suggestionIntensity: "quiet" | "balanced" | "proactive";
  // FIN-007 "Financial privacy mode" — see personalizationPreferences.financialPrivacyModeEnabled's own
  // schema doc comment (packages/db/src/schema/preferences.ts) for what this controls.
  financialPrivacyModeEnabled: boolean;
}

const DEFAULTS: PersonalizationPreferences = {
  preferredName: null,
  weekStart: "sunday",
  timeFormat: "12h",
  askResponseStyle: "balanced",
  suggestionIntensity: "balanced",
  financialPrivacyModeEnabled: false,
};

interface PersonalizationContextValue {
  data: PersonalizationPreferences;
  loaded: boolean;
  update: (patch: Partial<PersonalizationPreferences>) => Promise<void>;
  reload: () => void;
}

const PersonalizationContext = createContext<PersonalizationContextValue | null>(null);

/**
 * One copy of the preferences for the whole app.
 *
 * Without this each caller held its own: the privacy screen's toggle updated the privacy screen, while
 * FinancialPrivacyProvider — the thing that actually masks — kept whatever it read at startup. Financial
 * privacy mode therefore did nothing until the app was restarted, with the switch showing it was on.
 */
export function PersonalizationProvider({ children }: { children: ReactNode }) {
  const value = usePersonalizationState();
  return <PersonalizationContext.Provider value={value}>{children}</PersonalizationContext.Provider>;
}

/**
 * Reads the shared preferences.
 *
 * Falls back to its own local state when no provider is above it, so a screen rendered outside the app
 * shell still works — it simply does not share, which is the old behaviour and is correct for that case.
 */
export function usePersonalizationPreferences(): PersonalizationContextValue {
  const shared = useContext(PersonalizationContext);
  const fallback = usePersonalizationState(!shared);
  return shared ?? fallback;
}

function usePersonalizationState(enabled = true): PersonalizationContextValue {
  const [data, setData] = useState<PersonalizationPreferences>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(() => {
    api
      .get<PersonalizationPreferences>("/v1/personalization-preferences")
      .then((res) => {
        setData(res);
        setLoaded(true);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    // Skipped when this instance is only the unused fallback inside a provider-backed tree — otherwise
    // every consumer would still fire its own request, which is half the problem this replaces.
    if (enabled) reload();
  }, [reload, enabled]);

  /**
   * Optimistic, and therefore obliged to undo itself. Without the rollback a failed PUT left every screen
   * reading these preferences showing a value that was never stored — Privacy's financial-mode switch stays
   * on, Personalization shows the new name — and nothing in flight to eventually correct it.
   *
   * The error is re-thrown rather than swallowed: the rollback fixes the false state, but only the calling
   * screen knows where to put a message the user will actually see.
   */
  const update = useCallback(async (patch: Partial<PersonalizationPreferences>) => {
    let previous: PersonalizationPreferences = DEFAULTS;
    setData((prev) => {
      previous = prev;
      return { ...prev, ...patch };
    });
    try {
      const updated = await api.put<PersonalizationPreferences>("/v1/personalization-preferences", patch);
      setData(updated);
    } catch (err) {
      setData(previous);
      throw err;
    }
  }, []);

  return { data, loaded, update, reload };
}
