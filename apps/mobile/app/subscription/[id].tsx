import { useEffect, useState } from "react";
import { Linking, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { api } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";
import { EvidenceCard, type Evidence } from "@/components/evidence-card";
import { HistorySection } from "@/components/history-section";
import { formatMoneyMinorUnits } from "@/lib/format";

interface SubscriptionDetail {
  subscription: { state: string; cancellationInstructionsUrl: string | null };
  stream: { serviceLabel: string; cadence: string; typicalAmountMinorUnits: number | null; typicalAmountCurrency: string | null; essential: boolean | null };
  evidence: Evidence | null;
}

export default function SubscriptionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { theme } = useAppTheme();
  const [data, setData] = useState<SubscriptionDetail | null | undefined>(undefined);

  useEffect(() => {
    api.get<SubscriptionDetail | null>(`/v1/subscriptions/${id}`).then(setData);
  }, [id]);

  if (data === undefined) return <Screen><View style={{ height: 120, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} /></Screen>;
  if (!data) return <Screen><ScreenHeader title="Not found" /><EmptyState title="Not found" description="This subscription doesn't exist or you don't have access to it." /></Screen>;

  const { subscription, stream, evidence } = data;
  const amount = formatMoneyMinorUnits(stream.typicalAmountMinorUnits, stream.typicalAmountCurrency);

  return (
    <Screen>
      <ScreenHeader title={stream.serviceLabel} subtitle={stream.cadence} />
      <Card style={{ gap: 6 }}>
        {amount && <Text style={{ fontSize: 20, fontWeight: "700", color: theme.colors.textPrimary }}>{amount}</Text>}
        {subscription.state === "price_changed" && <Badge tone="warning">Price changed</Badge>}
        <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
          Essential: {stream.essential == null ? "Unknown" : stream.essential ? "Yes" : "No"}
        </Text>
        {subscription.cancellationInstructionsUrl && (
          <Text
            style={{ fontSize: 13, color: theme.colors.brandDefault }}
            onPress={() => Linking.openURL(subscription.cancellationInstructionsUrl!)}
          >
            Cancellation instructions →
          </Text>
        )}
      </Card>
      <HistorySection resourceType="subscription" resourceId={id} />
      <EvidenceCard evidence={evidence} />
    </Screen>
  );
}
