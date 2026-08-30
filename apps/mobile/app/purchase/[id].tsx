import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { api } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { EmptyState } from "@/components/empty-state";

const MARKABLE_STATES = [
  { value: "kept", label: "Keeping it" },
  { value: "gifted", label: "Gifted" },
  { value: "sold", label: "Sold" },
  { value: "return_started", label: "Returning" },
  { value: "disposed", label: "Disposed" },
];
import { ScreenHeader } from "@/components/screen-header";
import { EvidenceCard, type Evidence } from "@/components/evidence-card";
import { HistorySection } from "@/components/history-section";
import { formatMoneyMinorUnits, formatTemporal, type TemporalValueLike } from "@/lib/format";

interface PurchaseDetail {
  purchase: {
    orderNumber: string | null;
    purchaseDate: TemporalValueLike;
    totalMinorUnits: number | null;
    totalCurrency: string | null;
    state: string;
    confidenceBand: string;
    merchantName: string | null;
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

  async function markState(state: string) {
    await api.post(`/v1/purchases/${id}/state`, { state });
    setData(await api.get<PurchaseDetail>(`/v1/purchases/${id}`));
  }

  return (
    <Screen>
      <ScreenHeader
        title={purchase.merchantName ?? `Order ${purchase.orderNumber ?? "—"}`}
        subtitle={
          purchase.merchantName && purchase.orderNumber
            ? `Order ${purchase.orderNumber}${date ? ` · ${date}` : ""}`
            : (date ?? undefined)
        }
      />
      <Card style={{ gap: 6 }}>
        {total && <Text style={{ fontSize: 20, fontWeight: "700", color: theme.colors.textPrimary }}>{total}</Text>}
        <Badge tone="neutral">{purchase.confidenceBand.replace("_", " ")}</Badge>
        <Text style={{ fontSize: 13, color: theme.colors.textTertiary, textTransform: "capitalize" }}>{purchase.state.replace("_", " ")}</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, paddingTop: 10 }}>
          {MARKABLE_STATES.map((s) => {
            const active = purchase.state === s.value;
            return (
              <Pressable
                key={s.value}
                onPress={() => markState(s.value)}
                accessibilityRole="button"
                accessibilityLabel={s.label}
                accessibilityState={{ selected: active }}
                style={{
                  paddingVertical: 6,
                  paddingHorizontal: 10,
                  borderRadius: theme.radius.sm,
                  backgroundColor: active ? theme.colors.brandDefault : theme.colors.bgSubtle,
                }}
              >
                <Text style={{ fontSize: 12, fontWeight: "600", color: active ? theme.colors.textOnBrand : theme.colors.textPrimary }}>{s.label}</Text>
              </Pressable>
            );
          })}
        </View>
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

      <HistorySection resourceType="purchase" resourceId={id} showRelatedKinds={["warranty"]} />
      <EvidenceCard evidence={evidence} />
    </Screen>
  );
}
