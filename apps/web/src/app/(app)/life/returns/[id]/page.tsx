"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { api, swrFetcher, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { FetchError } from "@/components/ui/fetch-error";
import { EvidenceCard, type Evidence } from "@/components/evidence-card";
import { formatMoneyMinorUnits, formatTemporal, daysUntil, type TemporalValueLike } from "@/lib/format";

// §40.3 Return state machine (eligible → initiated → label/dropoff ready → in transit → merchant received
// → refund expected → refunded/exchanged/disputed/closed) — the legacy "Mark refunded" action used to be
// gated on `state !== "resolved"` alone, so once a return reached one of the newer named terminal states
// (refunded/exchanged/disputed/closed) the button stayed visible and re-clickable on an already-closed
// return. "resolved" is the legacy generic terminal state, still written automatically by
// PlaidAdapter.matchTransaction's refund-matching path.
const RETURN_TERMINAL_STATES = new Set(["resolved", "refunded", "exchanged", "disputed", "closed"]);

// §40.3 Return state machine — `in_transit`/`merchant_received` are deliberately NOT manual buttons here:
// CommerceService.syncReturnShippingStateFromLinkedShipment's own doc comment is explicit that these are
// derived automatically from the linked return shipment's real carrier status (the same outbound `shipments`
// vocabulary IngestionService.extractShipment already writes), not a separate "I shipped it"/"they got it"
// click — a return with no linked tracking (a drop-off return, or one marked label-ready with no tracking
// number) simply stays wherever it is rather than being guessed at. This page shows those two states purely
// as read-only badges once they arrive; the only genuinely manual steps are initiate/label-ready/
// refund-expected/close, all covered by the state-gated buttons below.
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
    id: string;
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
 * §40.3 Return state machine, step 2 — `initiated → label/dropoff ready`. Both fields are optional, same as
 * MarkReturnLabelReadyDtoSchema's own doc comment: a user may mark a return's label ready before they have a
 * tracking number in hand, or never get one at all for a drop-off-only return.
 */
function LabelReadyForm({ returnCaseId, onSaved }: { returnCaseId: string; onSaved: () => void }) {
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
      <Button size="sm" onClick={() => setOpen(true)}>
        Mark label/dropoff ready
      </Button>
    );
  }

  return (
    <div className="w-full space-y-2 rounded-lg border border-border-subtle p-3">
      <div>
        <Label htmlFor="return-carrier">Carrier (optional)</Label>
        <Input id="return-carrier" value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="e.g. UPS" />
      </div>
      <div>
        <Label htmlFor="return-tracking">Tracking number (optional)</Label>
        <Input id="return-tracking" value={trackingNumber} onChange={(e) => setTrackingNumber(e.target.value)} placeholder="e.g. 1Z999AA10123456784" />
      </div>
      {error && (
        <p role="alert" className="text-xs text-critical">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" loading={saving} onClick={submit}>
          Save
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export default function ReturnDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, isLoading, mutate } = useSWR<ReturnDetail | null>(`/v1/returns/${id}`, swrFetcher);
  const [resolving, setResolving] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [closingOutcome, setClosingOutcome] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // The Life list view exposes "Mark refunded" for an open return case (see life/page.tsx's resolveReturn),
  // but this detail page — reached directly from a return-window attention item or a purchase's "Return
  // case" link — had no equivalent action, so a user landing here first had to go back to the list just to
  // resolve it. Kept as-is (still posts to the legacy /resolve route) alongside the newer granular actions
  // below, so nothing that already depended on this exact behavior changes.
  async function resolveReturn() {
    setActionError(null);
    setResolving(true);
    try {
      await api.post(`/v1/returns/${id}/resolve`);
      await mutate();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't mark that return refunded.");
    } finally {
      setResolving(false);
    }
  }

  // §40.3 Return state machine, step 1 — `eligible → initiated`.
  async function initiateReturn() {
    setActionError(null);
    setAdvancing(true);
    try {
      await api.post(`/v1/returns/${id}/initiate`);
      await mutate();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't start this return.");
    } finally {
      setAdvancing(false);
    }
  }

  // §40.3 Return state machine, step 5 — reachable from label_ready/in_transit/merchant_received (this app
  // has no merchant-side "we received it" signal, only carrier delivery evidence — see
  // CommerceService.markReturnRefundExpected's own doc comment on why this isn't gated strictly on
  // merchant_received).
  async function markRefundExpected() {
    setActionError(null);
    setAdvancing(true);
    try {
      await api.post(`/v1/returns/${id}/refund-expected`);
      await mutate();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't mark a refund expected yet.");
    } finally {
      setAdvancing(false);
    }
  }

  // §40.3 Return state machine terminal fork — exchanged/disputed/closed (refunded already has its own
  // dedicated "Mark refunded" button above, unchanged). A merchant can reject a return outright or offer an
  // exchange from any non-terminal state, not just refund_expected — see CommerceService.closeReturn's own
  // doc comment — so this is offered whenever the return isn't already closed.
  async function closeReturn(outcome: "exchanged" | "disputed" | "closed") {
    if (!window.confirm(`Close this return as "${STATE_LABEL[outcome]}"? This can't be undone.`)) return;
    setActionError(null);
    setClosingOutcome(outcome);
    try {
      await api.post(`/v1/returns/${id}/close`, { outcome });
      await mutate();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't close this return.");
    } finally {
      setClosingOutcome(null);
    }
  }

  if (isLoading) return <div className="h-40 animate-pulse rounded-xl bg-subtle" />;
  if (error && !data) {
    return (
      <div className="space-y-6">
        <Link href="/life" className="text-sm text-tertiary hover:text-primary">
          ← Back to Life
        </Link>
        <FetchError what="this return" message={error instanceof ApiError ? error.message : undefined} onRetry={() => mutate()} />
      </div>
    );
  }
  if (!data) return <EmptyState title="Not found" description="This return doesn't exist or you don't have access to it." />;

  const { returnCase, purchase, evidence } = data;
  const deadline = formatTemporal(returnCase.deadline);
  const value = formatMoneyMinorUnits(returnCase.valueAtStakeMinorUnits, returnCase.valueAtStakeCurrency);
  const days = daysUntil(returnCase.deadline);
  const isTerminal = RETURN_TERMINAL_STATES.has(returnCase.state);
  const canMarkRefundExpected = ["label_ready", "in_transit", "merchant_received"].includes(returnCase.state);

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
              {purchase.orderNumber ?? "View order"}
            </Link>
          </h1>
          {deadline && <p className="mt-1 text-sm text-tertiary">Deadline {deadline}</p>}
        </div>
        {days != null && !isTerminal && (
          <Badge tone={days <= 3 ? "critical" : "warning"}>
            {days > 0 ? `${days}d left` : days === 0 ? "Due today" : `Overdue by ${Math.abs(days)}d`}
          </Badge>
        )}
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
            <dd className="text-primary">{STATE_LABEL[returnCase.state] ?? returnCase.state.replace(/_/g, " ")}</dd>
            <dt className="text-tertiary">Refund</dt>
            <dd className="text-primary">
              {returnCase.refundObservedTransactionId ? (
                <Badge tone="positive">Received</Badge>
              ) : (
                <span className="text-tertiary">Not seen in your connected accounts yet</span>
              )}
            </dd>
            {returnCase.trackingNumber && (
              <>
                <dt className="text-tertiary">Tracking</dt>
                <dd className="text-primary">{returnCase.trackingNumber}</dd>
              </>
            )}
          </dl>

          {!isTerminal && (
            <div className="flex flex-wrap items-center gap-2 pt-2">
              {/* Step 1: eligible -> initiated */}
              {returnCase.state === "eligible" && (
                <Button size="sm" loading={advancing} onClick={initiateReturn}>
                  Start this return
                </Button>
              )}
              {/* Step 2: initiated -> label_ready, with optional carrier/tracking */}
              {returnCase.state === "initiated" && <LabelReadyForm returnCaseId={String(id)} onSaved={() => mutate()} />}
              {/* Steps 3-4 (in_transit/merchant_received) are automatic — see this file's own top-of-file
                  doc comment — nothing to click here; the Status row above already reflects them once
                  syncReturnShippingStateFromLinkedShipment runs. */}
              {/* Step 5: label_ready/in_transit/merchant_received -> refund_expected */}
              {canMarkRefundExpected && (
                <Button size="sm" loading={advancing} onClick={markRefundExpected}>
                  Mark refund expected
                </Button>
              )}
              {/* Terminal fork: refunded is its own long-standing action; exchanged/disputed/closed are new. */}
              <Button size="sm" variant="secondary" loading={resolving} onClick={() => resolveReturn()}>
                Mark refunded
              </Button>
              <Button size="sm" variant="ghost" loading={closingOutcome === "exchanged"} onClick={() => closeReturn("exchanged")}>
                Exchanged instead
              </Button>
              <Button size="sm" variant="ghost" loading={closingOutcome === "disputed"} onClick={() => closeReturn("disputed")}>
                Merchant disputed it
              </Button>
              <Button size="sm" variant="ghost" loading={closingOutcome === "closed"} onClick={() => closeReturn("closed")}>
                Give up, close with no refund
              </Button>
            </div>
          )}
          {actionError && <p className="text-sm text-critical">{actionError}</p>}
        </CardBody>
      </Card>

      <EvidenceCard evidence={evidence} />
    </div>
  );
}
