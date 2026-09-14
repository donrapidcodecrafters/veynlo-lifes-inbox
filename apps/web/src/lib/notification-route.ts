/**
 * Where a notification leads on web.
 *
 * Mobile already has this mapping, for push taps: `apps/mobile/src/lib/push-deep-link.ts`. Web has no
 * push, so it never needed one — which is why the notification history was a list of things you could read
 * and not act on, and why `openedAt` could never be set for a web user at all. The rendered "· Opened
 * <when>" line was unreachable on this platform.
 *
 * Kept as its own module rather than inline in the page so the two platforms' mappings are comparable
 * side by side when a resource type is added, instead of one silently falling behind the other.
 *
 * The route shapes are web's, not mobile's: the same `bill` resource is `/bill/:id` on the phone and
 * `/life/bills/:id` here.
 */

const DETAIL_ROUTE_BY_RESOURCE_TYPE: Record<string, string> = {
  bill: "/life/bills",
  calendar_event: "/life/events",
  // Ingestion sets this alongside a calendar event id, so it opens the same screen as calendar_event.
  school_event: "/life/events",
  health_appointment: "/life/health-appointments",
  identity_record: "/life/identity",
  person: "/life/people",
  pet: "/life/pets",
  property: "/life/properties",
  vehicle: "/life/vehicles",
  purchase: "/life/purchases",
  return_case: "/life/returns",
  saved_memory: "/saved",
  shipment: "/life/shipments",
  subscription: "/life/subscriptions",
  trip: "/trips",
  warranty: "/life/warranties",
};

/**
 * Resource types with no per-id page, but an obviously correct place to land. Better than Home, because
 * the user still arrives where the thing lives.
 */
const SECTION_ROUTE_BY_RESOURCE_TYPE: Record<string, string> = {
  task: "/timeline",
  schedule_conflict: "/timeline",
  // A segment id is not a trip id, so this goes to the list rather than to a detail page it cannot address.
  trip_segment: "/trips",
  inbox_item: "/inbox",
  automation_run: "/automations",
  legacy_release_config: "/settings/sharing",
  document: "/documents",
};

/** Home — the deliberate landing place for a known resource type with no page its id can open. */
export const NOTIFICATION_FALLBACK_ROUTE = "/home";

/**
 * The route a notification should open, or null when it names no destination — the daily and weekly
 * briefs genuinely have no single target, and sending those to an arbitrary page would be worse than
 * leaving the row inert.
 */
export function resolveNotificationRoute(
  resourceType: string | null | undefined,
  resourceId: string | null | undefined,
): string | null {
  // A half-populated target is worse than none: routing on type alone yields "/life/bills/undefined".
  if (!resourceType || !resourceId) return null;

  const detail = DETAIL_ROUTE_BY_RESOURCE_TYPE[resourceType];
  if (detail) return `${detail}/${encodeURIComponent(resourceId)}`;

  const section = SECTION_ROUTE_BY_RESOURCE_TYPE[resourceType];
  if (section) return section;

  return NOTIFICATION_FALLBACK_ROUTE;
}
