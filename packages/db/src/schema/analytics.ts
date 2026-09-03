import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { households } from "./household";

/**
 * §48 "Product Analytics, Experimentation & Growth" — first-party, no-paid-vendor behavioral event log.
 * This is deliberately a NEW concept, distinct from `auditEvents`/`promptSecurityEvents` (audit.ts): those
 * are security/compliance trails ("who did what to which resource, for support/incident-response
 * purposes"); this is product-behavior analytics for computing §48.1's north-star/activation/engagement/
 * retention metrics. Before this table, no such system existed anywhere in the codebase — confirmed by
 * grep, this app had zero product-analytics events despite `audit_events` existing since early on.
 *
 * §48.2 "Analytics event rules" is the privacy contract this table exists to enforce structurally, not
 * just by convention — read both rules below before adding a new call site:
 *   - "Analytics events record product behavior, not raw private payloads... not email subject/body/order
 *     item names unless separately justified... Never send full financial transaction descriptions, health
 *     notes, identity numbers, precise location trails or private document text to general analytics." —
 *     `properties` is a small flat bag of structured metadata (enums, counts, booleans, short ids), never a
 *     copy of message/document content. `AnalyticsService.track` is the ONLY writer and is the enforcement
 *     point (see its `sanitizeAnalyticsProperties` — rejects long strings, `@`-containing strings, and any
 *     key that even looks like it could carry a name/address/body/note/transcript/etc.). This mirrors
 *     `source_events`' own established discipline of storing a hash/short snippet, never the raw thing
 *     itself (see graph.ts's `sourceEvents.contentHash`/`subjectLine` doc comments).
 *   - "User/household IDs are pseudonymous warehouse keys; avoid exporting direct email/phone/name." —
 *     `userId`/`householdId` are this codebase's own opaque generated ids (`usr_...`/`hh_...` via
 *     `generateId`), already exactly the "pseudonymous warehouse key" the spec describes — never the raw
 *     email/phone/name a real user typed in. No additional hashing needed on top of that existing opacity.
 *
 * Cascades with the owning user (like `sourceEvents.ownerUserId`) rather than being retained forever like
 * the immutable audit log — a deletion request (§9 launch criteria: "export/deletion workflows cover
 * canonical DB...") removes this user's behavioral history along with everything else, since (unlike the
 * audit log) it isn't a security/compliance record with its own independent retention justification.
 */
export const productEvents = pgTable(
  "product_events",
  {
    id: text("id").primaryKey(),
    // Free text, not a DB enum — §48 Appendix F's event taxonomy is expected to keep growing over the
    // app's lifetime, and a pgEnum would need a migration for every new event name. Matches
    // `auditEvents.action`/`resourceType`'s own identical text-not-enum choice for the same reason.
    // `AnalyticsService`'s `PRODUCT_EVENT_NAMES` is the actual closed vocabulary enforced in code.
    eventName: text("event_name").notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    // "web" | "mobile" | "admin" | "server" — see services/api/src/modules/analytics/analytics.service.ts's
    // `AnalyticsPlatform`. Coarser than `devices.platform`'s ios/android/web/macos/windows/extension split —
    // product analytics only needs to distinguish "phone app" vs "browser" vs "internal", not exact OS.
    platform: text("platform").notNull(),
    // Deliberately plain (not encrypted) jsonb, unlike e.g. `auditEvents.beforeJson`/`afterJson` — those can
    // legitimately hold a full sensitive resource snapshot; this column's entire contract (enforced by
    // `AnalyticsService.track`, see above) is that nothing sensitive is ever allowed into it in the first
    // place, so there is nothing here that needs encryption-at-rest beyond the table's own row-level
    // security posture, and admin aggregation queries (count/group-by) need to run directly in SQL.
    properties: jsonb("properties").$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("product_events_name_time_idx").on(t.eventName, t.occurredAt),
    index("product_events_user_idx").on(t.userId),
    index("product_events_household_idx").on(t.householdId),
  ],
);
