import { useEffect, useState } from "react";
import { Share, Switch, Text, View } from "react-native";
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
import { ShareResourcePanel } from "@/components/share-resource-panel";
import { FetchError } from "@/components/fetch-error";
import { formatMoneyMinorUnits, formatTemporal, type TemporalValueLike } from "@/lib/format";

// Same mapping apps/web's purchase detail page uses for confidenceBand — kept in sync so a purchase
// flagged "needs_review" or "conflicting" doesn't read as identically trustworthy as one "verified" (a
// hardcoded "neutral" tone here made every band look the same regardless of wording).
const CONFIDENCE_TONE: Record<string, "positive" | "warning" | "critical" | "neutral"> = {
  verified: "positive",
  high: "positive",
  needs_review: "warning",
  conflicting: "critical",
  approximate: "neutral",
};

interface PurchaseLine {
  id: string;
  productLabel: string;
  quantity: number;
  unitPriceMinorUnits: number | null;
  serialNumber: string | null;
  giftFlag: boolean;
  ownerAssetEntityId: string | null;
  resaleStatus: string;
}

// RET-004 "Price-adjustment opportunity" — mirrors apps/web's identical interface (see that file's doc
// comment): one row per detected drop, written by IngestionService.extractReceipt to `price_observations`
// (subjectEntityId = the ORIGINAL, more-expensive purchase line's own id).
interface PriceAdjustment {
  purchaseLineId: string;
  observedAmountMinorUnits: number;
  observedAmountCurrency: string;
  observedAt: string;
}

// RET-004 "Policy engine ... deadline calculator" — mirrors apps/web's identical interface. `isDefault:
// true` means no merchant-specific row exists — the flat fallback, not a sourced fact.
interface PriceAdjustmentPolicy {
  windowDays: number;
  confidence: "user_confirmed" | "commonly_known" | "assumed";
  sourceNote: string | null;
  isDefault: boolean;
  deadline: string;
  daysLeft: number;
}

const POLICY_CONFIDENCE_LABEL: Record<PriceAdjustmentPolicy["confidence"], string> = {
  user_confirmed: "You confirmed this policy",
  commonly_known: "Publicly documented policy",
  assumed: "Unconfirmed — using Veynlo's default",
};
const POLICY_CONFIDENCE_TONE: Record<PriceAdjustmentPolicy["confidence"], "positive" | "brand" | "neutral"> = {
  user_confirmed: "positive",
  commonly_known: "brand",
  assumed: "neutral",
};

interface PurchaseDetail {
  purchase: {
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
  lines: PurchaseLine[];
  returns: Array<{ id: string; state: string; deadline: TemporalValueLike }>;
  shipments: Array<{ id: string; carrier: string; trackingNumber: string; status: string }>;
  evidence: Evidence | null;
  priceAdjustments: PriceAdjustment[];
  priceAdjustmentPolicy: PriceAdjustmentPolicy | null;
}

/**
 * RET-004 "let a user manually add/correct a policy" — mirrors apps/web's PolicyEditor (see that file's
 * doc comment). Inline on the price-adjustment banner rather than a separate settings screen.
 */
function PolicyEditor({ merchantId, merchantName, policy, onSaved }: { merchantId: string; merchantName: string | null; policy: PriceAdjustmentPolicy; onSaved: () => void }) {
  const { theme } = useAppTheme();
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
      <Text accessibilityRole="button" style={{ fontSize: 12, fontWeight: "600", color: theme.colors.brandDefault }} onPress={() => setOpen(true)}>
        {policy.confidence === "user_confirmed" ? "Edit your policy" : `Know ${merchantName ?? "this merchant"}'s real policy?`}
      </Text>
    );
  }

  return (
    <View style={{ gap: 8, borderWidth: 1, borderColor: theme.colors.borderSubtle, borderRadius: theme.radius.md, padding: 10 }}>
      <TextField label="Price-adjustment window (days from purchase)" value={windowDays} onChangeText={setWindowDays} keyboardType="number-pad" />
      <TextField label="Where did this come from? (optional)" value={sourceNote} onChangeText={setSourceNote} placeholder="e.g. Called support, they confirmed 21 days" />
      {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button variant="secondary" loading={saving} onPress={save}>
            Save policy
          </Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button variant="ghost" onPress={() => setOpen(false)}>
            Cancel
          </Button>
        </View>
      </View>
    </View>
  );
}

const RESALE_STATUS_LABEL: Record<string, string> = { not_listed: "Not listed", listed: "Listed for resale", sold: "Sold" };
const RESALE_STATUS_TONE: Record<string, "neutral" | "brand" | "positive"> = { not_listed: "neutral", listed: "brand", sold: "positive" };

/**
 * RET-006 "Resale handoff" — mirrors apps/web's identical ResalePanel (see that file's doc comment for the
 * full design rationale: no marketplace API integration, just a generated listing draft handed off via the
 * platform's native share sheet). React Native's core `Share.share()` API — no dedicated precedent existed
 * elsewhere in this app to mirror (grepped; the "Share" button on documents.tsx is object-sharing/grants,
 * not the OS share sheet), so this uses the standard cross-platform RN Share module directly.
 */
function ResalePanel({
  line,
  merchantName,
  purchaseDateLabel,
  onSaved,
}: {
  line: PurchaseLine;
  merchantName: string | null;
  purchaseDateLabel: string | null;
  onSaved: () => void;
}) {
  const { theme } = useAppTheme();
  const [open, setOpen] = useState(false);
  const [condition, setCondition] = useState("Used, working condition");
  const [updating, setUpdating] = useState(false);

  const description = `${line.productLabel}${merchantName ? ` — purchased from ${merchantName}` : ""}${
    purchaseDateLabel ? ` on ${purchaseDateLabel}` : ""
  }. Condition: ${condition || "Not specified"}.`;

  async function updateStatus(resaleStatus: "listed" | "sold") {
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
    try {
      await Share.share({ title: line.productLabel, message: `${line.productLabel}\n\n${description}` });
    } catch {
      // User dismissed the share sheet — nothing to do.
    }
  }

  return (
    <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, paddingTop: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Badge tone={RESALE_STATUS_TONE[line.resaleStatus] ?? "neutral"}>{RESALE_STATUS_LABEL[line.resaleStatus] ?? line.resaleStatus}</Badge>
        {!open && line.resaleStatus === "not_listed" && (
          <Text accessibilityRole="button" style={{ fontSize: 12, color: theme.colors.brandDefault, fontWeight: "600" }} onPress={() => setOpen(true)}>
            List for resale
          </Text>
        )}
        {line.resaleStatus === "listed" && (
          <Text accessibilityRole="button" style={{ fontSize: 12, color: theme.colors.brandDefault, fontWeight: "600" }} onPress={() => (updating ? undefined : updateStatus("sold"))}>
            Mark as sold
          </Text>
        )}
      </View>

      {open && line.resaleStatus === "not_listed" && (
        <View style={{ gap: 8, borderWidth: 1, borderColor: theme.colors.borderSubtle, borderRadius: theme.radius.md, padding: 10 }}>
          <TextField label="Condition" value={condition} onChangeText={setCondition} placeholder="e.g. Used, working condition" />
          <Text style={{ fontSize: 12, color: theme.colors.textTertiary, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.sm, padding: 8 }}>
            {description}
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button variant="secondary" onPress={share}>
                Share listing
              </Button>
            </View>
            <View style={{ flex: 1 }}>
              <Button variant="secondary" loading={updating} onPress={() => updateStatus("listed")}>
                Mark as listed
              </Button>
            </View>
            <View style={{ flex: 1 }}>
              <Button variant="ghost" onPress={() => setOpen(false)}>
                Cancel
              </Button>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

/**
 * PUR-006/PUR-008 — mirrors apps/web's identical LineItemRow (see that file's doc comment for why
 * extraction alone can never fill in a serial number or gift intent, only the user can).
 */
function LineItemRow({
  line,
  currency,
  router,
  merchantName,
  merchantId,
  purchaseDateLabel,
  priceAdjustment,
  priceAdjustmentPolicy,
  onSaved,
}: {
  line: PurchaseLine;
  currency: string | null;
  router: ReturnType<typeof useRouter>;
  merchantName: string | null;
  merchantId: string | null;
  purchaseDateLabel: string | null;
  priceAdjustment: PriceAdjustment | undefined;
  priceAdjustmentPolicy: PriceAdjustmentPolicy | null;
  onSaved: () => void;
}) {
  const { theme } = useAppTheme();
  const [editing, setEditing] = useState(false);
  const [serial, setSerial] = useState(line.serialNumber ?? "");
  const [gift, setGift] = useState(line.giftFlag);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      await api.put(`/v1/purchases/lines/${line.id}`, { serialNumber: serial.trim() === "" ? null : serial.trim(), giftFlag: gift });
      setEditing(false);
      onSaved();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Couldn't save that.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ fontSize: 13, color: theme.colors.textPrimary, flex: 1 }}>
          {line.quantity > 1 ? `${line.quantity}× ` : ""}
          {line.productLabel}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          {line.giftFlag && <Badge tone="brand">Gift</Badge>}
          {line.unitPriceMinorUnits != null && (
            <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>{formatMoneyMinorUnits(line.unitPriceMinorUnits, currency)}</Text>
          )}
        </View>
      </View>

      {line.ownerAssetEntityId && (
        <Text accessibilityRole="button" style={{ fontSize: 12, color: theme.colors.brandDefault }} onPress={() => router.push(`/entity/${line.ownerAssetEntityId}`)}>
          View as tracked item →
        </Text>
      )}

      {/* RET-004 "Price-adjustment opportunity" — mirrors apps/web's identical banner (see that file's doc
          comment for why this is a warning tone, not positive: an opportunity to act on, not a completed
          outcome). */}
      {priceAdjustment && (
        <View style={{ gap: 8, backgroundColor: theme.colors.warningSubtleBg, borderRadius: theme.radius.md, padding: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
            <Badge tone="warning">Price dropped</Badge>
            <Text style={{ fontSize: 12, color: theme.colors.warningSubtleText, flex: 1 }}>
              {formatMoneyMinorUnits(line.unitPriceMinorUnits, currency)} → {formatMoneyMinorUnits(priceAdjustment.observedAmountMinorUnits, priceAdjustment.observedAmountCurrency)} — you
              may be eligible for a price adjustment.
            </Text>
          </View>
          {/* RET-004 "deadline calculator" + "policy confidence" — mirrors apps/web's identical block. */}
          {priceAdjustmentPolicy && (
            <View style={{ gap: 4, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, paddingTop: 8 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <Badge tone={POLICY_CONFIDENCE_TONE[priceAdjustmentPolicy.confidence]}>{POLICY_CONFIDENCE_LABEL[priceAdjustmentPolicy.confidence]}</Badge>
              </View>
              <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.textPrimary }}>
                {priceAdjustmentPolicy.daysLeft > 0
                  ? `${priceAdjustmentPolicy.daysLeft} day${priceAdjustmentPolicy.daysLeft === 1 ? "" : "s"} left to request a price adjustment`
                  : priceAdjustmentPolicy.daysLeft === 0
                    ? "Last day to request a price adjustment"
                    : "This merchant's price-adjustment window has likely passed"}
              </Text>
              <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
                Deadline {new Date(priceAdjustmentPolicy.deadline).toLocaleDateString()} — {priceAdjustmentPolicy.windowDays}-day window
                {priceAdjustmentPolicy.isDefault ? ", app default" : ""}
              </Text>
              {priceAdjustmentPolicy.sourceNote && (
                <Text style={{ fontSize: 12, fontStyle: "italic", color: theme.colors.textTertiary }}>{priceAdjustmentPolicy.sourceNote}</Text>
              )}
              {merchantId && <PolicyEditor merchantId={merchantId} merchantName={merchantName} policy={priceAdjustmentPolicy} onSaved={onSaved} />}
            </View>
          )}
        </View>
      )}

      {!editing && (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
            {line.serialNumber ? `Serial: ${line.serialNumber}` : "No serial number recorded"}
          </Text>
          <Text accessibilityRole="button" style={{ fontSize: 12, color: theme.colors.brandDefault, fontWeight: "600" }} onPress={() => setEditing(true)}>
            Edit
          </Text>
        </View>
      )}

      {editing && (
        <View style={{ gap: 8, borderWidth: 1, borderColor: theme.colors.borderSubtle, borderRadius: theme.radius.md, padding: 10 }}>
          <TextField label="Serial number" value={serial} onChangeText={setSerial} placeholder="e.g. SN-1234567" />
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>This was a gift</Text>
            <Switch
              value={gift}
              onValueChange={setGift}
              accessibilityLabel="This was a gift"
              trackColor={{ false: theme.colors.borderDefault, true: theme.colors.brandDefault }}
              {...({ activeThumbColor: theme.colors.textOnBrand } as Record<string, string>)}
            />
          </View>
          {saveError && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{saveError}</Text>}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button variant="secondary" loading={saving} onPress={save}>
                Save
              </Button>
            </View>
            <View style={{ flex: 1 }}>
              <Button
                variant="ghost"
                onPress={() => {
                  setEditing(false);
                  setSerial(line.serialNumber ?? "");
                  setGift(line.giftFlag);
                  setSaveError(null);
                }}
              >
                Cancel
              </Button>
            </View>
          </View>
        </View>
      )}

      <ResalePanel line={line} merchantName={merchantName} purchaseDateLabel={purchaseDateLabel} onSaved={onSaved} />
    </View>
  );
}

// §40.3 Purchase state machine — `candidate → confirmed → fulfilled/partially fulfilled → kept / return
// started / gifted / sold / disposed`. Mirrors apps/web's identical PurchaseActions (see that file's doc
// comment for why kept/gifted/sold are deliberately NOT direct buttons here: "kept" has no manual endpoint
// at all, and gifted/sold are derived server-side from each line's own giftFlag/resaleStatus, already
// editable via LineItemRow/ResalePanel above). Inline confirm state, not RN's Alert.alert — matching this
// app's own established convention (see list/[id].tsx's identical reasoning: Alert.alert is a permanent
// no-op stub under react-native-web).
function PurchaseActions({ purchase, purchaseId, onSaved }: { purchase: PurchaseDetail["purchase"]; purchaseId: string; onSaved: () => void }) {
  const { theme } = useAppTheme();
  const [confirming, setConfirming] = useState(false);
  const [disposing, setDisposing] = useState(false);
  const [confirmingDispose, setConfirmingDispose] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmPurchase() {
    setError(null);
    setConfirming(true);
    try {
      await api.post(`/v1/purchases/${purchaseId}/confirm`);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't confirm this purchase.");
    } finally {
      setConfirming(false);
    }
  }

  async function disposePurchase() {
    setError(null);
    setDisposing(true);
    try {
      await api.post(`/v1/purchases/${purchaseId}/dispose`);
      setConfirmingDispose(false);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't mark this purchase disposed.");
    } finally {
      setDisposing(false);
    }
  }

  if (purchase.state === "disposed") return null;

  return (
    <View style={{ gap: 8 }}>
      {purchase.state === "candidate" && (
        <Button loading={confirming} onPress={confirmPurchase}>
          Confirm this purchase
        </Button>
      )}
      {purchase.state !== "candidate" && !confirmingDispose && (
        <Button variant="secondary" onPress={() => setConfirmingDispose(true)}>
          Mark as disposed
        </Button>
      )}
      {confirmingDispose && (
        <View style={{ gap: 8, backgroundColor: theme.colors.criticalSubtleBg, borderRadius: theme.radius.md, padding: 12 }}>
          <Text style={{ fontSize: 13, color: theme.colors.criticalSubtleText }}>
            There&apos;s no automatic way to undo this. Mark it disposed anyway?
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button variant="critical" loading={disposing} onPress={disposePurchase}>
                Mark disposed
              </Button>
            </View>
            <View style={{ flex: 1 }}>
              <Button variant="secondary" onPress={() => setConfirmingDispose(false)}>
                Cancel
              </Button>
            </View>
          </View>
        </View>
      )}
      {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
    </View>
  );
}

export default function PurchaseDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { theme } = useAppTheme();
  const [data, setData] = useState<PurchaseDetail | null | undefined>(undefined);
  // A bare `.then` with no `.catch` on a mount-time fetch becomes an unhandled promise rejection on any
  // transient network failure, which React Native Web surfaces as a full-screen "Uncaught Error" dev
  // overlay blocking the entire app, not just this screen (confirmed live — see entity/[id].tsx's identical
  // fix and doc comment).
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [retrying, setRetrying] = useState(false);

  function load() {
    // `error` must be cleared at the start of every load — not just on success further down — or a
    // successful retry after a failed load leaves `error` (and therefore the full-screen FetchError early
    // return above) stuck forever, since nothing else ever resets it. Confirmed live: Retry's own follow-up
    // fetch succeeded (200, real data in `data`) but the screen kept showing "Something went wrong" because
    // `error` was still truthy. Mirrors bill/[id].tsx's and event/[id].tsx's identical `setError(null)` at
    // the top of `load`.
    setError(null);
    api
      .get<PurchaseDetail | null>(`/v1/purchases/${id}`)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load this. Please try again."))
      .finally(() => setRetrying(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (error) {
    return (
      <Screen>
        <ScreenHeader title="Something went wrong" />
        <FetchError
          message={error}
          what="this purchase"
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
  if (!data) return <Screen><ScreenHeader title="Not found" /><EmptyState title="Not found" description="This purchase doesn't exist or you don't have access to it." /></Screen>;

  const { purchase, merchantName, lines, returns, shipments, evidence, priceAdjustments, priceAdjustmentPolicy } = data;
  const date = formatTemporal(purchase.purchaseDate);
  const total = formatMoneyMinorUnits(purchase.totalMinorUnits, purchase.totalCurrency);

  return (
    <Screen>
      <ScreenHeader title={`Order ${purchase.orderNumber ?? "—"}`} subtitle={date ?? undefined} />

      {/* Phase 2 §52.2 "object sharing" — mirrors apps/web's purchases/[id]/page.tsx. Unlike list/[id].tsx,
          PurchaseDetail's payload carries no owner id, so (matching documents.tsx's own precedent) the
          button is always shown and the backend's 403 on a non-owner's grant/link attempt does the gating. */}
      <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
        <Button variant="ghost" onPress={() => setSharing((s) => !s)}>
          Share
        </Button>
      </View>
      {sharing && (
        <Card>
          <ShareResourcePanel resourceId={String(id)} collectionPath="/v1/purchases" resourceLabel="purchase" />
        </Card>
      )}

      <Card style={{ gap: 6 }}>
        {total && <Text style={{ fontSize: 20, fontWeight: "700", color: theme.colors.textPrimary }}>{total}</Text>}
        <Badge tone={CONFIDENCE_TONE[purchase.confidenceBand] ?? "neutral"}>{purchase.confidenceBand.replace(/_/g, " ")}</Badge>
        <Text style={{ fontSize: 13, color: theme.colors.textTertiary, textTransform: "capitalize" }}>{purchase.state.replace(/_/g, " ")}</Text>
        {purchase.taxMinorUnits != null && (
          <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Tax: {formatMoneyMinorUnits(purchase.taxMinorUnits, purchase.totalCurrency)}</Text>
        )}
        {purchase.shippingMinorUnits != null && (
          <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Shipping: {formatMoneyMinorUnits(purchase.shippingMinorUnits, purchase.totalCurrency)}</Text>
        )}
        {purchase.paymentMethodHint && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Payment: {purchase.paymentMethodHint}</Text>}
        <PurchaseActions purchase={purchase} purchaseId={String(id)} onSaved={load} />
      </Card>

      {lines.length > 0 && (
        <Card style={{ gap: 12 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Items</Text>
          {lines.map((line) => (
            <LineItemRow
              key={line.id}
              line={line}
              currency={purchase.totalCurrency}
              router={router}
              merchantName={merchantName}
              merchantId={purchase.merchantId}
              purchaseDateLabel={date}
              priceAdjustment={priceAdjustments.find((a) => a.purchaseLineId === line.id)}
              priceAdjustmentPolicy={priceAdjustmentPolicy}
              onSaved={load}
            />
          ))}
        </Card>
      )}

      {returns.length > 0 && (
        <Card style={{ gap: 8 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Returns</Text>
          {returns.map((r) => (
            <Text accessibilityRole="button"
              key={r.id}
              style={{ fontSize: 13, color: theme.colors.brandDefault }}
              onPress={() => router.push(`/return-case/${r.id}`)}
            >
              Return case — {formatTemporal(r.deadline) ?? r.state}
            </Text>
          ))}
        </Card>
      )}

      {shipments.length > 0 && (
        <Card style={{ gap: 8 }}>
          <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Shipments</Text>
          {shipments.map((s) => (
            <Text accessibilityRole="button"
              key={s.id}
              style={{ fontSize: 13, color: theme.colors.brandDefault }}
              onPress={() => router.push(`/shipment/${s.id}`)}
            >
              {s.carrier} — {s.trackingNumber} ({s.status.replace(/_/g, " ")})
            </Text>
          ))}
        </Card>
      )}

      <EvidenceCard evidence={evidence} />
    </Screen>
  );
}
