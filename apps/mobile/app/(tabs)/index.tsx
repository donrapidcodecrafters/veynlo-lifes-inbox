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
import { formatMoneyMinorUnits, formatTemporal, type TemporalValueLike } from "@/lib/format";

interface AttentionItem {
  id: string;
  reasonText: string;
  urgency: "critical" | "important" | "useful" | "informational";
  dueAt: TemporalValueLike | null;
  moneyAtStakeMinorUnits: number | null;
  moneyAtStakeCurrency: string | null;
}

interface HomeResponse {
  items: AttentionItem[];
  caughtUp: boolean;
  degraded: boolean;
}

const URGENCY_TONE: Record<AttentionItem["urgency"], "critical" | "warning" | "neutral"> = {
  critical: "critical",
  important: "warning",
  useful: "neutral",
  informational: "neutral",
};

export default function HomeScreen() {
  const { theme } = useAppTheme();
  const [data, setData] = useState<HomeResponse | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const res = await api.get<HomeResponse>("/v1/home");
    setData(res);
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

  async function resolve(id: string) {
    await api.post(`/v1/attention/${id}/resolve`);
    load();
  }

  async function dismiss(id: string) {
    await api.post(`/v1/attention/${id}/dismiss`, { reason: "not_relevant" });
    load();
  }

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.brandDefault} />}>
      <View>
        <Text style={{ fontSize: 24, fontWeight: "700", color: theme.colors.textPrimary }}>Home</Text>
        <Text style={{ fontSize: 14, color: theme.colors.textTertiary, marginTop: 2 }}>What matters right now.</Text>
      </View>

      {data?.caughtUp && (
        <EmptyState
          title="You're caught up."
          description="Nothing needs your attention right now. Connect an account or add something to find more."
        />
      )}

      {data && data.items.length > 0 && (
        <View style={{ gap: 12 }}>
          {data.items.map((item) => {
            const due = formatTemporal(item.dueAt);
            const money = formatMoneyMinorUnits(item.moneyAtStakeMinorUnits, item.moneyAtStakeCurrency);
            return (
              <Card key={item.id} style={{ gap: 12 }}>
                <View style={{ gap: 6 }}>
                  <Badge tone={URGENCY_TONE[item.urgency]}>{item.urgency}</Badge>
                  <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.textPrimary }}>{item.reasonText}</Text>
                  <View style={{ flexDirection: "row", gap: 12 }}>
                    {due && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Due {due}</Text>}
                    {money && <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textPrimary }}>{money} at stake</Text>}
                  </View>
                </View>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Button variant="secondary" onPress={() => resolve(item.id)}>
                      Mark handled
                    </Button>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Button variant="ghost" onPress={() => dismiss(item.id)}>
                      Dismiss
                    </Button>
                  </View>
                </View>
              </Card>
            );
          })}
        </View>
      )}
    </Screen>
  );
}
