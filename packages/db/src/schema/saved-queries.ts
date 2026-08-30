import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
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

/**
 * §46 entitlement enforcement — `ask_queries_per_day` was defined in `PLAN_CATALOG` with nothing anywhere
 * counting real Ask usage against it. A plain append-only occurrence log (not the question/answer
 * content itself — that's not needed for rate-limiting and would just be a second, unnecessary copy of
 * sensitive user content to protect) — one row per real `POST /v1/ask` call, counted over a rolling 24h
 * window rather than a calendar-day one so the cap can't be trivially doubled by asking right before and
 * right after local midnight.
 */
export const askQueryLog = pgTable(
  "ask_query_log",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ask_query_log_owner_occurred_idx").on(t.ownerUserId, t.occurredAt)],
);
