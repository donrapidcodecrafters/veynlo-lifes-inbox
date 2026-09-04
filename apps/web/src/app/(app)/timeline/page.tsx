"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FetchError } from "@/components/ui/fetch-error";

interface TimelineItem {
  id: string;
  kind:
    | "calendar_event"
    | "purchase"
    | "bill"
    | "document"
    | "task"
    | "return_case"
    | "warranty"
    | "school_event"
    | "trip_segment"
    | "pet_vaccination"
    | "pet_refill_reminder"
    | "health_appointment"
    | "health_refill_reminder";
  title: string;
  occurredAt: string;
  resourceType: string;
  resourceId: string;
}

interface TimelineResponse {
  items: TimelineItem[];
  nextCursor: string | null;
}

// These three maps are keyed by a union type, but their keys arrive from the API at runtime, so
// TypeScript cannot actually guarantee a match. Every read below is therefore done defensively with a
// fallback rather than indexed directly: a direct `KIND_HREF[item.kind](...)` on an unrecognised kind
// threw "p[e.kind] is not a function" mid-render, React unmounted the whole tree including the (app)
// layout, and the route became a bare "Application error" page with no content and — on mobile — no
// bottom nav, stranding the user. The server introducing a new timeline kind must degrade to a plain
// row, never break the screen.
const KIND_LABEL: Record<TimelineItem["kind"], string> = {
  calendar_event: "Event",
  purchase: "Purchase",
  bill: "Bill",
  document: "Document",
  task: "Task",
  return_case: "Return",
  warranty: "Warranty",
  school_event: "School",
  trip_segment: "Trip",
  pet_vaccination: "Pet",
  pet_refill_reminder: "Pet",
  health_appointment: "Health",
  health_refill_reminder: "Health",
};

const KIND_TONE: Record<TimelineItem["kind"], "info" | "positive" | "warning" | "neutral" | "critical"> = {
  calendar_event: "info",
  purchase: "positive",
  bill: "warning",
  document: "neutral",
  task: "info",
  return_case: "critical",
  warranty: "neutral",
  school_event: "info",
  trip_segment: "info",
  pet_vaccination: "neutral",
  pet_refill_reminder: "warning",
  health_appointment: "info",
  health_refill_reminder: "warning",
};

// school_event/health_appointment go to /life (no per-item detail page exists yet, same reasoning as
// `document` below) — trip_segment/pet_* use `resourceId`, which the service deliberately points at the
// parent trip/pet id (not the row's own id) so these link somewhere real: `/trips/:id` and `/life/pets/:id`
// both exist even though `/trip-segments/:id` and per-vaccination pages don't.
const KIND_HREF: Record<TimelineItem["kind"], (resourceId: string) => string> = {
  calendar_event: (id) => `/life/events/${id}`,
  purchase: (id) => `/life/purchases/${id}`,
  bill: (id) => `/life/bills/${id}`,
  return_case: (id) => `/life/returns/${id}`,
  warranty: (id) => `/life/warranties/${id}`,
  document: () => `/documents`, // no per-document detail page exists yet — the list is the closest real destination
  // Tasks surface on /life; there is no per-task detail route. This kind was MISSING from all three maps
  // while the API has always been able to return it, so `KIND_HREF[item.kind]` was undefined and calling
  // it threw "p[e.kind] is not a function" during render. React then unmounted the entire tree including
  // the (app) layout, so the whole page became "Application error: a client-side exception has occurred"
  // — no content and, on mobile, no bottom nav, leaving the user with no way out of the screen.
  // Any account with even one task hit this; it only stayed hidden because the demo seed created none.
  task: () => `/life`,
  school_event: () => `/life`,
  trip_segment: (tripId) => `/trips/${tripId}`,
  pet_vaccination: (petId) => `/life/pets/${petId}`,
  pet_refill_reminder: (petId) => `/life/pets/${petId}`,
  health_appointment: () => `/life`,
  health_refill_reminder: () => `/life`,
};

function groupByDay(items: TimelineItem[]): Array<[string, TimelineItem[]]> {
  const groups = new Map<string, TimelineItem[]>();
  for (const item of items) {
    const day = new Date(item.occurredAt).toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    const existing = groups.get(day);
    if (existing) existing.push(item);
    else groups.set(day, [item]);
  }
  return Array.from(groups.entries());
}

export default function TimelinePage() {
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  // Distinct from a genuinely empty timeline (EmptyState below) — a transient 500/network error
  // previously rendered as the exact same "Nothing here yet" empty state, with no way to tell "you have
  // no data" from "the request failed" and no retry affordance.
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    setIsLoading(true);
    setLoadError(null);
    return api
      .get<TimelineResponse>("/v1/timeline")
      .then((res) => {
        setItems(res.items);
        setCursor(res.nextCursor);
      })
      .catch((err) => {
        setLoadError(err instanceof ApiError ? err.message : "Please check your connection and try again.");
      })
      .finally(() => setIsLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const res = await api.get<TimelineResponse>(`/v1/timeline?before=${encodeURIComponent(cursor)}`);
      setItems((prev) => [...prev, ...res.items]);
      setCursor(res.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">Timeline</h1>
        <p className="mt-1 text-sm text-tertiary">Everything Veynlo knows, in order.</p>
      </header>

      {isLoading && (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-subtle" />
          ))}
        </div>
      )}

      {!isLoading && loadError && items.length === 0 && (
        <FetchError what="your timeline" message={loadError} onRetry={load} />
      )}

      {!isLoading && !loadError && items.length === 0 && (
        <EmptyState
          title="Nothing here yet"
          description="As Veynlo learns about your purchases, bills, appointments, and documents, they'll show up here in order."
        />
      )}

      {items.length > 0 && (
        <div className="space-y-6">
          {groupByDay(items).map(([day, dayItems]) => (
            <div key={day}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-tertiary">{day}</h2>
              <div className="space-y-2">
                {dayItems.map((item) => (
                  <Link key={`${item.kind}-${item.id}`} href={(KIND_HREF[item.kind] ?? (() => "/life"))(item.resourceId)}>
                    <Card className="transition-colors hover:bg-subtle">
                      <CardBody className="flex items-center justify-between gap-3 py-3">
                        {/* Found live: a document with a long, space-less filename (a real upload, not
                            contrived — long filenames from phones/scanners are common) rendered as one
                            unbroken line with no `min-w-0` on this flex item to let it shrink, pushing the
                            row, the card, and the whole page hundreds of pixels past the viewport's right
                            edge instead of truncating. `min-w-0` lets the flex item shrink below its
                            content's natural width so `truncate` on the title itself can actually clip it. */}
                        <div className="flex min-w-0 items-center gap-3">
                          <Badge tone={KIND_TONE[item.kind] ?? "neutral"}>{KIND_LABEL[item.kind] ?? "Item"}</Badge>
                          <p className="truncate text-sm font-medium text-primary" title={item.title}>{item.title}</p>
                        </div>
                        <p className="shrink-0 text-xs text-tertiary">
                          {new Date(item.occurredAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                        </p>
                      </CardBody>
                    </Card>
                  </Link>
                ))}
              </div>
            </div>
          ))}

          {cursor && (
            <div className="pt-2 text-center">
              <Button variant="secondary" size="sm" onClick={loadMore} loading={loadingMore}>
                Load earlier
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
