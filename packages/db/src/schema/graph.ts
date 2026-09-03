import { pgTable, text, timestamp, real, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { households } from "./household";
import { connections } from "./connectors";
import { sensitivityTierEnum, visibilityEnum, confidenceBandEnum, verificationStateEnum } from "./common";
import { encryptedText, encryptedJsonb } from "./encrypted-type";

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
    providerItemId: encryptedText("provider_item_id"),
    contentHash: text("content_hash").notNull(), // a hash, not content, and dedup logic doesn't compare it directly
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    rawContentRef: encryptedText("raw_content_ref"),
    // Deliberately NOT full body text — the spec's "evidence view" ("why am I seeing this?") only needs
    // enough to recognize the source, not a durable copy of the whole message, which would meaningfully
    // grow this table's privacy/retention surface for no proportionate benefit. Populated at ingest time
    // from ParsedEmail (services/api/src/modules/ingestion/gmail-message-parser.ts) — previously parsed
    // into memory and then discarded once classification finished, so no evidence was ever retrievable
    // after the fact.
    subjectLine: encryptedText("subject_line"),
    snippet: encryptedText("snippet"),
    fromAddress: encryptedText("from_address"),
    // §52.1 "voice note" transcription — the local Whisper transcript of a voice_note's audio (see
    // IngestionService.processVoiceTranscription). Unlike `snippet` (a short, non-authoritative recognition
    // aid), this is the full transcribed text actually fed into `classifyAndExtract` — kept as its own
    // column rather than overloading `snippet` so a transcript longer than `snippet`'s ~200-char convention
    // is never silently truncated, and so "not yet transcribed" (null) stays distinguishable from "a real,
    // if short, transcript." Only ever populated for `kind: "voice_note"` source events.
    transcript: encryptedText("transcript"),
    sensitivity: sensitivityTierEnum("sensitivity").notNull().default("sensitive"),
    processingState: text("processing_state").notNull().default("queued"),
    idempotencyKey: text("idempotency_key").notNull(),
    // MAIL-005 "Sender/template parsers" — "Versioned parser registry identifies sender/domain/template."
    // Until now `matchKnownSender`'s deterministic domain-match result (services/api/src/modules/
    // intelligence/deterministic-prefilter.ts) had no version tracked anywhere, so a future change to that
    // hardcoded-domain matching logic could never be distinguished, after the fact, from an AI-classified
    // event or an older version of the same deterministic logic. Set only when `matchKnownSender` actually
    // matched (see IngestionService.classifyAndExtract) — an AI-classified or sender-rule-forced event
    // leaves this null, since neither of those go through matchKnownSender's field extraction at all.
    parserVersion: integer("parser_version"),
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
  locator: text("locator").notNull(), // a pointer/citation into the source, not quoted content itself
  excerpt: encryptedText("excerpt"),
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
    displayLabel: encryptedText("display_label").notNull(),
    sensitivity: sensitivityTierEnum("sensitivity").notNull().default("sensitive"),
    visibility: visibilityEnum("visibility").notNull().default("private"),
    aliases: encryptedJsonb<string[]>("aliases", []).notNull().default([]),
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
  // The lineage record itself is kept (it's an audit trail, not this user's private data) even after
  // the actor deletes their account — only the identifying link is cleared.
  actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
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
    predicate: text("predicate").notNull(), // categorical/structural — part of the lookup index below
    valueJson: encryptedJsonb<unknown>("value_json", null).notNull(),
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
