import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { encryptedText } from "./encrypted-type";

/** ASK-001 "save query" — a reusable Ask question a user wants to re-run later (e.g. "What bills are due this week?"), not a saved answer (answers are re-generated fresh each time it's re-asked, since the underlying data may have changed). */
export const savedQueries = pgTable("saved_queries", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  questionText: encryptedText("question_text").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
