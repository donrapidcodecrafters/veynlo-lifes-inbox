"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { swrFetcher } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { EvidenceCard, type Evidence } from "@/components/evidence-card";
import { HistorySection } from "@/components/history-section";
import { formatMoneyMinorUnits, formatTemporal, type TemporalValueLike } from "@/lib/format";

interface BillDetail {
  bill: {
    id: string;
    billerLabel: string;
    amountDueMinorUnits: number | null;
    amountDueCurrency: string | null;
    dueDate: TemporalValueLike;
    autopayBelieved: boolean | null;
  };
  evidence: Evidence | null;
}

export default function BillDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useSWR<BillDetail | null>(`/v1/bills/${id}`, swrFetcher);

  if (isLoading) return <div className="h-40 animate-pulse rounded-xl bg-subtle" />;
  if (!data) return <EmptyState title="Not found" description="This bill doesn't exist or you don't have access to it." />;

  const { bill, evidence } = data;
  const due = formatTemporal(bill.dueDate);
  const amount = formatMoneyMinorUnits(bill.amountDueMinorUnits, bill.amountDueCurrency);

  return (
    <div className="space-y-6">
      <Link href="/life" className="text-sm text-tertiary hover:text-primary">
        ← Back to Life
      </Link>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">{bill.billerLabel}</h1>
        {due && <p className="mt-1 text-sm text-tertiary">Due {due}</p>}
      </header>

      <Card>
        <CardBody className="space-y-2">
          <p className="text-sm font-medium text-primary">Details</p>
          <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[auto_1fr]">
            {amount && (
              <>
                <dt className="text-tertiary">Amount due</dt>
                <dd className="text-primary">{amount}</dd>
              </>
            )}
            <dt className="text-tertiary">Autopay</dt>
            <dd className="text-primary">{bill.autopayBelieved == null ? "Unknown" : bill.autopayBelieved ? "Yes" : "No"}</dd>
          </dl>
        </CardBody>
      </Card>

      <HistorySection resourceType="bill" resourceId={bill.id} />

      <EvidenceCard evidence={evidence} />
    </div>
  );
}
