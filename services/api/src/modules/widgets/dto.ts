import { z } from "zod";
import { schema } from "@veynlo/db";

export const WidgetKindParamSchema = z.object({
  widgetKind: z.enum(schema.WIDGET_KINDS),
});
export type WidgetKindParam = z.infer<typeof WidgetKindParamSchema>;

export const SetWidgetPreferenceDtoSchema = z.object({
  privacyMode: z.enum(schema.WIDGET_PRIVACY_MODES).optional(),
  enabled: z.boolean().optional(),
});
export type SetWidgetPreferenceDto = z.infer<typeof SetWidgetPreferenceDtoSchema>;

/**
 * SYS-003/004 "Expose safe intents... app shortcuts, Assistant-compatible/app actions." A closed enum
 * (not a free string) so a future native client can't log an arbitrary, unbounded label into
 * `app_intent_log` — matches the spec's own named examples ("Add to Life Inbox, Ask a saved fact, Mark
 * task complete, Save current item, Open Today") plus the widget-tap/voice-capture cases this session's
 * server-side half actually implements.
 */
export const APP_INTENT_KINDS = [
  "add_to_inbox",
  "ask_saved_fact",
  "mark_task_complete",
  "save_current_item",
  "open_today",
  "widget_tap",
  "voice_capture",
] as const;

export const APP_INTENT_PLATFORMS = ["ios_widget", "android_widget", "ios_app_intent", "android_shortcut", "watchos", "wearos", "live_activity"] as const;

export const APP_INTENT_OUTCOMES = ["success", "failed", "denied"] as const;

export const LogAppIntentDtoSchema = z.object({
  platform: z.enum(APP_INTENT_PLATFORMS),
  intentKind: z.enum(APP_INTENT_KINDS),
  resourceType: z.string().max(60).nullable().optional(),
  resourceId: z.string().max(200).nullable().optional(),
  outcome: z.enum(APP_INTENT_OUTCOMES),
});
export type LogAppIntentDto = z.infer<typeof LogAppIntentDtoSchema>;

export const ResolveDeepLinkQuerySchema = z.object({
  token: z.string().min(1).max(4000),
});
export type ResolveDeepLinkQuery = z.infer<typeof ResolveDeepLinkQuerySchema>;
