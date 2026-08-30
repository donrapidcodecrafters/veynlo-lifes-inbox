"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { swrFetcher } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
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

function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

export default function ShipmentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useSWR<ShipmentDetail | null>(`/v1/shipments/${id}`, swrFetcher);

  if (isLoading) return <div className="h-40 animate-pulse rounded-xl bg-subtle" />;
  if (!data) return <EmptyState title="Not found" description="This shipment doesn't exist or you don't have access to it." />;

  const { shipment, evidence } = data;
  const estimated = formatTemporal(shipment.estimatedDelivery);

  return (
    <div className="space-y-6">
      <Link href="/life" className="text-sm text-tertiary hover:text-primary">
        ← Back to Life
      </Link>
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">{shipment.merchantName ?? shipment.carrier}</h1>
          <p className="mt-1 text-sm text-tertiary">
            {shipment.carrier} · {shipment.trackingNumber}
          </p>
        </div>
        <Badge tone={STATUS_TONE[shipment.status] ?? "neutral"}>{statusLabel(shipment.status)}</Badge>
      </header>

      <Card>
        <CardBody className="space-y-2">
          <p className="text-sm font-medium text-primary">Details</p>
          <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[auto_1fr]">
            {estimated && (
              <>
                <dt className="text-tertiary">Estimated delivery</dt>
                <dd className="text-primary">{estimated}</dd>
              </>
            )}
            {shipment.deliveredAt && (
              <>
                <dt className="text-tertiary">Delivered</dt>
                <dd className="text-primary">{new Date(shipment.deliveredAt).toLocaleDateString()}</dd>
              </>
            )}
            {shipment.purchaseId && (
              <>
                <dt className="text-tertiary">Order</dt>
                <dd className="text-primary">
                  <Link href={`/life/purchases/${shipment.purchaseId}`} className="text-brand-default hover:underline">
                    View purchase →
                  </Link>
                </dd>
              </>
            )}
            {shipment.isGiftPrivate && (
              <>
                <dt className="text-tertiary">Gift</dt>
                <dd className="text-primary">Kept private from the recipient</dd>
              </>
            )}
          </dl>
        </CardBody>
      </Card>

      <HistorySection resourceType="shipment" resourceId={shipment.id} />

      <EvidenceCard
        evidence={evidence}
        highlightTerms={[shipment.carrier, shipment.trackingNumber, estimated].filter((v): v is string => Boolean(v))}
      />
    </div>
  );
}
