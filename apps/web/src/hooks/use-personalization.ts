"use client";

import useSWR from "swr";
import { swrFetcher } from "@/lib/api-client";

/** PERS-004/PERS-005 — mirrors `services/api`'s `PreferencesService.getPersonalizationPreferences`
 * response shape. A thin SWR wrapper (not a context) since this is server-backed account data, the same
 * pattern the Settings page already uses directly for `/v1/notification-preferences`. */
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
  const { data, ...rest } = useSWR<PersonalizationPreferences>("/v1/personalization-preferences", swrFetcher);
  return { data: data ?? DEFAULTS, isLoaded: data !== undefined, ...rest };
}
