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

const LIST_KINDS = [
  { value: "custom", label: "Custom" },
  { value: "grocery", label: "Grocery" },
  { value: "packing", label: "Packing" },
  { value: "household_maintenance", label: "Household" },
  { value: "gift", label: "Gift" },
  { value: "school_supplies", label: "School" },
  { value: "trip_prep", label: "Trip prep" },
] as const;

interface ListRow {
  id: string;
  name: string;
  kind: string;
  householdId: string | null;
  itemCounts: { total: number; checked: number };
}

interface MyHousehold {
  household: { id: string; name: string };
}

function kindLabel(kind: string): string {
  return LIST_KINDS.find((k) => k.value === kind)?.label ?? kind;
}

/** Mirrors apps/web's (app)/lists/page.tsx — see its own doc comment for FAM-005 "Shared lists". */
export default function ListsScreen() {
  const { theme } = useAppTheme();
  const [lists, setLists] = useState<ListRow[] | null>(null);
  const [households, setHouseholds] = useState<MyHousehold[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<(typeof LIST_KINDS)[number]["value"]>("custom");
  const [householdId, setHouseholdId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(async () => {
    // Confirmed live elsewhere in this app (documents.tsx, timeline.tsx, etc.): an unguarded fetch called
    // fire-and-forget from `useFocusEffect` below becomes an unhandled promise rejection on any transient
    // network failure, which React Native Web surfaces as a full-screen "Uncaught Error" dev overlay
    // blocking the entire app, not just this list.
    try {
      setLists(await api.get<ListRow[]>("/v1/lists"));
      setHouseholds(await api.get<MyHousehold[]>("/v1/households"));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't load your lists. Please try again.");
    } finally {
      setRetrying(false);
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

  async function createList() {
    setCreating(true);
    setError(null);
    try {
      await api.post("/v1/lists", { name, kind, householdId });
      setName("");
      setKind("custom");
      setHouseholdId(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't create that list.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.brandDefault} />}>
      <ScreenHeader title="Lists" subtitle="Groceries, packing, gifts, and anything else you want to track together — or privately." />

      <Card style={{ gap: 10 }}>
        <TextField label="New list" placeholder="e.g. Weekly groceries" value={name} onChangeText={setName} />

        <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textSecondary }}>Type</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {LIST_KINDS.map((k) => {
            const active = kind === k.value;
            return (
              <Pressable accessibilityRole="button"
                key={k.value}
                onPress={() => setKind(k.value)}
                style={{
                  paddingVertical: 6,
                  paddingHorizontal: 12,
                  borderRadius: 999,
                  backgroundColor: active ? theme.colors.brandDefault : theme.colors.bgSubtle,
                }}
              >
                <Text style={{ fontSize: 13, fontWeight: "600", color: active ? "#fff" : theme.colors.textSecondary }}>{k.label}</Text>
              </Pressable>
            );
          })}
        </View>

        {households.length > 0 && (
          <>
            <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textSecondary }}>Share with</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              <Pressable accessibilityRole="button"
                onPress={() => setHouseholdId(null)}
                style={{
                  paddingVertical: 6,
                  paddingHorizontal: 12,
                  borderRadius: 999,
                  backgroundColor: householdId === null ? theme.colors.brandDefault : theme.colors.bgSubtle,
                }}
              >
                <Text style={{ fontSize: 13, fontWeight: "600", color: householdId === null ? "#fff" : theme.colors.textSecondary }}>Just me</Text>
              </Pressable>
              {households.map((h) => {
                const active = householdId === h.household.id;
                return (
                  <Pressable accessibilityRole="button"
                    key={h.household.id}
                    onPress={() => setHouseholdId(h.household.id)}
                    style={{
                      paddingVertical: 6,
                      paddingHorizontal: 12,
                      borderRadius: 999,
                      backgroundColor: active ? theme.colors.brandDefault : theme.colors.bgSubtle,
                    }}
                  >
                    <Text style={{ fontSize: 13, fontWeight: "600", color: active ? "#fff" : theme.colors.textSecondary }}>{h.household.name}</Text>
                  </Pressable>
                );
              })}
            </View>
          </>
        )}

        {/* Create-list failures only — a failure loading the list of lists in the first place is handled
            below instead (FetchError with its own Retry), not here, so it isn't shown twice. */}
        {error && lists && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{error}</Text>}
        <Button onPress={createList} loading={creating} disabled={!name.trim()}>
          Create list
        </Button>
      </Card>

      {/* Found live: apps/web's lists page shows an "isLoading" indicator ("Loading…"), but this screen
          showed nothing at all while `lists` was still null — just a blank gap below the create-list card
          until the first `/v1/lists` response landed, indistinguishable from "no lists yet". A load failure
          is now distinguished from "still loading" too, with a real Retry instead of an infinite skeleton. */}
      {!lists && error && (
        <FetchError
          message={error}
          what="your lists"
          retrying={retrying}
          onRetry={() => {
            setRetrying(true);
            load();
          }}
        />
      )}
      {!lists && !error && (
        <View style={{ gap: 8 }}>
          <View style={{ height: 56, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />
          <View style={{ height: 56, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />
        </View>
      )}

      {lists?.length === 0 && (
        <EmptyState
          title="No lists yet"
          description="Create a grocery list, a packing list, or anything else you want to track — private to you, or shared with your household."
        />
      )}

      {lists && lists.length > 0 && (
        <View style={{ gap: 8 }}>
          {lists.map((list) => (
            <Pressable accessibilityRole="button" key={list.id} onPress={() => router.push(`/list/${list.id}`)}>
              <Card style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{list.name}</Text>
                  <View style={{ flexDirection: "row", gap: 6, marginTop: 4 }}>
                    <Badge tone="neutral">{kindLabel(list.kind)}</Badge>
                    {list.householdId && <Badge tone="neutral">Shared</Badge>}
                  </View>
                </View>
                <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
                  {list.itemCounts.checked}/{list.itemCounts.total} done
                </Text>
              </Card>
            </Pressable>
          ))}
        </View>
      )}
    </Screen>
  );
}
