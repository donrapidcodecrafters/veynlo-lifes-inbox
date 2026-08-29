import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { encryptedText } from "./encrypted-type";

/**
 * TIME-002 "Object history" — the "Add note" user action. `resourceType`/`resourceId` form the same
 * polymorphic reference pattern already used by `resourceGrants`/`shareLinks` (packages/db/src/schema/
 * household.ts) rather than a dedicated FK per domain, since a note can attach to any of purchase/bill/
 * warranty/return_case/subscription/calendar_event.
 */
export const objectNotes = pgTable(
  "object_notes",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    noteText: encryptedText("note_text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("object_notes_resource_idx").on(t.resourceType, t.resourceId)],
);
