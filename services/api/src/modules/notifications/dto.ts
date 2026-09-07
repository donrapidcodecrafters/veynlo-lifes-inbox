import { z } from "zod";

// §28.8 "Use explicit response DTOs and update allowlists... never blindly serialize... mass-assign
// request JSON into domain objects." This used to be `@Body() patch: Record<string, unknown>` with no
// runtime validation at all — an extra key in the request body (e.g. `categoryOverrides`, a real jsonb
// column not exposed by this DTO) would flow straight into the update via a raw object spread. Every
// field here is genuinely user-settable; anything else on the row (userId — the primary key) is
// intentionally not part of this allowlist.
export const UpdateNotificationPreferencesDtoSchema = z.object({
  intensity: z.enum(["quiet", "balanced", "proactive"]).optional(),
  /* A 24-hour wall-clock time, or null to turn quiet hours off. Anything else was previously stored
     verbatim — "notatime" reached the database intact, live-verified — and `isWithinQuietHours` then read
     it back and silently muted the user from midnight. That function is defensive now, but garbage should
     not be stored either: the client shows the field back to the user, and a saved value nobody can parse
     is a setting they believe they have. Both bounds are checked, so "25:00" and "12:99" are refused too. */
  quietHoursStart: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time like 22:00.")
    .nullable()
    .optional(),
  quietHoursEnd: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time like 07:00.")
    .nullable()
    .optional(),
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
