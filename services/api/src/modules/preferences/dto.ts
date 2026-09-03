import { z } from "zod";
import { CategoryDomainKeySchema } from "@veynlo/core";

/**
 * PERS-002 "Home customization" — "Reorder/hide optional Home modules while Needs You safety logic
 * remains accessible." `moduleOrder`/`hiddenModules` only ever carry OPTIONAL module keys; "needs_you" is
 * rejected here (not just ignored client-side) so a crafted request can never persist it as hideable —
 * see PreferencesService.updateHomeModulePreferences for the same belt-and-suspenders filter applied again
 * server-side before every write.
 */
const OPTIONAL_HOME_MODULE_KEYS = ["today", "money_at_risk", "family_today"] as const;
export const HomeModuleKeySchema = z.enum(OPTIONAL_HOME_MODULE_KEYS);
export type HomeModuleKey = z.infer<typeof HomeModuleKeySchema>;

export const UpdateHomeModulePreferencesDtoSchema = z.object({
  moduleOrder: z.array(HomeModuleKeySchema).max(OPTIONAL_HOME_MODULE_KEYS.length).optional(),
  hiddenModules: z.array(HomeModuleKeySchema).max(OPTIONAL_HOME_MODULE_KEYS.length).optional(),
});
export type UpdateHomeModulePreferencesDto = z.infer<typeof UpdateHomeModulePreferencesDtoSchema>;

/** PERS-003 — a single domain's opt-in/opt-out. One domain per request, mirroring how the UI presents this
 * (a per-row toggle list), not a bulk replace-the-whole-set call. */
export const UpdateCategoryPreferenceDtoSchema = z.object({
  domain: CategoryDomainKeySchema,
  enabled: z.boolean(),
});
export type UpdateCategoryPreferenceDto = z.infer<typeof UpdateCategoryPreferenceDtoSchema>;

/** PERS-004/PERS-005 — see personalizationPreferences' own schema doc comment for what each field is (and
 * isn't) for. `preferredName` empty string is normalized to null (clears it, same "explicit null clears"
 * convention as `monthlySpendCapMinorUnits` elsewhere). */
export const UpdatePersonalizationPreferencesDtoSchema = z.object({
  preferredName: z
    .string()
    .max(200)
    .nullable()
    .optional()
    .transform((v) => (v === "" ? null : v)),
  weekStart: z.enum(["sunday", "monday"]).optional(),
  timeFormat: z.enum(["12h", "24h"]).optional(),
  // PERS-005 "Concise vs detailed answers" — STYLE only; see SearchService.ask.
  askResponseStyle: z.enum(["concise", "balanced", "detailed"]).optional(),
  // PERS-005 "proactive suggestion intensity" — stored for forward use by the notification/suggestion
  // layer; NotificationPreferences.intensity already covers actual notification cadence today (see that
  // table's own `intensity` column), so this is deliberately distinct: it's the Ask/Home suggestion
  // surface's own knob, not a duplicate of the notifications one.
  suggestionIntensity: z.enum(["quiet", "balanced", "proactive"]).optional(),
  // FIN-007 "Financial privacy mode" — see personalizationPreferences.financialPrivacyModeEnabled's own
  // schema doc comment for what this does and doesn't affect.
  financialPrivacyModeEnabled: z.boolean().optional(),
});
export type UpdatePersonalizationPreferencesDto = z.infer<typeof UpdatePersonalizationPreferencesDtoSchema>;

/** FIN-007 "biometric reveal option" — same step-up shape as identity-records' RevealDocumentNumberDtoSchema
 * (§28.9's established "password optional, server tells you if it's actually required" convention). */
export const RevealFinancialPrivacyDtoSchema = z.object({
  password: z.string().optional(),
});
export type RevealFinancialPrivacyDto = z.infer<typeof RevealFinancialPrivacyDtoSchema>;
