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
import { formatMoneyMinorUnits } from "@/lib/format";

interface SubscriptionDetail {
  subscription: { id: string; state: string; trialEndsAt: unknown; cancellationInstructionsUrl: string | null };
  stream: { serviceLabel: string; cadence: string; typicalAmountMinorUnits: number | null; typicalAmountCurrency: string | null; essential: boolean | null };
  evidence: Evidence | null;
}

export default function SubscriptionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useSWR<SubscriptionDetail | null>(`/v1/subscriptions/${id}`, swrFetcher);

  if (isLoading) return <div className="h-40 animate-pulse rounded-xl bg-subtle" />;
  if (!data) return <EmptyState title="Not found" description="This subscription doesn't exist or you don't have access to it." />;

  const { subscription, stream, evidence } = data;
  const amount = formatMoneyMinorUnits(stream.typicalAmountMinorUnits, stream.typicalAmountCurrency);

  return (
    <div className="space-y-6">
      <Link href="/life" className="text-sm text-tertiary hover:text-primary">
        ← Back to Life
      </Link>
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">{stream.serviceLabel}</h1>
          <p className="mt-1 text-sm capitalize text-tertiary">{stream.cadence}</p>
        </div>
        {subscription.state === "price_changed" && <Badge tone="warning">Price changed</Badge>}
      </header>

      <Card>
        <CardBody className="space-y-2">
          <p className="text-sm font-medium text-primary">Details</p>
          <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[auto_1fr]">
            {amount && (
              <>
                <dt className="text-tertiary">Amount</dt>
                <dd className="text-primary">{amount}</dd>
              </>
            )}
            <dt className="text-tertiary">Essential</dt>
            <dd className="text-primary">{stream.essential == null ? "Unknown" : stream.essential ? "Yes" : "No"}</dd>
            {subscription.cancellationInstructionsUrl && (
              <>
                <dt className="text-tertiary">Cancel</dt>
                <dd className="text-primary">
                  <a href={subscription.cancellationInstructionsUrl} target="_blank" rel="noreferrer" className="text-brand hover:underline">
                    Cancellation instructions
                  </a>
                </dd>
              </>
            )}
          </dl>
        </CardBody>
      </Card>

      <HistorySection resourceType="subscription" resourceId={subscription.id} />

      <EvidenceCard evidence={evidence} />
    </div>
  );
}
