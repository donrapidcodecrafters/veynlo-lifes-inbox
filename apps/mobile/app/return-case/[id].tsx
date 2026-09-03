import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";
import { EvidenceCard, type Evidence } from "@/components/evidence-card";
import { FetchError } from "@/components/fetch-error";
import { formatMoneyMinorUnits, formatTemporal, daysUntil, type TemporalValueLike } from "@/lib/format";

// §40.3 Return state machine — mirrors apps/web's identical set (see that file's own doc comment).
const RETURN_TERMINAL_STATES = new Set(["resolved", "refunded", "exchanged", "disputed", "closed"]);

// §40.3 Return state machine — `in_transit`/`merchant_received` are automatic, derived from the linked
// return shipment's real carrier status (CommerceService.syncReturnShippingStateFromLinkedShipment's own
// doc comment), never a manual button — mirrors apps/web's identical reasoning and label map.
const STATE_LABEL: Record<string, string> = {
  eligible: "Eligible to start",
  initiated: "Return started",
  label_ready: "Label/dropoff ready",
  in_transit: "In transit",
  merchant_received: "Received by merchant",
  refund_expected: "Refund expected",
  resolved: "Resolved",
  refunded: "Refunded",
  exchanged: "Exchanged",
  disputed: "Disputed",
  closed: "Closed",
};

interface ReturnDetail {
  returnCase: {
    state: string;
    deadline: TemporalValueLike;
    valueAtStakeMinorUnits: number | null;
    valueAtStakeCurrency: string | null;
    trackingNumber: string | null;
    refundObservedTransactionId: string | null;
  };
  purchase: { id: string; orderNumber: string | null };
  evidence: Evidence | null;
}

/**
 * §40.3 Return state machine, step 2 — `initiated → label/dropoff ready`. Mirrors apps/web's identical
 * LabelReadyForm; both fields optional, same reasoning as MarkReturnLabelReadyDtoSchema's own doc comment.
 */
function LabelReadyForm({ returnCaseId, onSaved }: { returnCaseId: string; onSaved: () => void }) {
  const { theme } = useAppTheme();
  const [open, setOpen] = useState(false);
  const [carrier, setCarrier] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      await api.post(`/v1/returns/${returnCaseId}/label-ready`, {
        carrier: carrier.trim() === "" ? undefined : carrier.trim(),
        trackingNumber: trackingNumber.trim() === "" ? undefined : trackingNumber.trim(),
      });
      setOpen(false);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't mark that ready.");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <Button onPress={() => setOpen(true)}>
        Mark label/dropoff ready
      </Button>
    );
  }

  return (
    <View style={{ gap: 8, borderWidth: 1, borderColor: theme.colors.borderSubtle, borderRadius: theme.radius.md, padding: 10 }}>
      <TextField label="Carrier (optional)" value={carrier} onChangeText={setCarrier} placeholder="e.g. UPS" />
      <TextField label="Tracking number (optional)" value={trackingNumber} onChangeText={setTrackingNumber} placeholder="e.g. 1Z999AA10123456784" />
      {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button loading={saving} onPress={submit}>
            Save
          </Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button variant="secondary" onPress={() => setOpen(false)}>
            Cancel
          </Button>
        </View>
      </View>
    </View>
  );
}

export default function ReturnDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { theme } = useAppTheme();
  const [data, setData] = useState<ReturnDetail | null | undefined>(undefined);
  // A bare `.then` with no `.catch` on a mount-time fetch becomes an unhandled promise rejection on any
  // transient network failure, which React Native Web surfaces as a full-screen "Uncaught Error" dev
  // overlay blocking the entire app, not just this screen (confirmed live — see entity/[id].tsx's identical
  // fix and doc comment).
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [closingOutcome, setClosingOutcome] = useState<string | null>(null);
  // Inline confirm state for the exchanged/disputed/closed outcomes — not RN's Alert.alert, matching this
  // app's own established convention (see purchase/[id].tsx's identical reasoning).
  const [confirmingOutcome, setConfirmingOutcome] = useState<"exchanged" | "disputed" | "closed" | null>(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    load();
  }, [id]);

  function load() {
    // `error` must be cleared at the start of every load — not just on success further down — or a
    // successful retry after a failed load leaves `error` (and therefore the FetchError early return
    // above) stuck forever, since nothing else ever resets it. Mirrors bill/[id].tsx's and event/[id].tsx's
    // identical `setError(null)` at the top of `load`.
    setError(null);
    api
      .get<ReturnDetail | null>(`/v1/returns/${id}`)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load this. Please try again."))
      .finally(() => setRetrying(false));
  }

  // The list views (Life tab, Home "Needs You") both expose "Mark refunded" for an open return case — this
  // detail screen (reached directly from a return-window attention item or a purchase's "View return" link)
  // had no way to do the same thing, so a user landing here first had to bounce back to a list just to
  // resolve it. Kept as-is alongside the newer granular actions below.
  async function resolveReturn() {
    setResolving(true);
    try {
      await api.post(`/v1/returns/${id}/resolve`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't mark that return refunded. Please try again.");
    } finally {
      setResolving(false);
    }
  }

  // §40.3 Return state machine, step 1 — `eligible → initiated`.
  async function initiateReturn() {
    setAdvancing(true);
    try {
      await api.post(`/v1/returns/${id}/initiate`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't start this return. Please try again.");
    } finally {
      setAdvancing(false);
    }
  }

  // §40.3 Return state machine, step 5 — reachable from label_ready/in_transit/merchant_received.
  async function markRefundExpected() {
    setAdvancing(true);
    try {
      await api.post(`/v1/returns/${id}/refund-expected`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't mark a refund expected yet. Please try again.");
    } finally {
      setAdvancing(false);
    }
  }

  // §40.3 Return state machine terminal fork — exchanged/disputed/closed; refunded keeps its own dedicated
  // button above, unchanged.
  async function closeReturn(outcome: "exchanged" | "disputed" | "closed") {
    setClosingOutcome(outcome);
    try {
      await api.post(`/v1/returns/${id}/close`, { outcome });
      setConfirmingOutcome(null);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't close this return. Please try again.");
    } finally {
      setClosingOutcome(null);
    }
  }

  // Guarded on `data === undefined` (not just `error` alone) so a reload that fails after this screen
  // already loaded successfully once doesn't blow away the already-loaded return view. Mirrors trip/[id].tsx's
  // identical guard.
  if (error && data === undefined) {
    return (
      <Screen>
        <ScreenHeader title="Something went wrong" />
        <FetchError
          message={error}
          what="this return"
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
  if (!data) return <Screen><ScreenHeader title="Not found" /><EmptyState title="Not found" description="This return doesn't exist or you don't have access to it." /></Screen>;

  const { returnCase, purchase, evidence } = data;
  const deadline = formatTemporal(returnCase.deadline);
  const value = formatMoneyMinorUnits(returnCase.valueAtStakeMinorUnits, returnCase.valueAtStakeCurrency);
  const days = daysUntil(returnCase.deadline);
  const isTerminal = RETURN_TERMINAL_STATES.has(returnCase.state);
  const canMarkRefundExpected = ["label_ready", "in_transit", "merchant_received"].includes(returnCase.state);
  // `purchase.orderNumber` can be null (candidate/low-confidence purchases the AI hasn't matched an order
  // number for yet) — falling back to the raw internal purchase id leaks a meaningless system identifier
  // into user-facing copy. Mirrors purchase/[id].tsx's own `Order ${purchase.orderNumber ?? "—"}` fallback.
  const orderLabel = purchase.orderNumber ?? "—";

  const outcomeCopy: Record<"exchanged" | "disputed" | "closed", string> = {
    exchanged: "Mark this return as exchanged instead of refunded?",
    disputed: "Mark this return as disputed by the merchant?",
    closed: "Give up and close this return with no refund?",
  };

  return (
    <Screen>
      <ScreenHeader title={`Return for order ${orderLabel}`} subtitle={deadline ? `Deadline ${deadline}` : undefined} />
      <Card style={{ gap: 6 }}>
        {days != null && !isTerminal && (
          <Badge tone={days <= 3 ? "critical" : "warning"}>
            {days > 0 ? `${days}d left` : days === 0 ? "Due today" : `${Math.abs(days)}d overdue`}
          </Badge>
        )}
        {value && <Text style={{ fontSize: 20, fontWeight: "700", color: theme.colors.textPrimary }}>{value}</Text>}
        <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>{STATE_LABEL[returnCase.state] ?? returnCase.state.replace(/_/g, " ")}</Text>
        {returnCase.refundObservedTransactionId ? (
          <Badge tone="positive">Refund received</Badge>
        ) : (
          <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Refund not seen in your connected accounts yet</Text>
        )}
        {returnCase.trackingNumber && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Tracking: {returnCase.trackingNumber}</Text>}
        <Text accessibilityRole="button" style={{ fontSize: 13, color: theme.colors.brandDefault }} onPress={() => router.push(`/purchase/${purchase.id}`)}>
          View order →
        </Text>

        {!isTerminal && (
          <View style={{ gap: 8, marginTop: 4 }}>
            {/* Step 1: eligible -> initiated */}
            {returnCase.state === "eligible" && (
              <Button loading={advancing} onPress={initiateReturn}>
                Start this return
              </Button>
            )}
            {/* Step 2: initiated -> label_ready, with optional carrier/tracking */}
            {returnCase.state === "initiated" && <LabelReadyForm returnCaseId={String(id)} onSaved={load} />}
            {/* Steps 3-4 (in_transit/merchant_received) are automatic — see this file's own top-of-file doc
                comment — the status line above already reflects them once
                syncReturnShippingStateFromLinkedShipment runs; nothing to tap here. */}
            {/* Step 5: label_ready/in_transit/merchant_received -> refund_expected */}
            {canMarkRefundExpected && (
              <Button loading={advancing} onPress={markRefundExpected}>
                Mark refund expected
              </Button>
            )}
            {/* Terminal fork: refunded is its own long-standing action; exchanged/disputed/closed are new. */}
            <Button variant="secondary" loading={resolving} onPress={resolveReturn}>
              Mark refunded
            </Button>
            {confirmingOutcome ? (
              <View style={{ gap: 8, backgroundColor: theme.colors.warningSubtleBg, borderRadius: theme.radius.md, padding: 12 }}>
                <Text style={{ fontSize: 13, color: theme.colors.warningSubtleText }}>{outcomeCopy[confirmingOutcome]}</Text>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <View style={{ flex: 1 }}>
                    <Button loading={closingOutcome === confirmingOutcome} onPress={() => closeReturn(confirmingOutcome)}>
                      Confirm
                    </Button>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Button variant="secondary" onPress={() => setConfirmingOutcome(null)}>
                      Cancel
                    </Button>
                  </View>
                </View>
              </View>
            ) : (
              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                <Text accessibilityRole="button" style={{ fontSize: 12, color: theme.colors.textTertiary }} onPress={() => setConfirmingOutcome("exchanged")}>
                  Exchanged instead
                </Text>
                <Text accessibilityRole="button" style={{ fontSize: 12, color: theme.colors.textTertiary }} onPress={() => setConfirmingOutcome("disputed")}>
                  Merchant disputed it
                </Text>
                <Text accessibilityRole="button" style={{ fontSize: 12, color: theme.colors.textTertiary }} onPress={() => setConfirmingOutcome("closed")}>
                  Give up, close with no refund
                </Text>
              </View>
            )}
          </View>
        )}
        {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
      </Card>
      <EvidenceCard evidence={evidence} />
    </Screen>
  );
}
