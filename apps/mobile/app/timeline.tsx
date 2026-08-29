import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { api } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";

type TimelineKind = "calendar_event" | "purchase" | "bill" | "document" | "return_case" | "warranty" | "shipment";

interface TimelineItem {
  id: string;
  kind: TimelineKind;
  title: string;
  occurredAt: string;
  resourceType: string;
  resourceId: string;
  relatedItems: TimelineItem[];
}

const KIND_ROUTE: Record<TimelineKind, (resourceId: string) => string> = {
  calendar_event: (id) => `/event/${id}`,
  purchase: (id) => `/purchase/${id}`,
  bill: (id) => `/bill/${id}`,
  return_case: (id) => `/return-case/${id}`,
  warranty: (id) => `/warranty/${id}`,
  document: () => `/documents`, // no per-document detail screen exists yet — the list is the closest real destination
  shipment: () => `/timeline`, // shipments only ever appear nested under their purchase — no standalone detail screen
};

interface TimelineResponse {
  items: TimelineItem[];
  nextCursor: string | null;
}

const KIND_LABEL: Record<TimelineKind, string> = {
  calendar_event: "Event",
  purchase: "Purchase",
  bill: "Bill",
  document: "Document",
  return_case: "Return",
  warranty: "Warranty",
  shipment: "Shipment",
};

// Mobile's Badge only supports neutral/critical/warning/positive/brand (no "info") — calendar events use
// brand instead, the closest match to web's info tone.
const KIND_TONE: Record<TimelineKind, "brand" | "positive" | "warning" | "neutral" | "critical"> = {
  calendar_event: "brand",
  purchase: "positive",
  bill: "warning",
  document: "neutral",
  return_case: "critical",
  warranty: "neutral",
  shipment: "positive",
};

const FILTER_KINDS: Array<{ value: TimelineKind | ""; label: string }> = [
  { value: "", label: "All" },
  { value: "purchase", label: "Purchases" },
  { value: "bill", label: "Bills" },
  { value: "calendar_event", label: "Events" },
  { value: "return_case", label: "Returns" },
  { value: "warranty", label: "Warranties" },
  { value: "document", label: "Documents" },
];

type ZoomLevel = "day" | "week" | "month";

function groupKey(date: Date, zoom: ZoomLevel): string {
  if (zoom === "month") return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  if (zoom === "week") {
    const startOfWeek = new Date(date);
    startOfWeek.setDate(date.getDate() - date.getDay());
    return `Week of ${startOfWeek.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}`;
  }
  return date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

function groupByZoom(items: TimelineItem[], zoom: ZoomLevel): Array<[string, TimelineItem[]]> {
  const groups = new Map<string, TimelineItem[]>();
  for (const item of items) {
    const key = groupKey(new Date(item.occurredAt), zoom);
    const existing = groups.get(key);
    if (existing) existing.push(item);
    else groups.set(key, [item]);
  }
  return Array.from(groups.entries());
}

// CSV export is web-only this pass — a real download there is just a Content-Disposition navigation
// (window.location.href); native has no equivalent without adding expo-file-system/expo-sharing and a
// rebuild, a separate effort from the rest of this pass (same reasoning as mobile voice input on Ask).
export default function TimelineScreen() {
  const { theme } = useAppTheme();
  const router = useRouter();
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [zoom, setZoom] = useState<ZoomLevel>("day");
  const [kindFilter, setKindFilter] = useState<TimelineKind | "">("");

  useEffect(() => {
    setIsLoading(true);
    const qs = kindFilter ? `?kind=${kindFilter}` : "";
    api
      .get<TimelineResponse>(`/v1/timeline${qs}`)
      .then((res) => {
        setItems(res.items);
        setCursor(res.nextCursor);
      })
      .finally(() => setIsLoading(false));
  }, [kindFilter]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ before: cursor });
      if (kindFilter) params.set("kind", kindFilter);
      const res = await api.get<TimelineResponse>(`/v1/timeline?${params.toString()}`);
      setItems((prev) => [...prev, ...res.items]);
      setCursor(res.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <Screen>
      <ScreenHeader title="Timeline" subtitle="Everything Veynlo knows, in order." />

      <View style={{ flexDirection: "row", gap: 6, padding: 6, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.sm }}>
        {(["day", "week", "month"] as const).map((z) => {
          const active = zoom === z;
          return (
            <Pressable
              key={z}
              onPress={() => setZoom(z)}
              style={{ flex: 1, paddingVertical: 8, borderRadius: theme.radius.sm, backgroundColor: active ? theme.colors.bgSurface : "transparent", alignItems: "center" }}
            >
              <Text style={{ fontSize: 13, fontWeight: "600", color: active ? theme.colors.textPrimary : theme.colors.textTertiary, textTransform: "capitalize" }}>
                {z}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
        {FILTER_KINDS.map((f) => {
          const active = kindFilter === f.value;
          return (
            <Pressable
              key={f.value || "all"}
              onPress={() => setKindFilter(f.value)}
              style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: theme.radius.sm, backgroundColor: active ? theme.colors.bgSurface : theme.colors.bgSubtle }}
            >
              <Text style={{ fontSize: 12, fontWeight: "600", color: active ? theme.colors.textPrimary : theme.colors.textTertiary }}>{f.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {isLoading && (
        <View style={{ gap: 8 }}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={{ height: 56, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} />
          ))}
        </View>
      )}

      {!isLoading && items.length === 0 && (
        <EmptyState
          title="Nothing here yet"
          description="As Veynlo learns about your purchases, bills, appointments, and documents, they'll show up here in order."
        />
      )}

      {items.length > 0 && (
        <View style={{ gap: 20 }}>
          {groupByZoom(items, zoom).map(([label, groupItems]) => (
            <View key={label} style={{ gap: 8 }}>
              <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>{label}</Text>
              <View style={{ gap: 8 }}>
                {groupItems.map((item) => (
                  <View key={`${item.kind}-${item.id}`}>
                    <Pressable onPress={() => router.push(KIND_ROUTE[item.kind](item.resourceId))}>
                      <Card style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexShrink: 1 }}>
                          <Badge tone={KIND_TONE[item.kind]}>{KIND_LABEL[item.kind]}</Badge>
                          <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary, flexShrink: 1 }} numberOfLines={2}>
                            {item.title}
                          </Text>
                        </View>
                        <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
                          {new Date(item.occurredAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                        </Text>
                      </Card>
                    </Pressable>
                    {item.relatedItems.length > 0 && (
                      <View style={{ marginLeft: 20, marginTop: 4, gap: 4, borderLeftWidth: 1, borderLeftColor: theme.colors.borderSubtle, paddingLeft: 10 }}>
                        {item.relatedItems.map((related) => (
                          <View key={`${related.kind}-${related.id}`} style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 2 }}>
                            <Badge tone={KIND_TONE[related.kind]}>{KIND_LABEL[related.kind]}</Badge>
                            <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{related.title}</Text>
                          </View>
                        ))}
                      </View>
                    )}
                  </View>
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
