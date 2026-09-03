import { pgTable, text, timestamp, boolean, integer, jsonb, pgEnum, index } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { households } from "./household";
import { encryptedText } from "./encrypted-type";

/**
 * FAM-005 "Shared lists" (spec: "Groceries, packing, household maintenance, gifts, school supplies,
 * trip prep and custom lists... Items can be assigned, checked, linked to saved product/purchase, and
 * private when needed"). Table names/id prefixes ("list", "savedItem") were already reserved in
 * `packages/core/src/util/ids.ts` before this feature existed — same kind of pre-scaffolded-but-unbuilt
 * state `packages/authz` turned out to be, except here the scaffolding actually matches the spec's own
 * data model well: a `savedItem` is exactly what an item on a list is (spec's own wording: "linked to
 * saved product/purchase"), so this reuses rather than replaces it.
 */
export const listKindEnum = pgEnum("list_kind", [
  "grocery",
  "packing",
  "household_maintenance",
  "gift",
  "school_supplies",
  "trip_prep",
  "custom",
]);

export const lists = pgTable(
  "lists",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Null householdId = private, personal list. Non-null = shared with the household per FAM-006's
    // existing delegation-scoped visibility model (see ListsService.ownerOrDelegatedHousehold), same
    // pattern as calendar_events/tasks/documents already use for "owner vs household-shared" data.
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    name: encryptedText("name").notNull(),
    kind: listKindEnum("kind").notNull().default("custom"),
    // §29.1 SAVE-003 "Smart lists" — "A smart list stores query criteria; manual lists store membership;
    // both can coexist." Extends this existing table rather than a parallel `smart_lists` table: a smart
    // list is still fundamentally "a named list a user opens," it just has no `savedItems` rows of its own
    // — non-null here means MemoriesService.evaluateSmartQuery computes its contents live from
    // `saved_memories` (see memories.ts) matching this criteria, instead of ListsService reading
    // `savedItems`. Plain jsonb (not encrypted): criteria (category/personLabel/price bounds/text) are
    // query parameters ListsService/MemoriesService need to read on every list-detail request, not private
    // content in their own right — see MemoriesSmartListQuerySchema (modules/memories/dto.ts) for the shape.
    smartListQuery: jsonb("smart_list_query").$type<Record<string, unknown> | null>(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("lists_owner_idx").on(t.ownerUserId), index("lists_household_idx").on(t.householdId)],
);

export const savedItems = pgTable(
  "saved_items",
  {
    id: text("id").primaryKey(),
    listId: text("list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    // `set null`, not cascade — a saved item on a SHARED household list is collaborative content, not
    // solely the creator's private data (list ownership/sharing lives on `lists.householdId`, not here).
    // Before this fix it cascaded, so a household member who added something to a shared grocery/packing/
    // gift list and later deleted their own account silently deleted that item from the WHOLE household's
    // list too, not just their own data — the exact "account deletion cascades away collaborative content"
    // bug class this session already found and fixed for voice-note blobs. Matches the sibling
    // `checkedByUserId`/`assignedToUserId` columns just below, which were already `set null` for the same
    // reason. `isPrivate` items whose creator is gone stay effectively invisible (no one's `userId` can
    // ever equal `null`), which is the same safe default as before — only the non-private, shared-item
    // data-loss case is what this changes.
    createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    label: encryptedText("label").notNull(),
    checked: boolean("checked").notNull().default(false),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    checkedByUserId: text("checked_by_user_id").references(() => users.id, { onDelete: "set null" }),
    assignedToUserId: text("assigned_to_user_id").references(() => users.id, { onDelete: "set null" }),
    // Polymorphic, deliberately unconstrained — same "linked_resource_type/id, no FK" precedent as
    // inbox_items and automation_runs.trigger_evidence_id. Spec: "linked to saved product/purchase" —
    // today's real linkable kinds are "purchase" and "priceObservation" (browser extension product
    // capture), but this stays generic rather than a fixed enum, matching every other polymorphic ref.
    linkedResourceType: text("linked_resource_type"),
    linkedResourceId: text("linked_resource_id"),
    // Spec: "private when needed" — a private item on an otherwise-shared household list is visible only
    // to the user who added it (e.g. a surprise gift on a shared household gift list), enforced in
    // ListsService, not here.
    isPrivate: boolean("is_private").notNull().default(false),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("saved_items_list_idx").on(t.listId)],
);
