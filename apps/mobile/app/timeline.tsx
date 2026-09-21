import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { FetchError } from "@/components/fetch-error";
import { ScreenHeader } from "@/components/screen-header";

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

// school_event/health_appointment route to /life (no per-item detail screen exists yet, same reasoning as
// `document` below) — trip_segment/pet_* use `resourceId`, which the API deliberately points at the parent
// trip/pet id (not the row's own id): `/trip/:id` and `/pet/:id` both exist even though a per-segment or
// per-vaccination screen doesn't. Mirrors (tabs)/ask.tsx's identical EVIDENCE_ROUTE additions.
const KIND_ROUTE: Record<TimelineItem["kind"], (resourceId: string) => string> = {
  calendar_event: (id) => `/event/${id}`,
  purchase: (id) => `/purchase/${id}`,
  bill: (id) => `/bill/${id}`,
  return_case: (id) => `/return-case/${id}`,
  warranty: (id) => `/warranty/${id}`,
  document: () => `/documents`, // no per-document detail screen exists yet — the list is the closest real destination
  // Tasks surface on /life; there is no per-task detail screen. This kind was MISSING from all three maps
  // on BOTH platforms while the API has always been able to return it, so `KIND_ROUTE[item.kind]` was
  // undefined and calling it threw during render, taking the whole screen down. Any account with even one
  // task hit it — it stayed hidden only because the demo seed created no tasks.
  task: () => `/life`,
  school_event: () => `/life`,
  trip_segment: (tripId) => `/trip/${tripId}`,
  pet_vaccination: (petId) => `/pet/${petId}`,
  pet_refill_reminder: (petId) => `/pet/${petId}`,
  health_appointment: () => `/life`,
  health_refill_reminder: () => `/life`,
};

interface TimelineResponse {
  items: TimelineItem[];
  nextCursor: string | null;
}

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

// Mobile's Badge only supports neutral/critical/warning/positive/brand (no "info") — calendar events use
// brand instead, the closest match to web's info tone.
const KIND_TONE: Record<TimelineItem["kind"], "brand" | "positive" | "warning" | "neutral" | "critical"> = {
  calendar_event: "brand",
  purchase: "positive",
  bill: "warning",
  document: "neutral",
  task: "brand",
  return_case: "critical",
  warranty: "neutral",
  school_event: "brand",
  trip_segment: "brand",
  pet_vaccination: "neutral",
  pet_refill_reminder: "warning",
  health_appointment: "brand",
  health_refill_reminder: "warning",
};

function groupByDay(items: TimelineItem[]): Array<[string, TimelineItem[]]> {
  const groups = new Map<string, TimelineItem[]>();
  for (const item of items) {
    const day = new Date(item.occurredAt).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    const existing = groups.get(day);
    if (existing) existing.push(item);
    else groups.set(day, [item]);
  }
  return Array.from(groups.entries());
}

export default function TimelineScreen() {
  const { theme } = useAppTheme();
  const router = useRouter();
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  // Confirmed live: with no `.catch` here, a failed fetch (e.g. a transient network blip) became an
  // unhandled promise rejection that React Native Web surfaces as a full-screen "Uncaught Error" dev
  // overlay blocking the ENTIRE app, not just this screen — same failure mode found and fixed in
  // documents.tsx's ShareDocumentPanel.
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setIsLoading(true);
    return api
      .get<TimelineResponse>("/v1/timeline")
      .then((res) => {
        setItems(res.items);
        setCursor(res.nextCursor);
        setError(null);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load your timeline. Please try again."))
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
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load more. Please try again.");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <Screen>
      <ScreenHeader title="Timeline" subtitle="Everything Veynlo knows, in order." />

      {isLoading && (
        <View style={{ gap: 8 }}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={{ height: 56, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} />
          ))}
        </View>
      )}

      {/* Found live via a simulated 500: this screen already imports FetchError (see the comment on the
          `error` state above) but never actually rendered it — the plain Text below was the entire error
          UI, an un-retryable dead end identical to the gap already closed on inbox.tsx/connections.tsx/
          (tabs)/index.tsx via FetchError. Only replaces the empty-first-load case with the retryable
          component; a loadMore() failure with items already on screen keeps the lighter-weight plain-text
          banner instead of blowing away the existing list. */}
      {!isLoading && items.length === 0 && error && <FetchError what="your timeline" message={error} onRetry={load} />}

      {error && items.length > 0 && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{error}</Text>}

      {!isLoading && items.length === 0 && !error && (
        <EmptyState
          title="Nothing here yet"
          description="As Veynlo learns about your purchases, bills, appointments, and documents, they'll show up here in order."
        />
      )}

      {items.length > 0 && (
        <View style={{ gap: 20 }}>
          {groupByDay(items).map(([day, dayItems]) => (
            <View key={day} style={{ gap: 8 }}>
              <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>{day}</Text>
              <View style={{ gap: 8 }}>
                {dayItems.map((item) => (
                  <Pressable accessibilityRole="button" key={`${item.kind}-${item.id}`} onPress={() => router.push((KIND_ROUTE[item.kind] ?? (() => "/life"))(item.resourceId))}>
                    <Card style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexShrink: 1 }}>
                        <Badge tone={KIND_TONE[item.kind] ?? "neutral"}>{KIND_LABEL[item.kind] ?? "Item"}</Badge>
                        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary, flexShrink: 1 }} numberOfLines={2}>
                          {item.title}
                        </Text>
                      </View>
                      <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
                        {new Date(item.occurredAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                      </Text>
                    </Card>
                  </Pressable>
                ))}
              </View>
            </View>
          ))}

          {cursor && (
            <View style={{ alignItems: "center", paddingTop: 4 }}>
              <Button variant="secondary" onPress={loadMore} loading={loadingMore}>
                Load earlier
              </Button>
            </View>
          )}
        </View>
      )}
    </Screen>
  );
}
