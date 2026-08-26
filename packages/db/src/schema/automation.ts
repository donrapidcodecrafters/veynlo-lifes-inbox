import { pgTable, text, timestamp, boolean, integer, jsonb } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { households } from "./household";

export const automationRules = pgTable("automation_rules", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  naturalLanguageSource: text("natural_language_source"),
  triggerDescriptor: text("trigger_descriptor").notNull(),
  actionDescriptor: text("action_descriptor").notNull(),
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
  commandsJson: jsonb("commands_json").notNull(),
  resultJson: jsonb("result_json"),
  approvedByUserId: text("approved_by_user_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
