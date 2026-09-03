import { pgTable, text, timestamp, jsonb, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { encryptedText } from "./encrypted-type";

/**
 * PERS-002 "Home customization" — "Reorder/hide optional Home modules while Needs You safety logic
 * remains accessible." Deliberately does NOT include "needs_you" as a storable module key: the safety
 * queue is filtered out of `moduleOrder`/`hiddenModules` server-side (see PreferencesService) so it can
 * never be hidden or reordered away by a stored preference, matching the spec's explicit carve-out.
 * `moduleOrder` only ever needs to carry the OPTIONAL module keys ("today", "money_at_risk",
 * "family_today" today); an unlisted key (a module shipped after a user last saved a preference) is
 * appended at the end by the client rather than silently dropped.
 */
export const homeModulePreferences = pgTable("home_module_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  moduleOrder: jsonb("module_order").$type<string[]>().notNull().default([]),
  hiddenModules: jsonb("hidden_modules").$type<string[]>().notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * PERS-003 "Category preferences" — "Choose interest/attention intensity by purchases, family, travel,
 * home, finance, etc... Disabling a category pauses future processing where feasible and explains
 * retained existing data." This is the user's OWN opt-out, independent of plan/entitlement — a Family-plan
 * subscriber can still turn off pet tracking for themselves, same as a free-plan user who's plan-gated off
 * it already. `IngestionService.classifyAndExtract` checks this alongside (not instead of) the existing
 * entitlement gates before routing to each domain extractor (see `packages/core`'s
 * `CategoryDomainKeySchema` for the canonical domain list + user-facing copy). No row for a
 * (userId, domain) pair means "enabled" (the default) — only an explicit opt-out is ever stored, so a
 * brand-new domain shipped after launch is enabled by default for every existing user without a backfill.
 */
export const categoryPreferences = pgTable(
  "category_preferences",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("category_preferences_user_domain_idx").on(t.userId, t.domain), index("category_preferences_user_idx").on(t.userId)],
);

/**
 * PERS-004/PERS-005 — "Preferred name, household/object nicknames, language/locale, week start, time
 * format" plus "Concise vs detailed answers and proactive suggestion intensity." Object nicknames are
 * already covered by each asset table's own `label` column (vehicleProfiles.label,
 * propertyProfiles.label, petProfiles.label, homeAssets.label — see automation.ts's own doc comment
 * listing them); language/locale/timezone already live on `users` (locale, timezone). This table holds
 * only what genuinely had nowhere to live: a display name distinct from the account's real `displayName`
 * (e.g. a nickname Ask/notifications address the user by, without renaming the account itself), week
 * start and time format (nothing on `users` or elsewhere modeled either), and the AI response-style
 * preferences PERS-005 calls for. `askResponseStyle`/`suggestionIntensity` are STYLE-only knobs — see
 * SearchService.ask's own doc comment on why they can only ever change phrasing, never the
 * injection-defense framing, evidence-grounding requirement, or confidence/insufficientEvidence logic.
 */
export const personalizationPreferences = pgTable("personalization_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  preferredName: encryptedText("preferred_name"),
  weekStart: text("week_start").notNull().default("sunday"), // "sunday" | "monday"
  timeFormat: text("time_format").notNull().default("12h"), // "12h" | "24h"
  askResponseStyle: text("ask_response_style").notNull().default("balanced"), // "concise" | "balanced" | "detailed"
  suggestionIntensity: text("suggestion_intensity").notNull().default("balanced"), // "quiet" | "balanced" | "proactive"
  // FIN-007 "Financial privacy mode" — "Allow amounts and account names to be hidden on Home, widgets,
  // household surfaces and notifications... Mask by default on lock screen; biometric reveal option." A
  // real gap found via spec-conformance audit: this is distinct from FinanceService.setAccountIncluded
  // (which excludes an account from SUMS, not from DISPLAY) — no code anywhere masked a dollar amount or
  // account name at all. Defaults to false: this is an opt-IN feature a user turns on (the spec's "Allow...
  // to be hidden" phrasing, same as every other privacy toggle on this table's page), not a change to
  // existing users' default experience; once turned on, `getFinancialPrivacyReveal`'s own doc comment
  // explains how the "mask by default... reveal option" half is actually enforced (masked again on every
  // fresh load/session, never a persisted "stays revealed" state).
  financialPrivacyModeEnabled: boolean("financial_privacy_mode_enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
