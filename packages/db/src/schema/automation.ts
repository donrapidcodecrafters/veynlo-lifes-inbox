import { pgTable, text, timestamp, boolean, integer, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { households } from "./household";
import { merchants } from "./commerce";
import { encryptedText, encryptedJsonb } from "./encrypted-type";

export const automationRules = pgTable("automation_rules", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
  // §28 encryption-inventory sweep — every other user-named first-class object across the schema
  // (households.name, lists.name, propertyProfiles.label, vehicleProfiles.label, petProfiles.label,
  // places.label, trips.label, schoolSources.label, smartDevices.label, savedItems.label) encrypts its
  // name/label; this was the one outlier, sitting right beside naturalLanguageSource/triggerDescriptor/
  // actionDescriptor (all encryptedText) below. Only ever queried by `eq(ownerUserId, ...)`, never by
  // name itself (automation.service.ts's listForUser), so encrypting it doesn't break anything.
  name: encryptedText("name").notNull(),
  naturalLanguageSource: encryptedText("natural_language_source"),
  triggerDescriptor: encryptedText("trigger_descriptor").notNull(),
  actionDescriptor: encryptedText("action_descriptor").notNull(),
  riskTier: text("risk_tier").notNull(),
  approvalMode: text("approval_mode").notNull().default("confirm_each_time"),
  enabled: boolean("enabled").notNull().default(true),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const automationRuns = pgTable(
  "automation_runs",
  {
    id: text("id").primaryKey(),
    ruleId: text("rule_id")
      .notNull()
      .references(() => automationRules.id, { onDelete: "cascade" }),
    triggerEvidenceId: text("trigger_evidence_id"),
    state: text("state").notNull().default("triggered"),
    idempotencyKey: text("idempotency_key").notNull(),
    commandsJson: encryptedJsonb<unknown>("commands_json", null).notNull(),
    resultJson: encryptedJsonb<unknown>("result_json", null),
    // AUTO-006 "Undo / compensation" — the id of whatever row `AutomationService.executeRun` created for an
    // undoable action kind (`add_task`'s task id, `add_calendar_event`'s calendar event id), so
    // `AutomationService.undoRun` knows exactly what to delete without re-deriving it. Left null for `notify`
    // (nothing was created to delete) and for any run that never reached "succeeded".
    resultResourceId: text("result_resource_id"),
    // The run record itself is kept (it's an execution/audit trail, not this user's private data) even
    // after the approver deletes their account — only the identifying link is cleared.
    approvedByUserId: text("approved_by_user_id").references(() => users.id, { onDelete: "set null" }),
    // §34.1 L2 "prepare_cancellation" — resolved once, at trigger time, from the firing event's
    // `merchantLabel` (an exact `merchants.displayName` match, same lookup `IngestionService.
    // findOrCreateMerchant` already uses — never created here, only looked up: automation is not a
    // merchant-authoring surface). Stored on the run itself (not re-resolved at execute time) so `approveRun`
    // — which only has the rule and run, not the original `AutomationTriggerEvent` — can still find the
    // right merchant's curated steps when the action finally executes. Null whenever the action kind isn't
    // `prepare_cancellation` or no merchant could be resolved.
    triggerMerchantId: text("trigger_merchant_id").references(() => merchants.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // AUTO-004 "Idempotency prevents double execution" / AutomationService.triggerRun's "one run per
    // (rule, resource)" contract — previously enforced only by an app-level SELECT-then-INSERT, which is
    // racy: two concurrent worker slots processing two different source events for the same underlying
    // resource (e.g. two "your bill was updated" emails about the same bill, landing on separate BullMQ
    // concurrency slots — several queues here run with concurrency > 1) could both pass the "no existing
    // run" check before either commits its INSERT, producing two runs (and, once approved/auto-run, two
    // tasks/calendar events/notifications) for what the product contract promises is a single action per
    // rule+resource. Mirrors source_events_idempotency_idx's same fix for the ingestion layer.
    uniqueIndex("automation_runs_idempotency_idx").on(t.idempotencyKey),
  ],
);

/**
 * §34.1 L2 "prepare" tier / spec AUTO-003 "Prepared actions — gather everything and stop before final
 * submit" (this codebase names it L2 since only L0/L1 existed before; conceptually it's the spec's own
 * "prepare by default" posture for consequential external actions, applied to the one concrete case this
 * app can honestly build without any provider-side write access: subscription cancellation). Deliberately
 * a table distinct from `tasks` — a plain task is a free-text reminder with a simple done/not-done toggle;
 * a prepared action bundles the REAL merchant-specific steps (`merchant-cancellation-steps.ts`'s curated
 * table, same data the SUB-004 cancellation-assistant UI already shows) and tracks a dedicated
 * confirmation state a plain task's `completedAt` boolean doesn't express: "pending_confirmation" (staged,
 * waiting on the user) -> "confirmed_done" (user says they went and did it themselves) or "dismissed" (user
 * doesn't want to). Veynlo never marks one of these done on its own and never performs the cancellation
 * itself — see this table's `steps`/`sourceNote` columns, sourced from the exact same honestly-caveated
 * reference data `merchant-cancellation-steps.ts` already serves informationally elsewhere.
 */
export const preparedActions = pgTable(
  "prepared_actions",
  {
    id: text("id").primaryKey(),
    // One prepared action per run — `AutomationService.executeRun` creates exactly one when a
    // `prepare_cancellation` run executes, never more (idempotency is already guaranteed one level up by
    // `automation_runs_idempotency_idx`/`triggerRun`'s "one run per rule+resource" contract).
    runId: text("run_id")
      .notNull()
      .references(() => automationRuns.id, { onDelete: "cascade" })
      .unique(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    // Null when the triggering event carried no resolvable merchant — the row still surfaces (with
    // whatever `steps` were resolved) rather than being blocked on this being set.
    merchantId: text("merchant_id").references(() => merchants.id),
    title: encryptedText("title").notNull(),
    // Snapshotted at execution time from `resolveMerchantCancellationSteps` (never a live re-fetch) — the
    // same "ordered plain-text steps to follow" shape as `merchantCancellationSteps.steps`, deliberately not
    // encrypted for the same reason that source table isn't: shared/curated reference content, not this
    // user's private data (a user's own correction there is owner-scoped and picked up here at the moment
    // this row is created, not live-synced afterward).
    steps: jsonb("steps").$type<string[]>().notNull(),
    sourceNote: text("source_note"),
    // "pending_confirmation" (default, staged) -> "confirmed_done" | "dismissed". Enforced as a one-way
    // transition by `AutomationService.confirmPreparedAction`/`dismissPreparedAction` — both reject unless
    // the current state is still "pending_confirmation", so a row can't bounce back and forth.
    state: text("state").notNull().default("pending_confirmation"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("prepared_actions_owner_state_idx").on(t.ownerUserId, t.state)],
);
