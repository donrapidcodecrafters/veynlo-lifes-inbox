import { pgTable, text, timestamp, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./identity";

/**
 * §36 "Widgets, Voice, Wearables & System Integrations" (SYS-001..008). Every one of these eight spec
 * items shares the identical "Backend behavior" line verbatim ("Platform bridge queries minimal
 * authorized projection APIs; caches only required snapshot; deep links use signed/internal routes; voice
 * capture enters standard source pipeline.") and the identical "Primary data" list (`widget_preferences,
 * device_projections, app_intent_log, voice_source_event`) — this file is the real, shared backend half
 * every platform surface (iOS/Android widgets, App Intents/system actions, watchOS/Wear OS, Live
 * Activities) would call into. The actual WidgetKit/Glance/App-Intents/watchOS/WearOS/ActivityKit UI code
 * itself needs a real Xcode/Android Studio native build this environment cannot produce — see
 * docs/PHASE2_PENDING_CREDENTIALS.md's SYS-001..008 section for exactly what is and isn't built.
 *
 * `device_projections` (a cached snapshot table) is deliberately NOT modeled here — at this app's current
 * scale, `WidgetsService`'s projection endpoints (today-summary/next-trip/deliveries) just read the live
 * tables fresh on every call, the same "no cache, no staleness bugs" posture most of this codebase's other
 * read endpoints already take. A cache genuinely earns its keep once background-refresh volume from real
 * installed widgets justifies the staleness/invalidation complexity it adds — a real, deliberate scope
 * decision, not an oversight (see this file's own module doc comment for the fuller reasoning), so no
 * `deviceProjections` table exists to go stale or need pruning.
 *
 * `voice_source_event` is likewise not a separate table: SYS-005's own line is "voice capture enters
 * standard source pipeline" — IngestionService.ingestVoiceNote already files a `kind: "voice_note"` row
 * directly into the existing `source_events` table (packages/db/src/schema/graph.ts), exactly the "standard
 * pipeline" reuse the spec calls for. Inventing a second, parallel `voice_source_event` table here would be
 * the "parallel idempotency pattern" this session was explicitly warned against, not a fix for a real gap.
 */
export const WIDGET_KINDS = ["today_summary", "next_trip", "deliveries", "family_schedule", "quick_capture"] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

export const WIDGET_PRIVACY_MODES = ["detail", "count_only"] as const;
export type WidgetPrivacyMode = (typeof WIDGET_PRIVACY_MODES)[number];

/**
 * SYS-001 "Privacy mode controls visible detail." One row per (user, widget kind) — a user may want their
 * lock-screen "Needs You" widget masked to a bare count while a Home-screen "Next trip" widget still shows
 * the destination. No row for a given kind means "detail" (matches this app's existing non-widget Home
 * screen default; a user opts INTO masking, same "explicit opt-in" posture as every other privacy toggle
 * in this codebase — e.g. `automation.ts`'s external-writes scope, `preferences.ts`'s category opt-outs).
 */
export const widgetPreferences = pgTable(
  "widget_preferences",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    widgetKind: text("widget_kind").notNull(),
    privacyMode: text("privacy_mode").notNull().default("detail"),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("widget_preferences_user_kind_idx").on(t.userId, t.widgetKind)],
);

/**
 * SYS-003/004 "Expose safe intents... Sensitive query results require device/app authentication; mutating
 * actions declare confirmation behavior" — an audit/analytics trail of every App Intent / Android system
 * action / widget-tap deep-link resolution actually invoked, independent of whatever domain object the
 * intent acted on (a "mark task complete" intent's audit trail belongs here, not duplicated onto the task
 * itself). `platform` distinguishes which of the eight SYS-* surfaces produced the entry — useful for the
 * spec's own "shortcut success" / "wearable action completion" analytics signal once a real native client
 * exists to call this.
 */
export const appIntentLog = pgTable(
  "app_intent_log",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(), // "ios_widget" | "android_widget" | "ios_app_intent" | "android_shortcut" | "watchos" | "wearos" | "live_activity"
    intentKind: text("intent_kind").notNull(), // e.g. "add_to_inbox", "mark_task_complete", "open_today", "ask_saved_fact", "widget_tap", "voice_capture"
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    outcome: text("outcome").notNull(), // "success" | "failed" | "denied"
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("app_intent_log_user_idx").on(t.userId, t.occurredAt)],
);
