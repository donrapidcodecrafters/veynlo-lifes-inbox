import { useCallback, useState } from "react";
import { Pressable, RefreshControl, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { EmptyState } from "@/components/empty-state";
import { FetchError } from "@/components/fetch-error";
import { ScreenHeader } from "@/components/screen-header";

interface EntityRow {
  id: string;
  type: string;
  displayLabel: string;
  lifecycleState: string;
}

/** Mirrors apps/web's (app)/entities/page.tsx — see its own doc comment for the MVP §52.1 "conservative
 * entity linking" gap this closes. */
export default function EntitiesScreen() {
  const { theme } = useAppTheme();
  const [entities, setEntities] = useState<EntityRow[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // A bare `await api.get` with no try/catch on a useFocusEffect-triggered fetch (nothing downstream awaits
  // it, so nothing else could catch it either) becomes an unhandled promise rejection on any transient
  // network failure — React Native Web surfaces that as a full-screen "Uncaught Error" dev overlay blocking
  // the entire app, not just this screen (same fix already applied to documents.tsx, lists.tsx, etc.).
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setEntities(await api.get<EntityRow[]>("/v1/entities"));
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Couldn't load this. Please try again.");
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.brandDefault} />}>
      <ScreenHeader
        title="What Veynlo knows"
        subtitle="Things Veynlo has identified from your purchases and documents."
      />

      {/* Found live via a simulated 500: this rendered as a plain, un-retryable red text line — the exact
          "renders an empty state with no retry affordance" gap FetchError exists to close (see inbox.tsx,
          connections.tsx, and (tabs)/index.tsx, which already use it for this same load path). Missing
          here even though every sibling list screen in this app already has it. */}
      {!entities && !loadError && (
        <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />
      )}

      {!entities && loadError && <FetchError what="what Veynlo knows" message={loadError} onRetry={load} />}

      {entities?.length === 0 && (
        <EmptyState title="Nothing here yet" description="As Veynlo processes your purchases and documents, items it identifies will show up here." />
      )}

      {entities && entities.length > 0 && (
        <View style={{ gap: 8 }}>
          {entities.map((entity) => (
            <Pressable accessibilityRole="button" key={entity.id} onPress={() => router.push(`/entity/${entity.id}`)}>
              <Card style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <View>
                  <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{entity.displayLabel}</Text>
                  <Text style={{ fontSize: 12, color: theme.colors.textTertiary, textTransform: "capitalize" }}>{entity.type}</Text>
                </View>
                <Badge tone="neutral">{entity.lifecycleState}</Badge>
              </Card>
            </Pressable>
          ))}
        </View>
      )}
    </Screen>
  );
}
