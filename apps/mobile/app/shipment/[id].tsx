import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";
import { EvidenceCard, type Evidence } from "@/components/evidence-card";
import { FetchError } from "@/components/fetch-error";
import { formatTemporal, type TemporalValueLike } from "@/lib/format";

interface ShipmentDetail {
  shipment: {
    carrier: string;
    trackingNumber: string;
    status: string;
    estimatedDelivery: TemporalValueLike | null;
    deliveredAt: string | null;
    isGiftPrivate: boolean;
  };
  purchase: { id: string; orderNumber: string | null } | null;
  evidence: Evidence | null;
}

// Kept in sync with apps/web's shipment detail page: missing "returned_to_sender"/"lost" made both fall
// through to the "neutral" default instead of the critical status they actually are.
const STATUS_TONE: Record<string, "positive" | "warning" | "neutral" | "critical"> = {
  delivered: "positive",
  out_for_delivery: "warning",
  in_transit: "neutral",
  label_created: "neutral",
  exception: "warning",
  returned_to_sender: "critical",
  lost: "critical",
};

export default function ShipmentDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { theme } = useAppTheme();
  const [data, setData] = useState<ShipmentDetail | null | undefined>(undefined);
  // A bare `.then` with no `.catch` on a mount-time fetch becomes an unhandled promise rejection on any
  // transient network failure, which React Native Web surfaces as a full-screen "Uncaught Error" dev
  // overlay blocking the entire app, not just this screen (confirmed live — see entity/[id].tsx's identical
  // fix and doc comment).
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  // Found live: no reusable load function existed here — a transient 500/network error left the user
  // permanently stuck on "Something went wrong" with no in-place recovery. Mirrors bill/[id].tsx's
  // identical fix: wired to FetchError's own Retry button instead.
  const load = useCallback(() => {
    setError(null);
    api
      .get<ShipmentDetail | null>(`/v1/shipments/${id}`)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load this. Please try again."))
      .finally(() => setRetrying(false));
  }, [id]);

  useEffect(load, [load]);

  if (error) {
    return (
      <Screen>
        <ScreenHeader title="Something went wrong" />
        <FetchError
          message={error}
          what="this shipment"
          retrying={retrying}
          onRetry={() => {
            setRetrying(true);
            load();
          }}
        />
      </Screen>
    );
  }
  if (data === undefined) {
    return (
      <Screen>
        <View style={{ height: 120, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />
      </Screen>
    );
  }
  if (!data) {
    return (
      <Screen>
        <ScreenHeader title="Not found" />
        <EmptyState title="Not found" description="This shipment doesn't exist or you don't have access to it." />
      </Screen>
    );
  }

  const { shipment, purchase, evidence } = data;
  const estimated = shipment.estimatedDelivery ? formatTemporal(shipment.estimatedDelivery) : null;

  return (
    <Screen>
      <ScreenHeader title={shipment.carrier} subtitle={shipment.trackingNumber} />
      <Card style={{ gap: 6 }}>
        <Badge tone={STATUS_TONE[shipment.status] ?? "neutral"}>{shipment.status.replace(/_/g, " ")}</Badge>
        {estimated && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Estimated delivery: {estimated}</Text>}
        {shipment.deliveredAt && (
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
            Delivered {new Date(shipment.deliveredAt).toLocaleDateString()}
          </Text>
        )}
        {purchase && (
          <Text accessibilityRole="button" style={{ fontSize: 13, color: theme.colors.brandDefault }} onPress={() => router.push(`/purchase/${purchase.id}`)}>
            {purchase.orderNumber ?? "View order"} →
          </Text>
        )}
        {shipment.isGiftPrivate && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Marked as a private gift</Text>}
      </Card>
      <EvidenceCard evidence={evidence} />
    </Screen>
  );
}
