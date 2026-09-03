import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { encryptedText, encryptedJsonb } from "./encrypted-type";

/** Immutable audit trail (§ "AUDIT LOG"). Never mutated or deleted except by documented retention policy. */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    actorType: text("actor_type").notNull(), // "user" | "system" | "service" | "support_agent"
    actorId: text("actor_id"),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    beforeJson: encryptedJsonb<unknown>("before_json", null),
    afterJson: encryptedJsonb<unknown>("after_json", null),
    automationRuleId: text("automation_rule_id"),
    result: text("result").notNull(), // "success" | "failure" | "denied"
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_events_resource_idx").on(t.resourceType, t.resourceId),
    index("audit_events_actor_idx").on(t.actorType, t.actorId),
  ],
);

/** §AI-003 prompt-injection defense telemetry. */
export const promptSecurityEvents = pgTable("prompt_security_events", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  sourceEventId: text("source_event_id"),
  kind: text("kind").notNull(), // "instruction_like_content_blocked" | "agent_policy_violation_prevented"
  detail: encryptedText("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
