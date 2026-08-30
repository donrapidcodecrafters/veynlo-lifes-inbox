import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
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

const EXPORT_PRESETS = [
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
  { label: "This year", days: 365 },
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

export default function TimelineScreen() {
  const { theme } = useAppTheme();
  const router = useRouter();
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [zoom, setZoom] = useState<ZoomLevel>("day");
  const [kindFilter, setKindFilter] = useState<TimelineKind | "">("");
  const [showExport, setShowExport] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  // TIME-001 "search box" — debounced so every keystroke doesn't fire a request.
  useEffect(() => {
    const handle = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(handle);
  }, [searchInput]);

  /** Same "no browser download here" reasoning as Documents export: the CSV is written to the cache
   * directory and handed to the OS share sheet via expo-sharing. */
  async function exportRange(days: number) {
    setExporting(true);
    try {
      const to = new Date();
      const from = new Date(Date.now() - days * 86_400_000);
      const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
      const buffer = await api.downloadBinary(`/v1/timeline/export?${params.toString()}`, undefined, "GET");
      const destination = new File(Paths.cache, `veynlo-timeline-${Date.now()}.csv`);
      destination.write(new Uint8Array(buffer));
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(destination.uri, { mimeType: "text/csv" });
      }
      setShowExport(false);
    } finally {
      setExporting(false);
    }
  }

  useEffect(() => {
    setIsLoading(true);
    const params = new URLSearchParams();
    if (kindFilter) params.set("kind", kindFilter);
    if (search) params.set("search", search);
    const qs = params.toString();
    api
      .get<TimelineResponse>(`/v1/timeline${qs ? `?${qs}` : ""}`)
      .then((res) => {
        setItems(res.items);
        setCursor(res.nextCursor);
      })
      .finally(() => setIsLoading(false));
  }, [kindFilter, search]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ before: cursor });
      if (kindFilter) params.set("kind", kindFilter);
      if (search) params.set("search", search);
      const res = await api.get<TimelineResponse>(`/v1/timeline?${params.toString()}`);
      setItems((prev) => [...prev, ...res.items]);
      setCursor(res.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <Screen>
      <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <View style={{ flex: 1 }}>
          <ScreenHeader title="Timeline" subtitle="Everything Veynlo knows, in order." />
        </View>
        <Button variant="secondary" onPress={() => setShowExport((v) => !v)}>
          {showExport ? "Cancel" : "Export"}
        </Button>
      </View>

      {showExport && (
        <Card style={{ gap: 8 }}>
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Download a CSV of:</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {EXPORT_PRESETS.map((p) => (
              <Button key={p.label} variant="secondary" onPress={() => exportRange(p.days)} loading={exporting}>
                {p.label}
              </Button>
            ))}
          </View>
        </Card>
      )}

      <TextInput
        value={searchInput}
        onChangeText={setSearchInput}
        placeholder="Search timeline…"
        placeholderTextColor={theme.colors.textTertiary}
        accessibilityLabel="Search timeline"
        style={{
          height: 40,
          borderRadius: theme.radius.md,
          borderWidth: 1,
          borderColor: theme.colors.borderDefault,
          paddingHorizontal: 12,
          fontSize: 14,
          color: theme.colors.textPrimary,
          backgroundColor: theme.colors.bgSurface,
        }}
      />

      <View style={{ flexDirection: "row", gap: 6, padding: 6, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.sm }}>
        {(["day", "week", "month"] as const).map((z) => {
          const active = zoom === z;
          return (
            <Pressable
              key={z}
              onPress={() => setZoom(z)}
              accessibilityRole="button"
              accessibilityLabel={z}
              accessibilityState={{ selected: active }}
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
              accessibilityRole="button"
              accessibilityLabel={f.label}
              accessibilityState={{ selected: active }}
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
          title={search ? "No matches" : "Nothing here yet"}
          description={
            search
              ? "Nothing matches this search. Try a different term, or clear the search field."
              : "As Veynlo learns about your purchases, bills, appointments, and documents, they'll show up here in order."
          }
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
                    <Pressable
                      onPress={() => router.push(KIND_ROUTE[item.kind](item.resourceId))}
                      accessibilityRole="button"
                      accessibilityLabel={`${item.title}, ${KIND_LABEL[item.kind]}`}
                    >
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
