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
import { formatMoneyMinorUnits, formatTemporal, type TemporalValueLike } from "@/lib/format";

interface PurchaseDetail {
  purchase: {
    orderNumber: string | null;
    purchaseDate: TemporalValueLike;
    totalMinorUnits: number | null;
    totalCurrency: string | null;
    state: string;
    confidenceBand: string;
  };
  lines: Array<{ id: string; productLabel: string; quantity: number; unitPriceMinorUnits: number | null }>;
  returns: Array<{ id: string; state: string; deadline: TemporalValueLike }>;
  shipments: Array<{ id: string; carrier: string; trackingNumber: string; status: string }>;
  evidence: Evidence | null;
}

export default function PurchaseDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { theme } = useAppTheme();
  const [data, setData] = useState<PurchaseDetail | null | undefined>(undefined);

  useEffect(() => {
    api.get<PurchaseDetail | null>(`/v1/purchases/${id}`).then(setData);
  }, [id]);

  if (data === undefined) return <Screen><View style={{ height: 120, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} /></Screen>;
  if (!data) return <Screen><ScreenHeader title="Not found" /><EmptyState title="Not found" description="This purchase doesn't exist or you don't have access to it." /></Screen>;

  const { purchase, lines, returns, shipments, evidence } = data;
  const date = formatTemporal(purchase.purchaseDate);
  const total = formatMoneyMinorUnits(purchase.totalMinorUnits, purchase.totalCurrency);

  return (
    <Screen>
      <ScreenHeader title={`Order ${purchase.orderNumber ?? "—"}`} subtitle={date ?? undefined} />
      <Card style={{ gap: 6 }}>
        {total && <Text style={{ fontSize: 20, fontWeight: "700", color: theme.colors.textPrimary }}>{total}</Text>}
        <Badge tone="neutral">{purchase.confidenceBand.replace("_", " ")}</Badge>
        <Text style={{ fontSize: 13, color: theme.colors.textTertiary, textTransform: "capitalize" }}>{purchase.state.replace("_", " ")}</Text>
      </Card>

      {lines.length > 0 && (
        <Card style={{ gap: 8 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Items</Text>
          {lines.map((line) => (
            <View key={line.id} style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={{ fontSize: 13, color: theme.colors.textPrimary, flex: 1 }}>
                {line.quantity > 1 ? `${line.quantity}× ` : ""}
                {line.productLabel}
              </Text>
              {line.unitPriceMinorUnits != null && (
                <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>{formatMoneyMinorUnits(line.unitPriceMinorUnits, purchase.totalCurrency)}</Text>
              )}
            </View>
          ))}
        </Card>
      )}

      {returns.length > 0 && (
        <Card style={{ gap: 8 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Returns</Text>
          {returns.map((r) => (
            <Text
              key={r.id}
              style={{ fontSize: 13, color: theme.colors.brandDefault }}
              onPress={() => router.push(`/return-case/${r.id}`)}
            >
              Return case — {formatTemporal(r.deadline) ?? r.state}
            </Text>
          ))}
        </Card>
      )}

      {shipments.length > 0 && (
        <Card style={{ gap: 8 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Shipments</Text>
          {shipments.map((s) => (
            <Text key={s.id} style={{ fontSize: 13, color: theme.colors.textPrimary }}>
              {s.carrier} — {s.trackingNumber} ({s.status.replace("_", " ")})
            </Text>
          ))}
        </Card>
      )}

      <EvidenceCard evidence={evidence} />
    </Screen>
  );
}
