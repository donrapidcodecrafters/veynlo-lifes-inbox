import { useCallback, useState } from "react";
import { Pressable, RefreshControl, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";
import { TextField } from "@/components/text-field";
import { FetchError } from "@/components/fetch-error";

const CATEGORIES = [
  { value: "", label: "All" },
  { value: "product", label: "Product" },
  { value: "place", label: "Place" },
  { value: "recipe", label: "Recipe" },
  { value: "article", label: "Article" },
  { value: "movie_show", label: "Movie/Show" },
  { value: "gift_idea", label: "Gift idea" },
  { value: "event", label: "Event" },
  { value: "trip_idea", label: "Trip idea" },
  { value: "how_to", label: "How-to" },
  { value: "reference", label: "Reference" },
  { value: "document", label: "Document" },
  { value: "generic", label: "Generic" },
] as const;

interface MemoryRow {
  id: string;
  sourceUrl: string | null;
  title: string | null;
  category: string | null;
  classificationState: "pending" | "classified" | "failed" | "skipped";
  pinned: boolean;
}

function categoryLabel(category: string | null): string {
  return CATEGORIES.find((c) => c.value === category)?.label ?? "Uncategorized";
}

/** Mirrors apps/web's (app)/saved/page.tsx — see its own doc comment for §29.1 SAVE-001/002. Distinct from
 * lists.tsx (FAM-005's household checklists) — see packages/db/src/schema/memories.ts's module doc comment
 * for why this is a separate feature. */
export default function SavedScreen() {
  const { theme } = useAppTheme();
  const [memories, setMemories] = useState<MemoryRow[] | null>(null);
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]["value"]>("");
  const [refreshing, setRefreshing] = useState(false);
  const [sourceUrl, setSourceUrl] = useState("");
  const [rawText, setRawText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(async (cat: string) => {
    try {
      const path = cat ? `/v1/memories?category=${cat}` : "/v1/memories";
      setMemories(await api.get<MemoryRow[]>(path));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load your saved items. Please try again.");
    } finally {
      setRetrying(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load(category);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [load, category]),
  );

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load(category);
    } finally {
      setRefreshing(false);
    }
  }

  async function saveMemory() {
    setSaving(true);
    setError(null);
    setJustSaved(false);
    try {
      const sourceKind = sourceUrl.trim() ? "link" : "text";
      await api.post("/v1/memories", { sourceKind, sourceUrl: sourceUrl.trim() || undefined, rawText: rawText.trim() || undefined });
      setSourceUrl("");
      setRawText("");
      setJustSaved(true);
      await load(category);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save that.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.brandDefault} />}>
      <ScreenHeader title="Saved" subtitle="Save any link, product, place, recipe, or note — private to you unless you share it." />

      <Card style={{ gap: 10 }}>
        <TextField label="Save a link" placeholder="https://…" value={sourceUrl} onChangeText={setSourceUrl} autoCapitalize="none" />
        <TextField label="Or a note" placeholder="Anything you want to remember…" value={rawText} onChangeText={setRawText} multiline />
        {/* Save-a-memory failures only — a failure loading the saved-items list in the first place is
            handled below instead (FetchError with its own Retry), not here, so it isn't shown twice. */}
        {error && memories && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{error}</Text>}
        {justSaved && <Text style={{ fontSize: 13, color: theme.colors.positiveSubtleText }}>Saved — it'll be categorized automatically.</Text>}
        <Button onPress={saveMemory} loading={saving} disabled={!sourceUrl.trim() && !rawText.trim()}>
          Save
        </Button>
      </Card>

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {CATEGORIES.map((c) => {
          const active = category === c.value;
          return (
            <Pressable accessibilityRole="button"
              key={c.value}
              onPress={() => setCategory(c.value)}
              style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999, backgroundColor: active ? theme.colors.brandDefault : theme.colors.bgSubtle }}
            >
              <Text style={{ fontSize: 13, fontWeight: "600", color: active ? "#fff" : theme.colors.textSecondary }}>{c.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {!memories && error && (
        <FetchError
          message={error}
          what="your saved items"
          retrying={retrying}
          onRetry={() => {
            setRetrying(true);
            load(category);
          }}
        />
      )}
      {!memories && !error && (
        <View style={{ gap: 8 }}>
          <View style={{ height: 56, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />
          <View style={{ height: 56, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />
        </View>
      )}

      {memories?.length === 0 && (
        <EmptyState title="Nothing saved yet" description="Save a link, a note, or anything else you want to find again later." />
      )}

      {memories && memories.length > 0 && (
        <View style={{ gap: 8 }}>
          {memories.map((m) => (
            <Pressable accessibilityRole="button" key={m.id} onPress={() => router.push(`/saved-item/${m.id}`)}>
              <Card style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }} numberOfLines={1}>
                    {m.title ?? m.sourceUrl ?? "Untitled save"}
                  </Text>
                  <View style={{ flexDirection: "row", gap: 6, marginTop: 4 }}>
                    <Badge tone={m.category ? "brand" : "neutral"}>{categoryLabel(m.category)}</Badge>
                    {m.pinned && <Badge tone="warning">Pinned</Badge>}
                  </View>
                </View>
              </Card>
            </Pressable>
          ))}
        </View>
      )}
    </Screen>
  );
}
