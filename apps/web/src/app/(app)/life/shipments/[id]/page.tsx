"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { swrFetcher, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { FetchError } from "@/components/ui/fetch-error";
import { EvidenceCard, type Evidence } from "@/components/evidence-card";
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
  };
  purchase: { id: string; orderNumber: string | null } | null;
  evidence: Evidence | null;
}

// Must cover every value of ShipmentExtractionSchema's status enum (services/api's
// extraction-schemas.ts) — "returned_to_sender" and "lost" were missing here, silently falling back to
// "neutral" (the same tone as routine "in transit") even though SHIP-003 in the spec calls for exception-
// like outcomes to rank/stand out above routine statuses.
const STATUS_TONE: Record<string, "positive" | "warning" | "neutral" | "critical"> = {
  delivered: "positive",
  out_for_delivery: "warning",
  in_transit: "neutral",
  label_created: "neutral",
  exception: "warning",
  returned_to_sender: "critical",
  lost: "critical",
};

export default function ShipmentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, isLoading, mutate } = useSWR<ShipmentDetail | null>(`/v1/shipments/${id}`, swrFetcher);

  if (isLoading) return <div className="h-40 animate-pulse rounded-xl bg-subtle" />;
  if (error && !data) {
    return (
      <div className="space-y-6">
        <Link href="/life" className="text-sm text-tertiary hover:text-primary">
          ← Back to Life
        </Link>
        <FetchError what="this shipment" message={error instanceof ApiError ? error.message : undefined} onRetry={() => mutate()} />
      </div>
    );
  }
  if (!data) return <EmptyState title="Not found" description="This shipment doesn't exist or you don't have access to it." />;

  const { shipment, purchase, evidence } = data;
  const estimated = shipment.estimatedDelivery ? formatTemporal(shipment.estimatedDelivery) : null;

  return (
    <div className="space-y-6">
      <Link href="/life" className="text-sm text-tertiary hover:text-primary">
        ← Back to Life
      </Link>
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">{shipment.carrier}</h1>
          <p className="mt-1 font-mono text-sm text-tertiary">{shipment.trackingNumber}</p>
        </div>
        <Badge tone={STATUS_TONE[shipment.status] ?? "neutral"}>{shipment.status.replace(/_/g, " ")}</Badge>
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
                <dd className="text-primary">
                  {new Date(shipment.deliveredAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                </dd>
              </>
            )}
            {purchase && (
              <>
                <dt className="text-tertiary">Order</dt>
                <dd className="text-primary">
                  <Link href={`/life/purchases/${purchase.id}`} className="text-brand hover:underline">
                    {purchase.orderNumber ?? "View order"}
                  </Link>
                </dd>
              </>
            )}
            {shipment.isGiftPrivate && (
              <>
                <dt className="text-tertiary">Privacy</dt>
                <dd className="text-primary">Marked as a private gift</dd>
              </>
            )}
          </dl>
        </CardBody>
      </Card>

      <EvidenceCard evidence={evidence} />
    </div>
  );
}
