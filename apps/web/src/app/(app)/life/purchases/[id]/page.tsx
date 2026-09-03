"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { api, ApiError, swrFetcher } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/ui/empty-state";
import { FetchError } from "@/components/ui/fetch-error";
import { EvidenceCard, type Evidence } from "@/components/evidence-card";
import { ShareResourcePanel } from "@/components/sharing/share-resource-panel";
import { SharedNoteBanner } from "@/components/sharing/shared-note-banner";
import { formatMoneyMinorUnits, formatTemporal, type TemporalValueLike } from "@/lib/format";

// Same mapping apps/web's inbox page already uses for confidenceBand — kept in sync so a purchase flagged
// "needs_review" or "conflicting" doesn't read as identically trustworthy as one "verified" (Badge's own
// doc comment: color is never the only signal, but a single hardcoded "neutral" tone here made every band
// look the same regardless of wording).
const CONFIDENCE_TONE: Record<string, "positive" | "warning" | "critical" | "neutral"> = {
  verified: "positive",
  high: "positive",
  needs_review: "warning",
  conflicting: "critical",
  approximate: "neutral",
};

// RET-004 "Price-adjustment opportunity" — one row per detected drop, written by IngestionService.
// extractReceipt to `price_observations` (subjectEntityId = the ORIGINAL, more-expensive purchase line's
// own id). Matched to a line below by `purchaseLineId === line.id`.
interface PriceAdjustment {
  purchaseLineId: string;
  observedAmountMinorUnits: number;
  observedAmountCurrency: string;
  observedAt: string;
}

// RET-004 "Policy engine ... deadline calculator" — resolved server-side by CommerceService.purchaseDetail
// from this purchase's own merchant + purchaseDateSort (see price-adjustment-policy.ts). `isDefault: true`
// means no merchant-specific row exists at all — this is the flat fallback, not a sourced fact, which is
// exactly what the "assumed"-vs-"commonly_known"-vs-"user_confirmed" confidence badge below is for.
interface PriceAdjustmentPolicy {
  windowDays: number;
  confidence: "user_confirmed" | "commonly_known" | "assumed";
  sourceNote: string | null;
  isDefault: boolean;
  deadline: string;
  daysLeft: number;
}

interface PurchaseDetail {
  purchase: {
    id: string;
    merchantId: string | null;
    orderNumber: string | null;
    purchaseDate: TemporalValueLike;
    totalMinorUnits: number | null;
    totalCurrency: string | null;
    taxMinorUnits: number | null;
    shippingMinorUnits: number | null;
    paymentMethodHint: string | null;
    state: string;
    confidenceBand: string;
  };
  merchantName: string | null;
  lines: Array<{
    id: string;
    productLabel: string;
    quantity: number;
    unitPriceMinorUnits: number | null;
    serialNumber: string | null;
    giftFlag: boolean;
    ownerAssetEntityId: string | null;
    resaleStatus: string;
  }>;
  returns: Array<{ id: string; state: string; deadline: TemporalValueLike }>;
  shipments: Array<{ id: string; carrier: string; trackingNumber: string; status: string }>;
  evidence: Evidence | null;
  priceAdjustments: PriceAdjustment[];
  priceAdjustmentPolicy: PriceAdjustmentPolicy | null;
  sharedNote: string | null;
}

const POLICY_CONFIDENCE_LABEL: Record<PriceAdjustmentPolicy["confidence"], string> = {
  user_confirmed: "You confirmed this policy",
  commonly_known: "Publicly documented policy",
  assumed: "Unconfirmed — using Veynlo's default",
};
const POLICY_CONFIDENCE_TONE: Record<PriceAdjustmentPolicy["confidence"], "positive" | "info" | "neutral"> = {
  user_confirmed: "positive",
  commonly_known: "info",
  assumed: "neutral",
};

/**
 * RET-004 "let a user manually add/correct a policy for a merchant they know the real terms for" — inline
 * editor on the price-adjustment banner itself (per this feature's own scope note: a dedicated settings
 * page isn't required when the purchase detail page already has the exact merchant in context). Reads the
 * currently-resolved policy on open so the form starts from the real current value, not a blank slate.
 */
function PolicyEditor({ merchantId, merchantName, policy, onSaved }: { merchantId: string; merchantName: string | null; policy: PriceAdjustmentPolicy; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [windowDays, setWindowDays] = useState(String(policy.windowDays));
  const [sourceNote, setSourceNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const parsed = Number(windowDays);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      setError("Enter a whole number of days greater than 0.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.put(`/v1/merchants/${merchantId}/price-adjustment-policy`, { windowDays: parsed, sourceNote: sourceNote.trim() === "" ? null : sourceNote.trim() });
      setOpen(false);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save that.");
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-xs font-medium text-brand hover:underline">
        {policy.confidence === "user_confirmed" ? "Edit your policy" : `Know ${merchantName ?? "this merchant"}'s real policy?`}
      </button>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-border-subtle p-3">
      <label className="block text-xs font-medium text-secondary" htmlFor={`policy-days-${merchantId}`}>
        Price-adjustment window (days from purchase)
      </label>
      <Input id={`policy-days-${merchantId}`} type="number" min={1} value={windowDays} onChange={(e) => setWindowDays(e.target.value)} />
      <label className="block text-xs font-medium text-secondary" htmlFor={`policy-note-${merchantId}`}>
        Where did this come from? (optional)
      </label>
      <Input
        id={`policy-note-${merchantId}`}
        value={sourceNote}
        onChange={(e) => setSourceNote(e.target.value)}
        placeholder="e.g. Called support on 2026-08-15, they confirmed 21 days"
      />
      {error && (
        <p role="alert" className="text-xs text-critical">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button size="sm" loading={saving} onClick={save}>
          Save policy
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

const RESALE_STATUS_LABEL: Record<string, string> = { not_listed: "Not listed", listed: "Listed for resale", sold: "Sold" };
const RESALE_STATUS_TONE: Record<string, "neutral" | "info" | "positive"> = { not_listed: "neutral", listed: "info", sold: "positive" };

/**
 * RET-006 "Resale handoff" — generates a resale-ready listing draft (title/description/condition, the
 * condition editable, defaulting to a neutral "Used, working condition") and hands it off via the
 * platform's native share capability. Deliberately NOT a marketplace API integration (eBay/Facebook
 * Marketplace/Craigslist all require paid partner agreements — out of scope) — this just pre-fills a block
 * of text the user pastes into whatever marketplace app they choose. `navigator.share` (mobile Safari/
 * Chrome) is used when available; every other browser falls back to copy-to-clipboard with an inline
 * "Copied!" confirmation, same transient-message pattern the connections page's forwarding-address copy
 * button already uses.
 */
function ResalePanel({
  line,
  merchantName,
  purchaseDateLabel,
  onSaved,
}: {
  line: PurchaseDetail["lines"][number];
  merchantName: string | null;
  purchaseDateLabel: string | null;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [condition, setCondition] = useState("Used, working condition");
  const [copied, setCopied] = useState(false);
  const [updating, setUpdating] = useState(false);

  const description = `${line.productLabel}${merchantName ? ` — purchased from ${merchantName}` : ""}${
    purchaseDateLabel ? ` on ${purchaseDateLabel}` : ""
  }. Condition: ${condition || "Not specified"}.`;

  async function updateStatus(resaleStatus: "listed" | "sold" | "not_listed") {
    setUpdating(true);
    try {
      await api.put(`/v1/purchases/lines/${line.id}`, { resaleStatus });
      onSaved();
    } catch {
      // Best-effort — the button stays visible so the user can retry.
    } finally {
      setUpdating(false);
    }
  }

  async function share() {
    const shareText = `${line.productLabel}\n\n${description}`;
    if (typeof navigator !== "undefined" && "share" in navigator) {
      try {
        await (navigator as Navigator & { share: (data: { title: string; text: string }) => Promise<void> }).share({
          title: line.productLabel,
          text: shareText,
        });
        return;
      } catch {
        // User cancelled the share sheet, or the browser rejected it — fall through to clipboard.
      }
    }
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      await navigator.clipboard.writeText(shareText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <div className="space-y-2 border-t border-border-subtle pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={RESALE_STATUS_TONE[line.resaleStatus] ?? "neutral"}>{RESALE_STATUS_LABEL[line.resaleStatus] ?? line.resaleStatus}</Badge>
        {!open && line.resaleStatus === "not_listed" && (
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
            List for resale
          </Button>
        )}
        {line.resaleStatus === "listed" && (
          <Button size="sm" variant="secondary" loading={updating} onClick={() => updateStatus("sold")}>
            Mark as sold
          </Button>
        )}
      </div>

      {open && line.resaleStatus === "not_listed" && (
        <div className="space-y-2 rounded-lg border border-border-subtle p-3">
          <label className="block text-xs font-medium text-secondary" htmlFor={`condition-${line.id}`}>
            Condition
          </label>
          <Input id={`condition-${line.id}`} value={condition} onChange={(e) => setCondition(e.target.value)} placeholder="e.g. Used, working condition" />
          <p className="rounded-md bg-subtle p-2 text-xs text-tertiary">{description}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={share}>
              {copied ? "Copied!" : "Share listing"}
            </Button>
            <Button size="sm" variant="secondary" loading={updating} onClick={() => updateStatus("listed")}>
              Mark as listed
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * PUR-006/PUR-008 — inline editor for the two fields extraction can never fill in on its own: a serial
 * number and gift intent (see UpdatePurchaseLineDtoSchema's own doc comment for why). Deliberately per-line
 * rather than a page-level form — each line item is its own physical unit and can carry its own serial.
 */
function LineItemRow({
  line,
  currency,
  merchantName,
  merchantId,
  purchaseDateLabel,
  priceAdjustment,
  priceAdjustmentPolicy,
  onSaved,
}: {
  line: PurchaseDetail["lines"][number];
  currency: string | null;
  merchantName: string | null;
  merchantId: string | null;
  purchaseDateLabel: string | null;
  priceAdjustment: PriceAdjustment | undefined;
  priceAdjustmentPolicy: PriceAdjustmentPolicy | null;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [serial, setSerial] = useState(line.serialNumber ?? "");
  const [gift, setGift] = useState(line.giftFlag);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.put(`/v1/purchases/lines/${line.id}`, { serialNumber: serial.trim() === "" ? null : serial.trim(), giftFlag: gift });
      setEditing(false);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save that.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2 py-2 text-sm">
      <div className="flex items-center justify-between gap-4">
        <span className="text-primary">
          {line.quantity > 1 ? `${line.quantity}× ` : ""}
          {line.productLabel}
        </span>
        <div className="flex items-center gap-2">
          {line.giftFlag && <Badge tone="info">Gift</Badge>}
          {line.unitPriceMinorUnits != null && <span className="text-tertiary">{formatMoneyMinorUnits(line.unitPriceMinorUnits, currency)}</span>}
        </div>
      </div>

      {line.ownerAssetEntityId && (
        <Link href={`/entities/${line.ownerAssetEntityId}`} className="block text-xs text-brand hover:underline">
          View as tracked item →
        </Link>
      )}

      {/* RET-004 "Price-adjustment opportunity" — same banner tone/placement pattern as RET-003's
          "Refund received" badge on the return-case detail page, adapted to a warning tone since this is
          an opportunity to act on, not a completed positive outcome. */}
      {priceAdjustment && (
        <div className="space-y-2 rounded-lg bg-warning-subtle p-2 text-xs text-warning-subtle-text">
          <div className="flex items-start gap-2">
            <Badge tone="warning">Price dropped</Badge>
            <span>
              {formatMoneyMinorUnits(line.unitPriceMinorUnits, currency)} → {formatMoneyMinorUnits(priceAdjustment.observedAmountMinorUnits, priceAdjustment.observedAmountCurrency)} —
              you may be eligible for a price adjustment.
            </span>
          </div>
          {/* RET-004 "deadline calculator" + "policy confidence" — the exact two things the RET-004 audit
              found missing: a real deadline (original purchase date + this merchant's window, not just the
              price difference), and this policy's OWN confidence, separate from the AI extraction's
              confidenceBand shown at the top of the page. */}
          {priceAdjustmentPolicy && (
            <div className="flex flex-wrap items-center gap-2 border-t border-warning-subtle-text/20 pt-2">
              <Badge tone={POLICY_CONFIDENCE_TONE[priceAdjustmentPolicy.confidence]}>{POLICY_CONFIDENCE_LABEL[priceAdjustmentPolicy.confidence]}</Badge>
              <span className="font-medium">
                {priceAdjustmentPolicy.daysLeft > 0
                  ? `${priceAdjustmentPolicy.daysLeft} day${priceAdjustmentPolicy.daysLeft === 1 ? "" : "s"} left to request a price adjustment`
                  : priceAdjustmentPolicy.daysLeft === 0
                    ? "Last day to request a price adjustment"
                    : "This merchant's price-adjustment window has likely passed"}
              </span>
              <span className="text-warning-subtle-text/80">
                (deadline {new Date(priceAdjustmentPolicy.deadline).toLocaleDateString()} — {priceAdjustmentPolicy.windowDays}-day window
                {priceAdjustmentPolicy.isDefault ? ", app default" : ""})
              </span>
              {priceAdjustmentPolicy.sourceNote && <span className="italic text-warning-subtle-text/80">{priceAdjustmentPolicy.sourceNote}</span>}
              {merchantId && <PolicyEditor merchantId={merchantId} merchantName={merchantName} policy={priceAdjustmentPolicy} onSaved={onSaved} />}
            </div>
          )}
        </div>
      )}

      {!editing && (
        <div className="flex items-center gap-3 text-xs text-tertiary">
          {line.serialNumber ? <span>Serial: {line.serialNumber}</span> : <span>No serial number recorded</span>}
          <button type="button" onClick={() => setEditing(true)} className="font-medium text-brand hover:underline">
            Edit
          </button>
        </div>
      )}

      {editing && (
        <div className="space-y-2 rounded-lg border border-border-subtle p-3">
          <label className="block text-xs font-medium text-secondary" htmlFor={`serial-${line.id}`}>
            Serial number
          </label>
          <Input id={`serial-${line.id}`} value={serial} onChange={(e) => setSerial(e.target.value)} placeholder="e.g. SN-1234567" />
          <Switch checked={gift} onCheckedChange={setGift} label="This was a gift" id={`gift-${line.id}`} />
          {error && (
            <p role="alert" className="text-xs text-critical">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button size="sm" loading={saving} onClick={save}>
              Save
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setEditing(false);
                setSerial(line.serialNumber ?? "");
                setGift(line.giftFlag);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      <ResalePanel line={line} merchantName={merchantName} purchaseDateLabel={purchaseDateLabel} onSaved={onSaved} />
    </div>
  );
}

// §40.3 Purchase state machine — `candidate → confirmed → fulfilled/partially fulfilled → kept / return
// started / gifted / sold / disposed`. Found live via QA: the backend had real endpoints for `confirm` and
// `dispose` (CommerceService.confirmPurchase/markPurchaseDisposed), but this page only ever showed the
// state as plain text — there was no UI trigger for either action, only reachable via a direct API call.
// "kept"/"gifted"/"sold" are deliberately NOT exposed as direct buttons here: the backend has no manual
// "mark kept" endpoint at all (it's exclusively the automatic outcome of scanAndAdvancePurchaseLifecycle
// once a return window closes with nothing else happening), and gifted/sold are derived server-side from
// each LINE's own giftFlag/resaleStatus (see recomputePurchaseOutcomeState's doc comment) — the existing
// per-line "This was a gift"/resale controls above are the real UI for those, not a new order-level button.
function PurchaseActions({ purchase, onSaved }: { purchase: PurchaseDetail["purchase"]; onSaved: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [disposing, setDisposing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmPurchase() {
    setError(null);
    setConfirming(true);
    try {
      await api.post(`/v1/purchases/${purchase.id}/confirm`);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't confirm this purchase.");
    } finally {
      setConfirming(false);
    }
  }

  async function disposePurchase() {
    // Same window.confirm convention every other hard-to-undo action in this app uses (e.g. removing a
    // vehicle/property, leaving a household) — markPurchaseDisposed has no automatic path back to any
    // other state, so this is a real one-way action.
    if (!window.confirm("Mark this purchase as disposed? There's no automatic way to undo this.")) return;
    setError(null);
    setDisposing(true);
    try {
      await api.post(`/v1/purchases/${purchase.id}/dispose`);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't mark this purchase disposed.");
    } finally {
      setDisposing(false);
    }
  }

  if (purchase.state === "disposed") return null;

  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      {purchase.state === "candidate" && (
        <Button size="sm" loading={confirming} onClick={confirmPurchase}>
          Confirm this purchase
        </Button>
      )}
      {purchase.state !== "candidate" && (
        <Button size="sm" variant="secondary" loading={disposing} onClick={disposePurchase}>
          Mark as disposed
        </Button>
      )}
      {error && (
        <p role="alert" className="w-full text-xs text-critical">
          {error}
        </p>
      )}
    </div>
  );
}

export default function PurchaseDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, isLoading, mutate } = useSWR<PurchaseDetail | null>(`/v1/purchases/${id}`, swrFetcher);
  const [sharing, setSharing] = useState(false);

  if (isLoading) return <div className="h-40 animate-pulse rounded-xl bg-subtle" />;
  if (error && !data) {
    return (
      <div className="space-y-6">
        <Link href="/life" className="text-sm text-tertiary hover:text-primary">
          ← Back to Life
        </Link>
        <FetchError what="this purchase" message={error instanceof ApiError ? error.message : undefined} onRetry={() => mutate()} />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="space-y-6">
        <Link href="/life" className="text-sm text-tertiary hover:text-primary">
          ← Back to Life
        </Link>
        <EmptyState title="Not found" description="This purchase doesn't exist or you don't have access to it." />
      </div>
    );
  }

  const { purchase, merchantName, lines, returns, shipments, evidence, priceAdjustments, priceAdjustmentPolicy } = data;
  const date = formatTemporal(purchase.purchaseDate);
  const total = formatMoneyMinorUnits(purchase.totalMinorUnits, purchase.totalCurrency);

  return (
    <div className="space-y-6">
      <Link href="/life" className="text-sm text-tertiary hover:text-primary">
        ← Back to Life
      </Link>
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">Order {purchase.orderNumber ?? "—"}</h1>
          {date && <p className="mt-1 text-sm text-tertiary">{date}</p>}
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={CONFIDENCE_TONE[purchase.confidenceBand] ?? "neutral"}>{purchase.confidenceBand.replace("_", " ")}</Badge>
          <Button size="sm" variant="ghost" onClick={() => setSharing((s) => !s)}>
            Share
          </Button>
        </div>
      </header>

      <SharedNoteBanner note={data.sharedNote} />

      {sharing && (
        <Card>
          <CardBody>
            <ShareResourcePanel resourceId={String(id)} collectionPath="/v1/purchases" resourceLabel="purchase" />
          </CardBody>
        </Card>
      )}

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
            {purchase.taxMinorUnits != null && (
              <>
                <dt className="text-tertiary">Tax</dt>
                <dd className="text-primary">{formatMoneyMinorUnits(purchase.taxMinorUnits, purchase.totalCurrency)}</dd>
              </>
            )}
            {purchase.shippingMinorUnits != null && (
              <>
                <dt className="text-tertiary">Shipping</dt>
                <dd className="text-primary">{formatMoneyMinorUnits(purchase.shippingMinorUnits, purchase.totalCurrency)}</dd>
              </>
            )}
            {purchase.paymentMethodHint && (
              <>
                <dt className="text-tertiary">Payment</dt>
                <dd className="text-primary">{purchase.paymentMethodHint}</dd>
              </>
            )}
            <dt className="text-tertiary">Status</dt>
            <dd className="text-primary capitalize">{purchase.state.replace("_", " ")}</dd>
          </dl>
          <PurchaseActions purchase={purchase} onSaved={() => mutate()} />
        </CardBody>
      </Card>

      {lines.length > 0 && (
        <Card>
          <CardBody className="space-y-2">
            <p className="text-sm font-medium text-primary">Items</p>
            <div className="divide-y divide-border-subtle">
              {lines.map((line) => (
                <LineItemRow
                  key={line.id}
                  line={line}
                  currency={purchase.totalCurrency}
                  merchantName={merchantName}
                  merchantId={purchase.merchantId}
                  purchaseDateLabel={date}
                  priceAdjustment={priceAdjustments.find((a) => a.purchaseLineId === line.id)}
                  priceAdjustmentPolicy={priceAdjustmentPolicy}
                  onSaved={() => mutate()}
                />
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

      <EvidenceCard evidence={evidence} />
    </div>
  );
}
