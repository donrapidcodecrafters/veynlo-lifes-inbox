import { pgTable, text, timestamp, boolean, real, integer, jsonb, pgEnum, index } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { documents } from "./documents";
import { encryptedText, encryptedJsonb } from "./encrypted-type";

/**
 * §29.1 "Universal saved-item model" (spec SAVE-001..007). Deliberately a SEPARATE table from
 * `lists`/`savedItems` (schema/lists.ts) — those two tables back FAM-005 "Shared lists" (grocery/packing/
 * gift/etc. checklists with plain household sharing), a narrower, already-shipped feature. A Saved Memory
 * is a different, larger concept: "one destination for anything a user intentionally wants to remember,
 * without forcing a filing decision at capture time" — a link/screenshot/note/product with AI
 * classification, semantic-ish search, and contextual resurfacing, closer in spirit to this app's
 * `canonical_entities` knowledge graph (schema/graph.ts) than to a checklist. Reusing/repurposing
 * `savedItems` here would have broken the already-tested Lists feature built earlier this session.
 */
export const memorySourceKindEnum = pgEnum("memory_source_kind", [
  "link",
  "screenshot",
  "image",
  "text",
  "document",
  "place",
  "product",
  "recipe",
  "event",
  "video",
  "note",
]);

export const memoryCategoryEnum = pgEnum("memory_category", [
  "product",
  "place",
  "recipe",
  "article",
  "movie_show",
  "gift_idea",
  "event",
  "trip_idea",
  "how_to",
  "reference",
  "document",
  "generic",
]);

/** SAVE-001 "Immediate success confirmation; structure may appear seconds later" — a save always
 * persists synchronously; classification is a deferred, best-effort enrichment pass (mirrors
 * IngestionService's own stage split). "skipped" is the honest terminal state when no AI provider is
 * configured on this deployment (same posture as DocumentsService.upload's `isPlainText`/`ai.isConfigured`
 * branching) — never silently stuck at "pending" forever with no explanation. */
export const memoryClassificationStateEnum = pgEnum("memory_classification_state", ["pending", "classified", "failed", "skipped"]);

export const savedMemories = pgTable(
  "saved_memories",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceKind: memorySourceKindEnum("source_kind").notNull(),
    // A URL can itself be sensitive (a private doc-share link, an account page) — encrypted like every
    // other free-text field of comparable sensitivity elsewhere in this schema (e.g. calendarEvents.location).
    sourceUrl: encryptedText("source_url"),
    // Binary content (screenshot/image/uploaded document) reuses the EXISTING Documents/object-storage
    // pipeline (services/api/src/modules/documents) rather than a parallel blob store — this just points
    // at the resulting document row. `set null`, not cascade: deleting the underlying document (a right
    // documents.controller already exposes) shouldn't silently delete the whole memory/notes/classification
    // around it, same "don't cascade away the surrounding record" reasoning as savedItems.createdByUserId.
    sourceDocumentId: text("source_document_id").references(() => documents.id, { onDelete: "set null" }),
    // Pasted text / a freeform note body, or a short snippet captured from a page at save time — the raw
    // material the classifier reads (subject to the same untrusted-content injection-defense framing as
    // ingested email; see memories.service.ts's SAVED_CONTENT_INJECTION_DEFENSE_PREFIX).
    rawText: encryptedText("raw_text"),
    title: encryptedText("title"),
    // SAVE-006 "why I saved this" — private annotation, first-class searchable content.
    userNotes: encryptedText("user_notes"),
    // SAVE-006 "tags, ratings, highlights" — the concrete, common cases the spec names (a full
    // arbitrary-schema "custom fields" concept is a deliberate stretch too far for this pass). All three
    // follow the exact same privacy discipline as `userNotes` above: never shown to a non-owner grant
    // recipient, never in a public share-link view — see MemoriesService.redactNotesForNonOwner, extended
    // to redact these alongside notes. Encrypted like `tags` on `documents` (same precedent, same
    // reasoning: short user-authored labels/quotes are still content, not metadata SQL ever needs to
    // filter by — nothing in this codebase queries saved-memory tags/highlights by path).
    tags: encryptedJsonb<string[]>("tags", []).notNull().default([]),
    // 1-5 star rating, user-set only (never inferred/classified) — a nullable integer, not a column with a
    // default of e.g. 0, since "never rated" must stay distinguishable from "rated 0" (a rating scale this
    // spec describes has no zero).
    rating: integer("rating"),
    // Free-text quoted passages the user wants to remember from a saved article/page — plural, ordered
    // list, append/remove managed entirely by MemoriesService.update (no separate highlights table: this
    // is a small, owner-only, unindexed list, the same shape `tags` already is here and on `documents`).
    highlights: encryptedJsonb<string[]>("highlights", []).notNull().default([]),
    category: memoryCategoryEnum("category"),
    categoryConfidence: real("category_confidence"),
    // Structured fields the classifier pulls out (price/currency/location label today — see
    // MemoryClassificationSchema). Encrypted, not plain jsonb like search_documents.metadata: unlike that
    // table (built specifically to be queried by SQL and never actually wired to anything — confirmed by
    // grep, zero real read sites exist anywhere in this codebase), every real read path here (smart lists,
    // resurfacing, search) already fetches this owner's own bounded row set and filters in application code
    // — the same "decrypt then filter in app code" shape structuredSearch/ask use for encrypted
    // purchases/bills/documents columns — so there's no query-pushdown to give up by encrypting it, and
    // "price paid for a specific gift" is exactly the kind of detail worth keeping ciphertext-at-rest.
    extractedFields: encryptedJsonb<Record<string, unknown>>("extracted_fields", {}).notNull().default({}),
    // Free-text person label (e.g. "Dad"), either user-entered or classifier-suggested for a gift-idea save
    // — deliberately NOT a resolved canonical_entities/dependent_profiles FK. Resolving "Dad" to a specific
    // person is exactly the kind of entity-resolution judgment call this app already treats as a real,
    // separate problem elsewhere (merchant merge/entity-resolution work earlier this session) — out of
    // scope here. Smart lists ("gift ideas for Dad") and the birthday resurfacing trigger both match this
    // against a household dependent's display name via simple case-insensitive substring comparison instead.
    relatedPersonLabel: encryptedText("related_person_label"),
    classificationState: memoryClassificationStateEnum("classification_state").notNull().default("pending"),
    // §28 encryption-inventory sweep — sits beside rawText/title/userNotes/extractedFields (all encrypted
    // above) in the same table; the classifier's caught-error message (memories.service.ts sets this from
    // `String((err as Error)?.message ?? err)`) can echo fragments of the user's own saved content.
    classificationError: encryptedText("classification_error"),
    // sha256 of the normalized source (URL, or raw text) — a hash, not content, same "dedup logic doesn't
    // compare content directly" precedent as sourceEvents.contentHash. Used only for the SAVE-001 "duplicate
    // save" edge case (MemoriesService.create checks this before inserting); plain, not encrypted — a hash
    // reveals nothing about the underlying content.
    contentHash: text("content_hash"),
    pinned: boolean("pinned").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    // SAVE-007 "never resurface automatically" — an explicit per-item opt-out the contextual/date resurfacing
    // scan must honor, independent of archival.
    neverResurface: boolean("never_resurface").notNull().default(false),
    // SAVE-007 "auto-archive after a condition" — the one condition realistically computable without a
    // bespoke rule language: a user-chosen date. ResurfacingService's scan archives past-due rows.
    autoArchiveAt: timestamp("auto_archive_at", { withTimezone: true }),
    // SAVE-001 "mark not useful" — a quality signal distinct from archiving (spec's own analytics section:
    // "resurfacing usefulness"); kept separate from archivedAt so a future resurfacing-ranking pass can read
    // it without conflating "no longer relevant" with "was actively wrong for me."
    notUsefulAt: timestamp("not_useful_at", { withTimezone: true }),
    // SAVE-001 "convert to task/event/object" — once the user acts on a save, this points at the resulting
    // canonical_entities row (or, pragmatically, any other domain id) they created from it. No FK: this is a
    // link to something the user built through that domain's OWN existing create endpoint (e.g. POST
    // /v1/events), not something MemoriesService creates itself — same "polymorphic, deliberately
    // unconstrained" precedent as savedItems.linkedResourceType/Id.
    promotedEntityType: text("promoted_entity_type"),
    promotedEntityId: text("promoted_entity_id"),
    lastResurfacedAt: timestamp("last_resurfaced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("saved_memories_owner_idx").on(t.ownerUserId),
    index("saved_memories_owner_category_idx").on(t.ownerUserId, t.category),
    index("saved_memories_owner_hash_idx").on(t.ownerUserId, t.contentHash),
  ],
);

/**
 * SAVE-004 "Contextual resurfacing." `date` and `person_birthday` are computable from data this app
 * already had before this feature (a plain date; household `dependentProfiles.birthDate`). `trip_location`
 * is evaluated against the Travel domain's `trips` table (packages/db/src/schema/travel.ts) — see
 * ResurfacingService.evaluateTripLocationRule for the match logic. `location_proximity` is evaluated
 * event-driven (not on the periodic scan tick like the other four) directly off a real on-device geofence
 * arrival — see LocationService.recordGeofenceEvent and ResurfacingService.fireLocationProximityResurfacing
 * — using the Location domain's own `places`/`geofences`/`geofenceEvents` tables
 * (packages/db/src/schema/location.ts), which already work today with zero external/paid dependency (see
 * docs/PHASE3_PENDING_CREDENTIALS.md's Location section). `query_based` is not a stored trigger row at
 * all — see MemoriesService.relatedForQuery's own doc comment for why "related saved items surfaced
 * alongside a search/ask the user is already doing" doesn't fit this table's "trigger fires independently
 * on its own schedule" shape.
 */
export const resurfacingRuleTriggerEnum = pgEnum("resurfacing_rule_trigger", ["date", "person_birthday", "trip_location", "location_proximity"]);

export const resurfacingRules = pgTable(
  "resurfacing_rules",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    savedMemoryId: text("saved_memory_id")
      .notNull()
      .references(() => savedMemories.id, { onDelete: "cascade" }),
    triggerType: resurfacingRuleTriggerEnum("trigger_type").notNull(),
    // Shape depends on triggerType: {date: "YYYY-MM-DD"} | {dependentProfileId: string, daysBefore: number} |
    // {locationLabel: string} | {placeId: string} (location_proximity — references `places.id`). Plain
    // jsonb (not encrypted) — a dependentProfileId/date/placeId is a reference/schedule detail, not
    // sensitive content in its own right, and ResurfacingService needs to query/read this cheaply on every
    // scan tick (or, for location_proximity, on every geofence arrival event).
    triggerConfig: jsonb("trigger_config").$type<Record<string, unknown>>().notNull().default({}),
    active: boolean("active").notNull().default(true),
    // Recurrence guard for yearly triggers (person_birthday): ResurfacingService only refiles once at least
    // ~300 days have passed since the last fire, so a birthday reminder recurs annually instead of firing
    // once and then being permanently deduped away by attention_items' own "any existing row for this
    // resource" check (see ResurfacingService's own doc comment).
    lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("resurfacing_rules_owner_idx").on(t.ownerUserId), index("resurfacing_rules_memory_idx").on(t.savedMemoryId)],
);
