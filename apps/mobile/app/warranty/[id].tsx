import { useEffect, useState } from "react";
import { Text, View } from "react-native";
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
import { formatTemporal, daysUntil, type TemporalValueLike } from "@/lib/format";

interface WarrantyDetail {
  warranty: { productLabel: string; warrantyLengthMonths: number | null; expirationDate: TemporalValueLike; registrationConfirmed: boolean | null };
  evidence: Evidence | null;
}

export default function WarrantyDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { theme } = useAppTheme();
  const [data, setData] = useState<WarrantyDetail | null | undefined>(undefined);

  useEffect(() => {
    api.get<WarrantyDetail | null>(`/v1/warranties/${id}`).then(setData);
  }, [id]);

  if (data === undefined) return <Screen><View style={{ height: 120, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} /></Screen>;
  if (!data) return <Screen><ScreenHeader title="Not found" /><EmptyState title="Not found" description="This warranty doesn't exist or you don't have access to it." /></Screen>;

  const { warranty, evidence } = data;
  const expires = formatTemporal(warranty.expirationDate);
  const days = daysUntil(warranty.expirationDate);

  return (
    <Screen>
      <ScreenHeader title={warranty.productLabel} subtitle={expires ? `Expires ${expires}` : undefined} />
      <Card style={{ gap: 6 }}>
        {days != null && <Badge tone={days <= 30 ? "warning" : "neutral"}>{days > 0 ? `${days}d left` : "Expired"}</Badge>}
        {warranty.warrantyLengthMonths != null && (
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>{warranty.warrantyLengthMonths} months</Text>
        )}
        <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
          Registered: {warranty.registrationConfirmed == null ? "Unknown" : warranty.registrationConfirmed ? "Yes" : "No"}
        </Text>
      </Card>
      <HistorySection resourceType="warranty" resourceId={id} />
      <EvidenceCard evidence={evidence} />
    </Screen>
  );
}
