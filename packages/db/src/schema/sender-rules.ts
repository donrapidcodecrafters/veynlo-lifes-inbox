import { pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./identity";

/**
 * MAIL-006 "User sender rules" — "Let users teach Life Inbox once." Until now the only sender-scoped rule
 * anywhere in this codebase was `calendarRescheduleTrustedRules` (a single boolean: trust reschedule
 * emails from this domain). The spec's actual ask is a real per-sender rule menu reachable from Inbox:
 * "Always treat messages from this sender as School / Bills / Ignore / Keep only attachments / Household
 * shared" — this table is that menu's storage, checked by `IngestionService.classifyAndExtract` as its very
 * first step, before the domain classifier or even the deterministic `matchKnownSender` registry runs.
 *
 * Scoped by EITHER a sender domain OR a full sender email address, never both — a rule aimed at
 * "billing@onecompany.com" specifically shouldn't also match every other address at that domain, and a
 * rule aimed at a whole domain ("acmehospital.org") shouldn't require enumerating every address that sends
 * from it. Enforced at the DTO layer (AddSenderRuleDtoSchema's `.refine`), not a DB CHECK constraint, to
 * keep this schema file free of raw SQL — matches this codebase's existing convention of validating
 * mutually-exclusive-field shapes in Zod rather than in the table definition.
 *
 * Two separate unique indexes (rather than one compound one) because only one of the two columns is ever
 * non-null on a given row — Postgres treats every NULL as distinct for uniqueness purposes, so a unique
 * index on (ownerUserId, senderDomain) alone would still allow unlimited rows with domain NULL for the same
 * owner; scoping each column's uniqueness independently is what actually prevents a duplicate domain rule
 * and a duplicate email rule for the same owner.
 */
export const senderRuleActionEnum = pgEnum("sender_rule_action", [
  "always_school",
  "always_bills",
  "ignore",
  "attachments_only",
  "household_shared",
]);

export const senderRules = pgTable(
  "sender_rules",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    senderDomain: text("sender_domain"),
    senderEmail: text("sender_email"),
    action: senderRuleActionEnum("action").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sender_rules_owner_domain_idx").on(t.ownerUserId, t.senderDomain),
    uniqueIndex("sender_rules_owner_email_idx").on(t.ownerUserId, t.senderEmail),
  ],
);
