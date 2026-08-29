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
import { formatMoneyMinorUnits, formatTemporal, daysUntil, type TemporalValueLike } from "@/lib/format";

interface ReturnDetail {
  returnCase: {
    id: string;
    state: string;
    deadline: TemporalValueLike;
    valueAtStakeMinorUnits: number | null;
    valueAtStakeCurrency: string | null;
    trackingNumber: string | null;
  };
  purchase: { id: string; orderNumber: string | null };
  evidence: Evidence | null;
}

export default function ReturnDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useSWR<ReturnDetail | null>(`/v1/returns/${id}`, swrFetcher);

  if (isLoading) return <div className="h-40 animate-pulse rounded-xl bg-subtle" />;
  if (!data) return <EmptyState title="Not found" description="This return doesn't exist or you don't have access to it." />;

  const { returnCase, purchase, evidence } = data;
  const deadline = formatTemporal(returnCase.deadline);
  const value = formatMoneyMinorUnits(returnCase.valueAtStakeMinorUnits, returnCase.valueAtStakeCurrency);
  const days = daysUntil(returnCase.deadline);

  return (
    <div className="space-y-6">
      <Link href="/life" className="text-sm text-tertiary hover:text-primary">
        ← Back to Life
      </Link>
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">
            Return for order{" "}
            <Link href={`/life/purchases/${purchase.id}`} className="text-brand hover:underline">
              {purchase.orderNumber ?? purchase.id}
            </Link>
          </h1>
          {deadline && <p className="mt-1 text-sm text-tertiary">Deadline {deadline}</p>}
        </div>
        {days != null && <Badge tone={days <= 3 ? "critical" : "warning"}>{days > 0 ? `${days}d left` : "Due today"}</Badge>}
      </header>

      <Card>
        <CardBody className="space-y-2">
          <p className="text-sm font-medium text-primary">Details</p>
          <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[auto_1fr]">
            {value && (
              <>
                <dt className="text-tertiary">Value at stake</dt>
                <dd className="text-primary">{value}</dd>
              </>
            )}
            <dt className="text-tertiary">Status</dt>
            <dd className="text-primary capitalize">{returnCase.state.replace("_", " ")}</dd>
            {returnCase.trackingNumber && (
              <>
                <dt className="text-tertiary">Tracking</dt>
                <dd className="text-primary">{returnCase.trackingNumber}</dd>
              </>
            )}
          </dl>
        </CardBody>
      </Card>

      <HistorySection resourceType="return_case" resourceId={returnCase.id} />

      <EvidenceCard evidence={evidence} />
    </div>
  );
}
