import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { api } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";
import { EvidenceCard, type Evidence } from "@/components/evidence-card";
import { formatMoneyMinorUnits, formatTemporal, daysUntil, type TemporalValueLike } from "@/lib/format";

interface ReturnDetail {
  returnCase: { state: string; deadline: TemporalValueLike; valueAtStakeMinorUnits: number | null; valueAtStakeCurrency: string | null; trackingNumber: string | null };
  purchase: { id: string; orderNumber: string | null };
  evidence: Evidence | null;
}

export default function ReturnDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { theme } = useAppTheme();
  const [data, setData] = useState<ReturnDetail | null | undefined>(undefined);

  useEffect(() => {
    api.get<ReturnDetail | null>(`/v1/returns/${id}`).then(setData);
  }, [id]);

  if (data === undefined) return <Screen><View style={{ height: 120, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} /></Screen>;
  if (!data) return <Screen><ScreenHeader title="Not found" /><EmptyState title="Not found" description="This return doesn't exist or you don't have access to it." /></Screen>;

  const { returnCase, purchase, evidence } = data;
  const deadline = formatTemporal(returnCase.deadline);
  const value = formatMoneyMinorUnits(returnCase.valueAtStakeMinorUnits, returnCase.valueAtStakeCurrency);
  const days = daysUntil(returnCase.deadline);

  return (
    <Screen>
      <ScreenHeader title={`Return for order ${purchase.orderNumber ?? purchase.id}`} subtitle={deadline ? `Deadline ${deadline}` : undefined} />
      <Card style={{ gap: 6 }}>
        {days != null && <Badge tone={days <= 3 ? "critical" : "warning"}>{days > 0 ? `${days}d left` : "Due today"}</Badge>}
        {value && <Text style={{ fontSize: 20, fontWeight: "700", color: theme.colors.textPrimary }}>{value}</Text>}
        <Text style={{ fontSize: 13, color: theme.colors.textTertiary, textTransform: "capitalize" }}>{returnCase.state.replace("_", " ")}</Text>
        {returnCase.trackingNumber && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Tracking: {returnCase.trackingNumber}</Text>}
        <Text style={{ fontSize: 13, color: theme.colors.brandDefault }} onPress={() => router.push(`/purchase/${purchase.id}`)}>
          View order →
        </Text>
      </Card>
      <EvidenceCard evidence={evidence} />
    </Screen>
  );
}
