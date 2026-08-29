import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { api } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";

interface TimelineItem {
  id: string;
  kind: "calendar_event" | "purchase" | "bill" | "document" | "return_case" | "warranty";
  title: string;
  occurredAt: string;
  resourceType: string;
  resourceId: string;
}

const KIND_ROUTE: Record<TimelineItem["kind"], (resourceId: string) => string> = {
  calendar_event: (id) => `/event/${id}`,
  purchase: (id) => `/purchase/${id}`,
  bill: (id) => `/bill/${id}`,
  return_case: (id) => `/return-case/${id}`,
  warranty: (id) => `/warranty/${id}`,
  document: () => `/documents`, // no per-document detail screen exists yet — the list is the closest real destination
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
  return_case: "Return",
  warranty: "Warranty",
};

// Mobile's Badge only supports neutral/critical/warning/positive/brand (no "info") — calendar events use
// brand instead, the closest match to web's info tone.
const KIND_TONE: Record<TimelineItem["kind"], "brand" | "positive" | "warning" | "neutral" | "critical"> = {
  calendar_event: "brand",
  purchase: "positive",
  bill: "warning",
  document: "neutral",
  return_case: "critical",
  warranty: "neutral",
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

  useEffect(() => {
    api
      .get<TimelineResponse>("/v1/timeline")
      .then((res) => {
        setItems(res.items);
        setCursor(res.nextCursor);
      })
      .finally(() => setIsLoading(false));
  }, []);

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
    <Screen>
      <ScreenHeader title="Timeline" subtitle="Everything Veynlo knows, in order." />

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
          {groupByDay(items).map(([day, dayItems]) => (
            <View key={day} style={{ gap: 8 }}>
              <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>{day}</Text>
              <View style={{ gap: 8 }}>
                {dayItems.map((item) => (
                  <Pressable key={`${item.kind}-${item.id}`} onPress={() => router.push(KIND_ROUTE[item.kind](item.resourceId))}>
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
