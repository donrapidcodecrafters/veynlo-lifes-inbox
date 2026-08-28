import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { api } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";
import { EvidenceCard, type Evidence } from "@/components/evidence-card";
import { formatMoneyMinorUnits, formatTemporal, type TemporalValueLike } from "@/lib/format";

interface BillDetail {
  bill: { billerLabel: string; amountDueMinorUnits: number | null; amountDueCurrency: string | null; dueDate: TemporalValueLike; autopayBelieved: boolean | null };
  evidence: Evidence | null;
}

export default function BillDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { theme } = useAppTheme();
  const [data, setData] = useState<BillDetail | null | undefined>(undefined);

  useEffect(() => {
    api.get<BillDetail | null>(`/v1/bills/${id}`).then(setData);
  }, [id]);

  if (data === undefined) return <Screen><View style={{ height: 120, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} /></Screen>;
  if (!data) return <Screen><ScreenHeader title="Not found" /><EmptyState title="Not found" description="This bill doesn't exist or you don't have access to it." /></Screen>;

  const { bill, evidence } = data;
  const due = formatTemporal(bill.dueDate);
  const amount = formatMoneyMinorUnits(bill.amountDueMinorUnits, bill.amountDueCurrency);

  return (
    <Screen>
      <ScreenHeader title={bill.billerLabel} subtitle={due ? `Due ${due}` : undefined} />
      <Card style={{ gap: 6 }}>
        {amount && <Text style={{ fontSize: 20, fontWeight: "700", color: theme.colors.textPrimary }}>{amount}</Text>}
        <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
          Autopay: {bill.autopayBelieved == null ? "Unknown" : bill.autopayBelieved ? "Yes" : "No"}
        </Text>
      </Card>
      <EvidenceCard evidence={evidence} />
    </Screen>
  );
}
