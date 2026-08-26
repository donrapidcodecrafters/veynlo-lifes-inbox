import { useCallback, useState } from "react";
import { RefreshControl, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { api } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";

interface InboxItem {
  id: string;
  category: string;
  summary: string;
  confidenceBand: string;
  reviewState: string;
}

const CONFIDENCE_TONE: Record<string, "positive" | "warning" | "critical" | "neutral"> = {
  verified: "positive",
  high: "positive",
  needs_review: "warning",
  conflicting: "critical",
  approximate: "neutral",
};

export default function InboxScreen() {
  const { theme } = useAppTheme();
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const res = await api.get<InboxItem[]>("/v1/inbox?reviewState=new");
    setItems(res);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function onRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  async function act(id: string, action: "confirm" | "archive" | "dismiss") {
    await api.post(`/v1/inbox/${id}/${action}`);
    load();
  }

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.brandDefault} />}>
      <View>
        <Text style={{ fontSize: 24, fontWeight: "700", color: theme.colors.textPrimary }}>Inbox</Text>
        <Text style={{ fontSize: 14, color: theme.colors.textTertiary, marginTop: 2 }}>Newly discovered information to review.</Text>
      </View>

      {items?.length === 0 && (
        <EmptyState
          title="You're caught up."
          description="New receipts, bills, appointments, and other discoveries will show up here for a quick review."
        />
      )}

      {items && items.length > 0 && (
        <View style={{ gap: 12 }}>
          {items.map((item) => (
            <Card key={item.id} style={{ gap: 12 }}>
              <View style={{ gap: 6 }}>
                <View style={{ flexDirection: "row", gap: 6 }}>
                  <Badge>{item.category}</Badge>
                  <Badge tone={CONFIDENCE_TONE[item.confidenceBand] ?? "neutral"}>{item.confidenceBand.replace("_", " ")}</Badge>
                </View>
                <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.textPrimary }}>{item.summary}</Text>
              </View>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Button onPress={() => act(item.id, "confirm")}>Confirm</Button>
                </View>
                <View style={{ flex: 1 }}>
                  <Button variant="secondary" onPress={() => act(item.id, "archive")}>
                    Archive
                  </Button>
                </View>
                <View style={{ flex: 1 }}>
                  <Button variant="ghost" onPress={() => act(item.id, "dismiss")}>
                    Dismiss
                  </Button>
                </View>
              </View>
            </Card>
          ))}
        </View>
      )}
    </Screen>
  );
}
