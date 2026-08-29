import { pgTable, text, timestamp, boolean, real, index } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { households } from "./household";
import { encryptedText, encryptedJsonb } from "./encrypted-type";

/**
 * SAVE-001/SAVE-002 "universal saved-item model" — one destination for anything a user wants to
 * remember without forcing a filing decision at capture time (a link, a note, a place, a product),
 * distinct from `saved_queries` (a reusable Ask question) and from the Inbox/ingestion pipeline (which
 * always tries to classify into a domain object — a purchase, a bill, an appointment). A Saved Item is
 * deliberately allowed to stay uncategorized forever. `category` defaults to "generic" and is only ever
 * filled in by AI classification when configured (SAVE-002) — never required at save time, per spec.
 * `resurfacing_rules`/`embeddings`/full `lists` infrastructure from the spec's fuller model are Plus+
 * ("advanced resurfacing") or out of this pass's bounded scope — see docs/ROADMAP.md.
 */
export const savedItems = pgTable(
  "saved_items",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    title: encryptedText("title").notNull(),
    url: encryptedText("url"),
    note: encryptedText("note"),
    category: text("category").notNull().default("generic"),
    // LOC-001 "basic saved places" — the spec's own entitlement line is "Plus; basic saved places Core",
    // so only plain save/view is in scope here (no geofencing/arrive-leave triggers, which are the Plus
    // part). Reuses this same generic model (category: "place") rather than a separate places table —
    // there's nothing place-specific enough yet to justify one. `address` is encrypted (a home/work
    // address is real personal data); lat/lng aren't (meaningless without the address to give them
    // context, and this app has no location-based feature yet that would query by proximity).
    latitude: real("latitude"),
    longitude: real("longitude"),
    address: encryptedText("address"),
    tags: encryptedJsonb<string[]>("tags").notNull().default([]),
    pinned: boolean("pinned").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("saved_items_owner_archived_idx").on(t.ownerUserId, t.archived)],
);
