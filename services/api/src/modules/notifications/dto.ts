import { z } from "zod";

// §28.8 "Use explicit response DTOs and update allowlists... never blindly serialize... mass-assign
// request JSON into domain objects." This used to be `@Body() patch: Record<string, unknown>` with no
// runtime validation at all — an extra key in the request body (e.g. `categoryOverrides`, a real jsonb
// column not exposed by this DTO) would flow straight into the update via a raw object spread. Every
// field here is genuinely user-settable; anything else on the row (userId — the primary key) is
// intentionally not part of this allowlist.
export const UpdateNotificationPreferencesDtoSchema = z.object({
  intensity: z.enum(["quiet", "balanced", "proactive"]).optional(),
  quietHoursStart: z.string().nullable().optional(),
  quietHoursEnd: z.string().nullable().optional(),
  // §NOT-002 "critical override only when user opted in and event qualifies" — lets a user turn OFF the
  // default always-override-quiet-hours behavior for critical-priority notifications; see
  // notification-delivery.service.ts's deliver() for the actual enforcement point.
  criticalOverridesQuietHours: z.boolean().optional(),
  dailyBriefEnabled: z.boolean().optional(),
  weeklyBriefEnabled: z.boolean().optional(),
  sensitivePreviewsEnabled: z.boolean().optional(),
  // §NOT-001 per-category controls. Keyed by the category a notification's dedupeKey is derived from
  // (see NotificationDeliveryService.categoryOf) — e.g. "task-assigned", "automation-run", "inbox-item".
  // "muted" fully suppresses that category (still recorded, with state "suppressed", for the history
  // view); "default" (or an absent key) applies no override. Only two values on purpose — this closes the
  // dead-preference gap (the column existed and was stored but deliver() never read it) without building
  // out the full push/email/in-app/digest-per-category picker the spec describes as a Plus+ "advanced
  // control"; that richer per-channel remapping is still unbuilt.
  categoryOverrides: z.record(z.string(), z.enum(["muted", "default"])).optional(),
  // Phase 2 §52.2 "safe-spend awareness" — null explicitly clears the cap (distinct from omitting the
  // field, which leaves whatever cap was already set untouched).
  monthlySpendCapMinorUnits: z.number().int().positive().nullable().optional(),
});
export type UpdateNotificationPreferencesDto = z.infer<typeof UpdateNotificationPreferencesDtoSchema>;
