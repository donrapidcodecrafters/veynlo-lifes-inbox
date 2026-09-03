import { pgTable, text, timestamp, boolean, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./identity";

/**
 * §37.2 "Desktop requirements" (DSK-001..008) — the spec names four tables (`desktop_device_settings`,
 * `local_cache_manifest`, `deep_link_routes`, `batch_actions`) as the shared "Primary data / state" for
 * every DSK-* item. `apps/desktop/src-tauri` (Tauri) now has real native-bridge code for a subset of these
 * items — a system tray, a global-hotkey quick-capture window, native OS notifications mirroring the
 * existing policy engine, and file-drop/file-association document upload (see that crate's `src/lib.rs`
 * and its README for exactly what's built and verified). These four tables are added here because the
 * spec names them explicitly, but each one's columns are scoped honestly to what's actually built and
 * wired today — see each table's own doc comment for what is and isn't yet read/written by real code, so
 * this file doesn't quietly overstate the native bridge's real feature surface.
 */

/**
 * DSK-001/002/006 "configure cache/notifications" per device. One row per (user, device) — a desktop
 * install identifies itself with a stable `deviceId` (not yet generated/sent by any client; there is no
 * settings endpoint or UI wired to this table yet). `notificationsEnabled` and `quickCaptureShortcut`
 * mirror the two real, built device-level native-bridge features (DSK-006's notification poller and
 * DSK-002's global shortcut in `apps/desktop/src-tauri/src/lib.rs`) — both currently hardcoded in that
 * crate (the poller always runs, the shortcut is always `CmdOrCtrl+Shift+I`) rather than read from here;
 * this table is the structural home for making either one user-configurable later, not a currently
 * consumed setting. Deliberately does NOT include a `paneWidth`/`lastView` column (DSK-001's own "persist
 * pane width and last view per device") — that's `apps/web`'s existing UI state, not something this pass's
 * native bridge introduced or has any server-side persistence for.
 */
export const desktopDeviceSettings = pgTable(
  "desktop_device_settings",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceId: text("device_id").notNull(),
    notificationsEnabled: boolean("notifications_enabled").notNull().default(true),
    quickCaptureShortcut: text("quick_capture_shortcut").notNull().default("CmdOrCtrl+Shift+I"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("desktop_device_settings_user_device_idx").on(t.userId, t.deviceId)],
);

/**
 * DSK-001/007 "local cache old" / "user can choose cache size and clear local data." The offline cache
 * itself (DSK-007) was NOT built this pass — the desktop shell has no local data cache or sync mechanism,
 * only the always-online webview around `apps/web` plus the native-bridge pieces documented in
 * `desktopDeviceSettings` above. This table is added because the spec names it as required state for
 * every DSK-* item, structurally shaped for whenever real offline caching exists; nothing currently writes
 * to it.
 */
export const localCacheManifest = pgTable(
  "local_cache_manifest",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceId: text("device_id").notNull(),
    cacheSizeLimitBytes: integer("cache_size_limit_bytes"),
    cachedItemCount: integer("cached_item_count"),
    lastRefreshedAt: timestamp("last_refreshed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("local_cache_manifest_user_device_idx").on(t.userId, t.deviceId)],
);

/**
 * DSK-008 "lifeinbox:// / universal/app links open exact item/query/settings securely... Links do not
 * encode secrets; server resolves authorization." A real, OS-level `lifeinbox://` custom URL-scheme
 * handler was NOT registered this pass (`apps/desktop/src-tauri`'s `tauri.conf.json` has no URL-scheme
 * registration, and `lib.rs`'s `RunEvent::Opened` handler — added for DSK-003 file-association opens —
 * only ever resolves `file://` URLs today, never a `lifeinbox://` one). This is a routing-RULE registry
 * (one row per link kind, not per link instance) rather than per-user data: it's the "which kind of link
 * maps to which real web-app path" table a real handler would consult once built, in the same spirit as
 * the already-real, stateless `signed-deep-link.ts` HMAC mechanism (`services/api/src/common/`, built for
 * §36's widget deep links) that already proves the "server resolves authorization, link carries no secret"
 * half of this requirement — a real `lifeinbox://` handler would mint the same kind of signed token and
 * look up its route kind here rather than duplicating that signing logic.
 */
export const deepLinkRoutes = pgTable(
  "deep_link_routes",
  {
    id: text("id").primaryKey(),
    // e.g. "item" | "query" | "settings" — DSK-008's own three named link kinds.
    routeKind: text("route_kind").notNull().unique(),
    // e.g. "bill" | "document" | "inbox_item" — only meaningful for the "item" kind; null otherwise.
    resourceType: text("resource_type"),
    // e.g. "/life/bills/:id" — resolved against `resourceType`/an id extracted from the (future) signed
    // token, never a raw client-supplied path.
    webPathTemplate: text("web_path_template").notNull(),
    requiresAuth: boolean("requires_auth").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

/**
 * DSK-004 "safe batch actions... High-risk/destructive batch has preview and count" + this chapter's own
 * "bulk efficiency" analytics signal. Bulk actions themselves already exist and are real (Documents bulk-
 * delete, Inbox bulk-confirm/dismiss — `services/api/src/modules/documents`, `.../inbox`, both already
 * count-and-confirm on the destructive path per the web UI) but neither endpoint writes to this table yet
 * — doing so would mean touching `services/api` beyond this pass's desktop-app scope. This table is the
 * structural audit/analytics log the spec names, ready for wiring: one row per batch action a user
 * actually ran, not a preview/dry-run (a preview never becomes a row here until confirmed).
 */
export const batchActions = pgTable(
  "batch_actions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // e.g. "bulk_delete_documents" | "bulk_confirm_inbox" | "bulk_dismiss_inbox".
    actionKind: text("action_kind").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceIds: jsonb("resource_ids").$type<string[]>().notNull(),
    affectedCount: integer("affected_count").notNull(),
    outcome: text("outcome").notNull(), // "completed" | "failed" | "partial"
    performedAt: timestamp("performed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("batch_actions_user_idx").on(t.userId, t.performedAt)],
);
