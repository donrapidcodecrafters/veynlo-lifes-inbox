import { pgTable, text, timestamp, real, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { households } from "./household";
import { connections } from "./connectors";
import { sensitivityTierEnum, visibilityEnum, confidenceBandEnum, verificationStateEnum } from "./common";

export const sourceEvents = pgTable(
  "source_events",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    connectionId: text("connection_id").references(() => connections.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    providerItemId: text("provider_item_id"),
    contentHash: text("content_hash").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    rawContentRef: text("raw_content_ref"),
    sensitivity: sensitivityTierEnum("sensitivity").notNull().default("sensitive"),
    processingState: text("processing_state").notNull().default("queued"),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("source_events_idempotency_idx").on(t.ownerUserId, t.idempotencyKey),
    index("source_events_connection_idx").on(t.connectionId),
    index("source_events_owner_idx").on(t.ownerUserId),
  ],
);

export const evidenceRefs = pgTable("evidence_refs", {
  id: text("id").primaryKey(),
  sourceEventId: text("source_event_id")
    .notNull()
    .references(() => sourceEvents.id, { onDelete: "cascade" }),
  locator: text("locator").notNull(),
  excerpt: text("excerpt"),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
});

export const canonicalEntities = pgTable(
  "canonical_entities",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    displayLabel: text("display_label").notNull(),
    sensitivity: sensitivityTierEnum("sensitivity").notNull().default("sensitive"),
    visibility: visibilityEnum("visibility").notNull().default("private"),
    aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
    lifecycleState: text("lifecycle_state").notNull(),
    mergedIntoEntityId: text("merged_into_entity_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("canonical_entities_owner_type_idx").on(t.ownerUserId, t.type),
    index("canonical_entities_household_idx").on(t.householdId),
  ],
);

export const entityMergeLineage = pgTable("entity_merge_lineage", {
  id: text("id").primaryKey(),
  survivingEntityId: text("surviving_entity_id")
    .notNull()
    .references(() => canonicalEntities.id),
  mergedEntityId: text("merged_entity_id")
    .notNull()
    .references(() => canonicalEntities.id),
  reason: text("reason").notNull(),
  algorithmVersion: text("algorithm_version").notNull(),
  confidenceScore: real("confidence_score").notNull(),
  actorUserId: text("actor_user_id").references(() => users.id),
  mergedAt: timestamp("merged_at", { withTimezone: true }).notNull().defaultNow(),
  unmergedAt: timestamp("unmerged_at", { withTimezone: true }),
});

export const relationships = pgTable(
  "relationships",
  {
    id: text("id").primaryKey(),
    fromEntityId: text("from_entity_id")
      .notNull()
      .references(() => canonicalEntities.id, { onDelete: "cascade" }),
    toEntityId: text("to_entity_id")
      .notNull()
      .references(() => canonicalEntities.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validTo: timestamp("valid_to", { withTimezone: true }),
    confidenceScore: real("confidence_score"),
    sourceEventId: text("source_event_id").references(() => sourceEvents.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("relationships_from_idx").on(t.fromEntityId),
    index("relationships_to_idx").on(t.toEntityId),
  ],
);

export const facts = pgTable(
  "facts",
  {
    id: text("id").primaryKey(),
    subjectEntityId: text("subject_entity_id")
      .notNull()
      .references(() => canonicalEntities.id, { onDelete: "cascade" }),
    predicate: text("predicate").notNull(),
    valueJson: jsonb("value_json").notNull(),
    unit: text("unit"),
    extractionMethod: text("extraction_method").notNull(),
    extractorVersion: text("extractor_version").notNull(),
    confidenceScore: real("confidence_score").notNull(),
    confidenceBand: confidenceBandEnum("confidence_band").notNull(),
    verification: verificationStateEnum("verification").notNull().default("unverified"),
    evidenceIds: jsonb("evidence_ids").$type<string[]>().notNull().default([]),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    supersededByFactId: text("superseded_by_fact_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("facts_subject_predicate_idx").on(t.subjectEntityId, t.predicate)],
);
