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
import { formatMoneyMinorUnits, formatTemporal, type TemporalValueLike } from "@/lib/format";

interface BillBaselineComparison {
  billerCategory: string | null;
  billerCategoryLabel: string | null;
  sampleSize: number;
  currentMinorUnits: number;
  averageMinorUnits: number;
  diffMinorUnits: number;
  currency: string;
  percentAboveBaseline: number;
  isSignificantlyAboveBaseline: boolean;
  isBelowBaseline: boolean;
}

interface BillDetail {
  bill: {
    id: string;
    billerLabel: string;
    billerCategory: string | null;
    amountDueMinorUnits: number | null;
    amountDueCurrency: string | null;
    dueDate: TemporalValueLike;
    autopayBelieved: boolean | null;
    paymentObservedTransactionId: string | null;
    equipmentReturnDeadline: TemporalValueLike;
    equipmentReturnInstructions: string | null;
  };
  evidence: Evidence | null;
  baselineComparison: BillBaselineComparison | null;
}

export default function BillDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, isLoading, mutate } = useSWR<BillDetail | null>(`/v1/bills/${id}`, swrFetcher);

  if (isLoading) return <div className="h-40 animate-pulse rounded-xl bg-subtle" />;
  if (error && !data) {
    return (
      <div className="space-y-6">
        <Link href="/life" className="text-sm text-tertiary hover:text-primary">
          ← Back to Life
        </Link>
        <FetchError what="this bill" message={error instanceof ApiError ? error.message : undefined} onRetry={() => mutate()} />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="space-y-6">
        <Link href="/life" className="text-sm text-tertiary hover:text-primary">
          ← Back to Life
        </Link>
        <EmptyState title="Not found" description="This bill doesn't exist or you don't have access to it." />
      </div>
    );
  }

  const { bill, evidence, baselineComparison } = data;
  const due = formatTemporal(bill.dueDate);
  const amount = formatMoneyMinorUnits(bill.amountDueMinorUnits, bill.amountDueCurrency);
  const equipmentReturnDue = formatTemporal(bill.equipmentReturnDeadline);

  return (
    <div className="space-y-6">
      <Link href="/life" className="text-sm text-tertiary hover:text-primary">
        ← Back to Life
      </Link>
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">{bill.billerLabel}</h1>
          {due && <p className="mt-1 text-sm text-tertiary">Due {due}</p>}
        </div>
        {/* BILL-002 "distinguish 'due' from 'likely handled'" — paymentObservedTransactionId is stamped
            by PlaidAdapter.matchTransaction once a posted bank transaction matches this bill; previously
            this fact was captured in the database but never shown anywhere in the UI. */}
        <Badge tone={bill.paymentObservedTransactionId ? "positive" : "neutral"}>
          {bill.paymentObservedTransactionId ? "Payment observed" : "Not yet paid"}
        </Badge>
      </header>

      {/* UTIL-001 "Shows current bill vs prior/seasonal baseline" — CommerceService.computeBillBaseline
          compares this bill's amount to the average of this same biller's prior bills (up to the last 12);
          null when there isn't enough history yet (fewer than 2 prior bills) rather than a meaningless
          "average of one." Only calls out the banner in warning tone when the bill is >25% above that
          average — a smaller, unremarkable difference still shows the comparison, just without the alert
          styling, so the number is always available without implying every deviation is a problem. */}
      {baselineComparison && (
        <Card>
          <CardBody className={baselineComparison.isSignificantlyAboveBaseline ? "space-y-1.5 border-l-4 border-warning-subtle-text pl-4" : "space-y-1.5"}>
            <p className="text-sm font-medium text-primary">
              {baselineComparison.diffMinorUnits > 0
                ? `This bill is ${formatMoneyMinorUnits(baselineComparison.diffMinorUnits, baselineComparison.currency)} higher than your typical ${baselineComparison.billerCategoryLabel ?? bill.billerLabel} bill.`
                : baselineComparison.diffMinorUnits < 0
                  ? `This bill is ${formatMoneyMinorUnits(-baselineComparison.diffMinorUnits, baselineComparison.currency)} lower than your typical ${baselineComparison.billerCategoryLabel ?? bill.billerLabel} bill.`
                  : `This bill matches your typical ${baselineComparison.billerCategoryLabel ?? bill.billerLabel} bill.`}
            </p>
            <p className="text-xs text-tertiary">
              Based on your last {baselineComparison.sampleSize} bill{baselineComparison.sampleSize === 1 ? "" : "s"} from {bill.billerLabel}, averaging{" "}
              {formatMoneyMinorUnits(baselineComparison.averageMinorUnits, baselineComparison.currency)}.
            </p>
          </CardBody>
        </Card>
      )}

      {/* UTIL-001 "equipment return obligations ... from source messages where available" — explicit-only:
          bills.equipmentReturnDeadline/.equipmentReturnInstructions are only ever populated when the source
          email literally stated a hardware-return obligation (see IngestionService.extractBill's system
          prompt), so this section simply doesn't render for the vast majority of bills. */}
      {(equipmentReturnDue || bill.equipmentReturnInstructions) && (
        <Card>
          <CardBody className="space-y-1.5">
            <p className="text-sm font-medium text-primary">Equipment return</p>
            {equipmentReturnDue && <p className="text-sm text-primary">Return by {equipmentReturnDue}.</p>}
            {bill.equipmentReturnInstructions && <p className="text-sm text-tertiary">{bill.equipmentReturnInstructions}</p>}
          </CardBody>
        </Card>
      )}

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
            <dt className="text-tertiary">Payment</dt>
            <dd className="text-primary">
              {bill.paymentObservedTransactionId
                ? "A matching bank transaction was observed for this bill."
                : "No matching bank transaction has been observed yet."}
            </dd>
          </dl>
        </CardBody>
      </Card>

      <EvidenceCard evidence={evidence} />
    </div>
  );
}
