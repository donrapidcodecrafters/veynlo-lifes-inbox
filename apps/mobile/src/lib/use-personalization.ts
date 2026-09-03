import { useCallback, useEffect, useState } from "react";
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

export function usePersonalizationPreferences() {
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
    reload();
  }, [reload]);

  const update = useCallback(async (patch: Partial<PersonalizationPreferences>) => {
    setData((prev) => ({ ...prev, ...patch }));
    const updated = await api.put<PersonalizationPreferences>("/v1/personalization-preferences", patch);
    setData(updated);
  }, []);

  return { data, loaded, update, reload };
}
