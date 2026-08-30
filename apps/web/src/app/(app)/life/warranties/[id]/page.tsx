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
import { formatTemporal, daysUntil, type TemporalValueLike } from "@/lib/format";

interface WarrantyDetail {
  warranty: {
    id: string;
    productLabel: string;
    warrantyLengthMonths: number | null;
    expirationDate: TemporalValueLike;
    registrationConfirmed: boolean | null;
  };
  evidence: Evidence | null;
}

export default function WarrantyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useSWR<WarrantyDetail | null>(`/v1/warranties/${id}`, swrFetcher);

  if (isLoading) return <div className="h-40 animate-pulse rounded-xl bg-subtle" />;
  if (!data) return <EmptyState title="Not found" description="This warranty doesn't exist or you don't have access to it." />;

  const { warranty, evidence } = data;
  const expires = formatTemporal(warranty.expirationDate);
  const days = daysUntil(warranty.expirationDate);

  return (
    <div className="space-y-6">
      <Link href="/life" className="text-sm text-tertiary hover:text-primary">
        ← Back to Life
      </Link>
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">{warranty.productLabel}</h1>
          {expires && <p className="mt-1 text-sm text-tertiary">Expires {expires}</p>}
        </div>
        {days != null && <Badge tone={days <= 30 ? "warning" : "neutral"}>{days > 0 ? `${days}d left` : "Expired"}</Badge>}
      </header>

      <Card>
        <CardBody className="space-y-2">
          <p className="text-sm font-medium text-primary">Details</p>
          <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[auto_1fr]">
            {warranty.warrantyLengthMonths != null && (
              <>
                <dt className="text-tertiary">Length</dt>
                <dd className="text-primary">{warranty.warrantyLengthMonths} months</dd>
              </>
            )}
            <dt className="text-tertiary">Registered</dt>
            <dd className="text-primary">{warranty.registrationConfirmed == null ? "Unknown" : warranty.registrationConfirmed ? "Yes" : "No"}</dd>
          </dl>
        </CardBody>
      </Card>

      <HistorySection resourceType="warranty" resourceId={warranty.id} />

      <EvidenceCard evidence={evidence} highlightTerms={[warranty.productLabel, expires].filter((v): v is string => Boolean(v))} />
    </div>
  );
}
