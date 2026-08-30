import { pgTable, text, timestamp, integer, real, index } from "drizzle-orm/pg-core";
import { encryptedText, encryptedJsonb } from "./encrypted-type";

export const extractorVersions = pgTable("extractor_versions", {
  id: text("id").primaryKey(),
  stage: text("stage").notNull(),
  name: text("name").notNull(),
  version: text("version").notNull(),
  modelKey: text("model_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deprecatedAt: timestamp("deprecated_at", { withTimezone: true }),
});

export const extractionRuns = pgTable(
  "extraction_runs",
  {
    id: text("id").primaryKey(),
    sourceEventId: text("source_event_id").notNull(),
    stage: text("stage").notNull(),
    extractorVersionId: text("extractor_version_id")
      .notNull()
      .references(() => extractorVersions.id),
    status: text("status").notNull().default("pending"),
    costMinorUnits: integer("cost_minor_units"),
    latencyMs: integer("latency_ms"),
    outputJson: encryptedJsonb<unknown>("output_json"),
    errorDetail: encryptedText("error_detail"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  // Admin model-health dashboard scans a time window ordered by startedAt; the failed-run query filters by status.
  (t) => [index("extraction_runs_started_at_idx").on(t.startedAt), index("extraction_runs_status_started_idx").on(t.status, t.startedAt)],
);

/** Per-domain/field risk policy (§AI-002) — versioned so historical decisions stay explainable. */
export const riskPolicies = pgTable("risk_policies", {
  id: text("id").primaryKey(),
  domain: text("domain").notNull(),
  field: text("field").notNull(),
  autoAcceptThreshold: real("auto_accept_threshold").notNull(),
  reviewThreshold: real("review_threshold").notNull(),
  policyVersion: text("policy_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
