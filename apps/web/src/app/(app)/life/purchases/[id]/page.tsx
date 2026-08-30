"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { api, swrFetcher } from "@/lib/api-client";
import { invalidateDomainCaches } from "@/lib/cache-invalidation";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { EvidenceCard, type Evidence } from "@/components/evidence-card";
import { HistorySection } from "@/components/history-section";
import { formatMoneyMinorUnits, formatTemporal, type TemporalValueLike } from "@/lib/format";

interface PurchaseDetail {
  purchase: {
    id: string;
    orderNumber: string | null;
    purchaseDate: TemporalValueLike;
    totalMinorUnits: number | null;
    totalCurrency: string | null;
    taxMinorUnits: number | null;
    shippingMinorUnits: number | null;
    state: string;
    confidenceBand: string;
    merchantName: string | null;
  };
  lines: Array<{ id: string; productLabel: string; quantity: number; unitPriceMinorUnits: number | null; serialNumber: string | null }>;
  returns: Array<{ id: string; state: string; deadline: TemporalValueLike }>;
  shipments: Array<{ id: string; carrier: string; trackingNumber: string; status: string }>;
  evidence: Evidence | null;
}

const MARKABLE_STATES = [
  { value: "kept", label: "Keeping it" },
  { value: "gifted", label: "Gifted" },
  { value: "sold", label: "Sold" },
  { value: "return_started", label: "Returning" },
  { value: "disposed", label: "Disposed" },
];

export default function PurchaseDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, mutate } = useSWR<PurchaseDetail | null>(`/v1/purchases/${id}`, swrFetcher);

  if (isLoading) return <div className="h-40 animate-pulse rounded-xl bg-subtle" />;
  if (!data) return <EmptyState title="Not found" description="This purchase doesn't exist or you don't have access to it." />;

  const { purchase, lines, returns, shipments, evidence } = data;
  const date = formatTemporal(purchase.purchaseDate);
  const total = formatMoneyMinorUnits(purchase.totalMinorUnits, purchase.totalCurrency);

  async function markState(state: string) {
    await api.post(`/v1/purchases/${purchase.id}/state`, { state });
    mutate();
    invalidateDomainCaches();
  }

  return (
    <div className="space-y-6">
      <Link href="/life" className="text-sm text-tertiary hover:text-primary">
        ← Back to Life
      </Link>
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">
            {purchase.merchantName ?? `Order ${purchase.orderNumber ?? "—"}`}
          </h1>
          <p className="mt-1 text-sm text-tertiary">
            {purchase.merchantName && purchase.orderNumber ? `Order ${purchase.orderNumber}` : null}
            {purchase.merchantName && purchase.orderNumber && date ? " · " : null}
            {date}
          </p>
        </div>
        <Badge tone="neutral">{purchase.confidenceBand.replace("_", " ")}</Badge>
      </header>

      <Card>
        <CardBody className="space-y-2">
          <p className="text-sm font-medium text-primary">Details</p>
          <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[auto_1fr]">
            {total && (
              <>
                <dt className="text-tertiary">Total</dt>
                <dd className="text-primary">{total}</dd>
              </>
            )}
            <dt className="text-tertiary">Status</dt>
            <dd className="text-primary capitalize">{purchase.state.replace("_", " ")}</dd>
          </dl>
          <div className="flex flex-wrap gap-2 border-t border-border-subtle pt-3">
            {MARKABLE_STATES.map((s) => (
              <Button key={s.value} size="sm" variant={purchase.state === s.value ? "primary" : "secondary"} onClick={() => markState(s.value)}>
                {s.label}
              </Button>
            ))}
          </div>
        </CardBody>
      </Card>

      {lines.length > 0 && (
        <Card>
          <CardBody className="space-y-2">
            <p className="text-sm font-medium text-primary">Items</p>
            <div className="divide-y divide-border-subtle">
              {lines.map((line) => (
                <div key={line.id} className="flex items-center justify-between py-2 text-sm">
                  <span className="text-primary">
                    {line.quantity > 1 ? `${line.quantity}× ` : ""}
                    {line.productLabel}
                  </span>
                  {line.unitPriceMinorUnits != null && (
                    <span className="text-tertiary">{formatMoneyMinorUnits(line.unitPriceMinorUnits, purchase.totalCurrency)}</span>
                  )}
                </div>
              ))}
            </div>
          </CardBody>
        </Card>
      )}

      {returns.length > 0 && (
        <Card>
          <CardBody className="space-y-2">
            <p className="text-sm font-medium text-primary">Returns</p>
            {returns.map((r) => (
              <Link key={r.id} href={`/life/returns/${r.id}`} className="block text-sm text-brand hover:underline">
                Return case — {formatTemporal(r.deadline) ?? r.state}
              </Link>
            ))}
          </CardBody>
        </Card>
      )}

      {shipments.length > 0 && (
        <Card>
          <CardBody className="space-y-2">
            <p className="text-sm font-medium text-primary">Shipments</p>
            {shipments.map((s) => (
              <p key={s.id} className="text-sm text-primary">
                {s.carrier} — {s.trackingNumber} ({s.status.replace("_", " ")})
              </p>
            ))}
          </CardBody>
        </Card>
      )}

      <HistorySection resourceType="purchase" resourceId={purchase.id} showRelatedKinds={["warranty"]} />

      <EvidenceCard evidence={evidence} />
    </div>
  );
}
