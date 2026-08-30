import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { api } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";
import { EvidenceCard, type Evidence } from "@/components/evidence-card";
import { HistorySection } from "@/components/history-section";
import { formatTemporal, type TemporalValueLike } from "@/lib/format";

interface ShipmentDetail {
  shipment: {
    id: string;
    carrier: string;
    trackingNumber: string;
    status: string;
    estimatedDelivery: TemporalValueLike | null;
    deliveredAt: string | null;
    isGiftPrivate: boolean;
    merchantName: string | null;
    purchaseId: string | null;
  };
  evidence: Evidence | null;
}

const STATUS_TONE: Record<string, "neutral" | "warning" | "positive"> = {
  label_created: "neutral",
  in_transit: "warning",
  out_for_delivery: "warning",
  delivered: "positive",
  exception: "warning",
};

export default function ShipmentDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { theme } = useAppTheme();
  const router = useRouter();
  const [data, setData] = useState<ShipmentDetail | null | undefined>(undefined);

  useEffect(() => {
    api.get<ShipmentDetail | null>(`/v1/shipments/${id}`).then(setData);
  }, [id]);

  if (data === undefined) return <Screen><View style={{ height: 120, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} /></Screen>;
  if (!data) return <Screen><ScreenHeader title="Not found" /><EmptyState title="Not found" description="This shipment doesn't exist or you don't have access to it." /></Screen>;

  const { shipment, evidence } = data;
  const estimated = formatTemporal(shipment.estimatedDelivery);

  return (
    <Screen>
      <ScreenHeader
        title={shipment.merchantName ?? shipment.carrier}
        subtitle={`${shipment.carrier} · ${shipment.trackingNumber}`}
      />
      <Card style={{ gap: 6 }}>
        <Badge tone={STATUS_TONE[shipment.status] ?? "neutral"}>{shipment.status.replace(/_/g, " ")}</Badge>
        {estimated && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Estimated delivery: {estimated}</Text>}
        {shipment.deliveredAt && (
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
            Delivered: {new Date(shipment.deliveredAt).toLocaleDateString()}
          </Text>
        )}
        {shipment.isGiftPrivate && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Kept private from the recipient</Text>}
        {shipment.purchaseId && (
          <Button variant="secondary" onPress={() => router.push(`/purchase/${shipment.purchaseId}`)}>
            View purchase
          </Button>
        )}
      </Card>
      <HistorySection resourceType="shipment" resourceId={id} />
      <EvidenceCard evidence={evidence} />
    </Screen>
  );
}
