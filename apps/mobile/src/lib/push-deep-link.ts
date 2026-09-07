/**
 * Maps a push notification's payload to the screen it is about.
 *
 * Before this existed, tapping ANY push cold-launched the app to the Home tab regardless of what the
 * notification said — the server never sent a data payload and the app never listened for a tap. The
 * server now stores `linkedResourceType`/`linkedResourceId` on the notification row and ships them in the
 * push's `data` (see NotificationDeliveryService.deliver and PushService.send).
 *
 * WHY A MAP AND NOT A TEMPLATE: the API produces 30 distinct `linkedResourceType` values, but only some
 * of them carry an id that actually addresses a mobile detail route. `trip_segment`, for instance, carries
 * a SEGMENT id while the only trip screen is keyed by trip id, and `recall_match` carries a recall-match
 * id with no screen of its own at all. Deriving `/${resourceType}/${resourceId}` would send those to a
 * route that cannot load. Every entry below was verified against the route's own fetch call — e.g.
 * `saved_memory` maps to `/saved-item/[id]` because that screen fetches `/v1/memories/{id}` and
 * `resurfacing_rules.saved_memory_id` is a foreign key to `saved_memories.id`.
 *
 * Anything not listed falls back to Home, which is where the Needs-You queue lives — the same place these
 * items are surfaced anyway, and no worse than the behaviour this replaces.
 */

/** The `data` payload PushService attaches. Both resource fields are absent for the daily/weekly briefs. */
export interface PushDeepLinkData {
  notificationId?: string;
  resourceType?: string;
  resourceId?: string;
}

/** Home. Also the deliberate fallback for a resource type with no screen that its id can open. */
export const PUSH_FALLBACK_ROUTE = "/(tabs)";

/**
 * Resource types whose id addresses a detail route directly. The value is the route's directory, so the
 * destination is `/${prefix}/${resourceId}`.
 *
 * Verified against each screen's own request: bills→/v1/bills, events→/v1/events, documents→/v1/documents,
 * health-appointment→/v1/health, identity-records→/v1/identity-records, purchases→/v1/purchases,
 * returns→/v1/returns, shipments→/v1/shipments, subscriptions→/v1/subscriptions, warranties→/v1/warranties,
 * trips→/v1/trips, memories→/v1/memories.
 */
const DETAIL_ROUTE_BY_RESOURCE_TYPE: Record<string, string> = {
  bill: "/bill",
  calendar_event: "/event",
  // Ingestion sets this alongside a calendar event id (ingestion.service.ts passes `eventId`), so it opens
  // the same screen as calendar_event rather than needing a school-specific one.
  school_event: "/event",
  document: "/document",
  health_appointment: "/health-appointment",
  identity_record: "/identity-record",
  person: "/person",
  purchase: "/purchase",
  return_case: "/return-case",
  saved_memory: "/saved-item",
  shipment: "/shipment",
  subscription: "/subscription",
  trip: "/trip",
  warranty: "/warranty",
};

/**
 * Resource types with no per-id screen, but with an obviously correct list/section to land on. Better than
 * Home because the user still arrives where the thing lives.
 *
 * `task` and `schedule_conflict` go to Timeline because there is no task detail route. `trip_segment`
 * goes to the trips list rather than `/trip/[id]` precisely because its id is a segment id, not a trip id.
 */
const SECTION_ROUTE_BY_RESOURCE_TYPE: Record<string, string> = {
  task: "/timeline",
  schedule_conflict: "/timeline",
  trip_segment: "/trips",
  inbox_item: "/(tabs)/inbox",
  automation_run: "/automations",
  legacy_release_config: "/sharing",
};

/**
 * Resolves the route a push tap should open, or null when the payload names no destination (the briefs)
 * and the caller should simply leave the user wherever the app opened.
 *
 * Returns `PUSH_FALLBACK_ROUTE` — not null — for a KNOWN-BUT-UNROUTABLE resource type, so a recall or a
 * store-credit reminder still lands on the Needs-You queue rather than being silently ignored.
 */
export function resolvePushRoute(data: PushDeepLinkData | null | undefined): string | null {
  if (!data) return null;
  const { resourceType, resourceId } = data;

  // A half-populated target is worse than none: routing on type with no id yields "/bill/undefined".
  if (!resourceType || !resourceId) return null;

  const detail = DETAIL_ROUTE_BY_RESOURCE_TYPE[resourceType];
  if (detail) return `${detail}/${encodeURIComponent(resourceId)}`;

  const section = SECTION_ROUTE_BY_RESOURCE_TYPE[resourceType];
  if (section) return section;

  return PUSH_FALLBACK_ROUTE;
}
