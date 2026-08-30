import { pgTable, text, timestamp, boolean, integer } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { households } from "./household";
import { encryptedText, encryptedJsonb } from "./encrypted-type";

export const automationRules = pgTable("automation_rules", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
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

export const automationRuns = pgTable("automation_runs", {
  id: text("id").primaryKey(),
  ruleId: text("rule_id")
    .notNull()
    .references(() => automationRules.id, { onDelete: "cascade" }),
  triggerEvidenceId: text("trigger_evidence_id"),
  state: text("state").notNull().default("triggered"),
  idempotencyKey: text("idempotency_key").notNull(),
  commandsJson: encryptedJsonb<unknown>("commands_json").notNull(),
  resultJson: encryptedJsonb<unknown>("result_json"),
  // The run record itself is kept (it's an execution/audit trail, not this user's private data) even
  // after the approver deletes their account — only the identifying link is cleared.
  approvedByUserId: text("approved_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
