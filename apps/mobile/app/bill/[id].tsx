import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";
import { EvidenceCard, type Evidence } from "@/components/evidence-card";
import { FetchError } from "@/components/fetch-error";
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
    billerLabel: string;
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

export default function BillDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { theme } = useAppTheme();
  const [data, setData] = useState<BillDetail | null | undefined>(undefined);
  // A bare `.then` with no `.catch` on a mount-time fetch becomes an unhandled promise rejection on any
  // transient network failure, which React Native Web surfaces as a full-screen "Uncaught Error" dev
  // overlay blocking the entire app, not just this screen (confirmed live — see entity/[id].tsx's identical
  // fix and doc comment).
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  // Found live: this screen had no reusable load function at all — just a one-shot fetch inside
  // useEffect — so a transient 500/network error left the user permanently stuck on "Something went
  // wrong" with literally no way to recover short of navigating away and back to remount the screen. Every
  // other detail screen with this same error branch had the identical gap; wired to FetchError's Retry
  // button here (mirrors apps/web's own FetchError usage) instead of inventing a one-off recovery path.
  const load = useCallback(() => {
    setError(null);
    api
      .get<BillDetail | null>(`/v1/bills/${id}`)
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
          what="this bill"
          retrying={retrying}
          onRetry={() => {
            setRetrying(true);
            load();
          }}
        />
      </Screen>
    );
  }
  if (data === undefined) return <Screen><View style={{ height: 120, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" /></Screen>;
  if (!data) return <Screen><ScreenHeader title="Not found" /><EmptyState title="Not found" description="This bill doesn't exist or you don't have access to it." /></Screen>;

  const { bill, evidence, baselineComparison } = data;
  const due = formatTemporal(bill.dueDate);
  const amount = formatMoneyMinorUnits(bill.amountDueMinorUnits, bill.amountDueCurrency);
  const equipmentReturnDue = formatTemporal(bill.equipmentReturnDeadline);

  return (
    <Screen>
      <ScreenHeader title={bill.billerLabel} subtitle={due ? `Due ${due}` : undefined} />
      <Card style={{ gap: 6 }}>
        {amount && <Text style={{ fontSize: 20, fontWeight: "700", color: theme.colors.textPrimary }}>{amount}</Text>}
        {/* BILL-002 "distinguish 'due' from 'likely handled'" — paymentObservedTransactionId is stamped
            by PlaidAdapter.matchTransaction once a posted bank transaction matches this bill. */}
        <Badge tone={bill.paymentObservedTransactionId ? "positive" : "neutral"}>
          {bill.paymentObservedTransactionId ? "Payment observed" : "Not yet paid"}
        </Badge>
        <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
          Autopay: {bill.autopayBelieved == null ? "Unknown" : bill.autopayBelieved ? "Yes" : "No"}
        </Text>
      </Card>

      {/* UTIL-001 "Shows current bill vs prior/seasonal baseline" — mirrors apps/web's identical banner;
          see CommerceService.computeBillBaseline's own doc comment for the >25%-above-average threshold. */}
      {baselineComparison && (
        <Card
          style={
            baselineComparison.isSignificantlyAboveBaseline
              ? { gap: 4, borderLeftWidth: 4, borderLeftColor: theme.colors.warning }
              : { gap: 4 }
          }
        >
          <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>
            {baselineComparison.diffMinorUnits > 0
              ? `This bill is ${formatMoneyMinorUnits(baselineComparison.diffMinorUnits, baselineComparison.currency)} higher than your typical ${baselineComparison.billerCategoryLabel ?? bill.billerLabel} bill.`
              : baselineComparison.diffMinorUnits < 0
                ? `This bill is ${formatMoneyMinorUnits(-baselineComparison.diffMinorUnits, baselineComparison.currency)} lower than your typical ${baselineComparison.billerCategoryLabel ?? bill.billerLabel} bill.`
                : `This bill matches your typical ${baselineComparison.billerCategoryLabel ?? bill.billerLabel} bill.`}
          </Text>
          <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
            Based on your last {baselineComparison.sampleSize} bill{baselineComparison.sampleSize === 1 ? "" : "s"} from {bill.billerLabel}, averaging{" "}
            {formatMoneyMinorUnits(baselineComparison.averageMinorUnits, baselineComparison.currency)}.
          </Text>
        </Card>
      )}

      {/* UTIL-001 "equipment return obligations ... from source messages where available" — explicit-only,
          see IngestionService.extractBill's system prompt; this section simply doesn't render otherwise. */}
      {(equipmentReturnDue || bill.equipmentReturnInstructions) && (
        <Card style={{ gap: 4 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Equipment return</Text>
          {equipmentReturnDue && <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>Return by {equipmentReturnDue}.</Text>}
          {bill.equipmentReturnInstructions && (
            <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>{bill.equipmentReturnInstructions}</Text>
          )}
        </Card>
      )}

      <EvidenceCard evidence={evidence} />
    </Screen>
  );
}
