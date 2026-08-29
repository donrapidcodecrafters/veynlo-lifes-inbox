import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./identity";

/**
 * MAIL-006 "user sender rules" (§8) — "always treat messages from this sender as X." Matched against
 * the exact sender address (not domain — a specific known address like "billing@service.com" is both
 * more precise and safer than blocking/recategorizing an entire domain, e.g. a shared consumer domain a
 * real contact also uses). Stays plaintext deliberately: matching happens against the just-parsed,
 * still-in-memory email at ingest time (never a DB-side query against an already-encrypted column, which
 * AES-GCM's non-deterministic IV would rule out anyway — see users.email for the same reasoning).
 */
export const senderRules = pgTable(
  "sender_rules",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    senderAddress: text("sender_address").notNull(),
    action: text("action").notNull(), // "block" | "category_override"
    categoryOverride: text("category_override"), // set only when action = "category_override"
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sender_rules_owner_address_idx").on(t.ownerUserId, t.senderAddress)],
);
