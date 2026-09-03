"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import useSWR from "swr";
import { api, swrFetcher, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { FetchError } from "@/components/ui/fetch-error";
import { ShareResourcePanel } from "@/components/sharing/share-resource-panel";
import { SharedNoteBanner } from "@/components/sharing/shared-note-banner";
import { HouseholdAssignmentControl } from "@/components/ui/household-picker";
import { formatMoneyMinorUnits, formatTemporal, daysUntil, type TemporalValueLike } from "@/lib/format";

interface RecallMatch {
  id: string;
  component: string | null;
  summary: string;
  url: string | null;
  status: "open" | "potential_match_verify_vin" | "closed_or_repaired";
}

interface MaintenanceRule {
  id: string;
  label: string;
  intervalDays: number | null;
  lastPerformedDate: TemporalValueLike | null;
  source: "user_added" | "seeded_generic_guidance";
  confidenceNote: string | null;
}

interface MaintenanceRuleTemplate {
  key: string;
  label: string;
  intervalDays?: number;
  confidenceNote: string;
}

interface HomeAsset {
  id: string;
  label: string;
  category: string | null;
  room: string | null;
  make: string | null;
  model: string | null;
  installDate: TemporalValueLike | null;
  recalls: RecallMatch[];
  maintenanceRules: MaintenanceRule[];
}

interface PropertyDetail {
  property: {
    id: string;
    label: string;
    propertyType: string;
    address: string | null;
    moveInDate: TemporalValueLike;
    householdId: string | null;
  };
  warranties: Array<{ id: string; productLabel: string; expirationDate: TemporalValueLike }>;
  maintenance: Array<{
    id: string;
    description: string;
    serviceDate: TemporalValueLike;
    costMinorUnits: number | null;
    costCurrency: string | null;
  }>;
  homeAssets: HomeAsset[];
  sharedNote: string | null;
}

// HOMEOS-008 — mirrors the vehicle detail page's identical recall-status vocabulary (life/vehicles/[id]/page.tsx).
const RECALL_STATUS_LABEL: Record<RecallMatch["status"], string> = {
  open: "Confirmed — needs action",
  potential_match_verify_vin: "Potential match — verify",
  closed_or_repaired: "Repaired / closed",
};
const RECALL_STATUS_TONE: Record<RecallMatch["status"], "critical" | "warning" | "positive"> = {
  open: "critical",
  potential_match_verify_vin: "warning",
  closed_or_repaired: "positive",
};

export default function PropertyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data, error: fetchError, isLoading, mutate } = useSWR<PropertyDetail | null>(`/v1/properties/${id}`, swrFetcher);
  const [addingRecord, setAddingRecord] = useState(false);
  const [description, setDescription] = useState("");
  const [cost, setCost] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [addingAsset, setAddingAsset] = useState(false);
  const [assetLabel, setAssetLabel] = useState("");
  const [assetRoom, setAssetRoom] = useState("");
  const [assetMake, setAssetMake] = useState("");
  const [assetModel, setAssetModel] = useState("");
  const [assetError, setAssetError] = useState<string | null>(null);
  const [checkingAssetId, setCheckingAssetId] = useState<string | null>(null);
  // HOMEOS-004 — per-asset maintenance rules. Templates are fetched lazily (per asset, on first "+ Add
  // rule" click) rather than up front for every asset on the page.
  const [ruleTemplatesByAsset, setRuleTemplatesByAsset] = useState<Record<string, MaintenanceRuleTemplate[]>>({});
  const [addingRuleForAsset, setAddingRuleForAsset] = useState<string | null>(null);
  const [ruleLabel, setRuleLabel] = useState("");
  const [ruleIntervalDays, setRuleIntervalDays] = useState("");
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [ruleBusyId, setRuleBusyId] = useState<string | null>(null);

  if (isLoading) return <div className="h-40 animate-pulse rounded-xl bg-subtle" />;
  if (fetchError && !data) {
    return (
      <div className="space-y-6">
        <Link href="/life" className="text-sm text-tertiary hover:text-primary">
          ← Back to Life
        </Link>
        <FetchError what="this property" message={fetchError instanceof ApiError ? fetchError.message : undefined} onRetry={() => mutate()} />
      </div>
    );
  }
  if (!data) return <EmptyState title="Not found" description="This property doesn't exist or you don't have access to it." />;

  const { property, warranties, maintenance, homeAssets } = data;
  const moveIn = formatTemporal(property.moveInDate);
  const openRecallCount = homeAssets.reduce((sum, a) => sum + a.recalls.filter((r) => r.status !== "closed_or_repaired").length, 0);

  async function addRecord() {
    if (!description.trim()) return;
    // `Math.round(Number("abc") * 100)` is NaN, and `JSON.stringify` silently turns NaN into `null` — the
    // record was saved with the cost quietly dropped and no error shown at all (confirmed live: typing
    // "not-a-number" into Cost produced a record with no dollar amount, no warning, same bug already fixed
    // on the mobile equivalent of this screen — see property/[id].tsx). Validate client-side instead of
    // letting a typo through as silent data loss.
    const trimmedCost = cost.trim();
    const parsedCost = trimmedCost ? Number(trimmedCost) : null;
    if (trimmedCost && (Number.isNaN(parsedCost) || parsedCost! < 0)) {
      setError("Enter a valid, non-negative cost (e.g. 42.50), or leave it blank.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.post("/v1/maintenance-records", {
        description,
        propertyProfileId: id,
        costMinorUnits: parsedCost != null ? Math.round(parsedCost * 100) : undefined,
        costCurrency: parsedCost != null ? "USD" : undefined,
      });
      setDescription("");
      setCost("");
      setAddingRecord(false);
      await mutate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that record.");
    } finally {
      setSubmitting(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Remove "${property.label}"? Its warranty and maintenance history go with it — this can't be undone.`)) return;
    setDeleting(true);
    try {
      await api.delete(`/v1/properties/${id}`);
      router.push("/life");
    } finally {
      setDeleting(false);
    }
  }

  async function addAsset() {
    if (!assetLabel.trim()) return;
    setAssetError(null);
    try {
      await api.post("/v1/home-assets", {
        propertyProfileId: id,
        label: assetLabel,
        room: assetRoom.trim() || undefined,
        make: assetMake.trim() || undefined,
        model: assetModel.trim() || undefined,
      });
      setAssetLabel("");
      setAssetRoom("");
      setAssetMake("");
      setAssetModel("");
      setAddingAsset(false);
      await mutate();
    } catch (err) {
      setAssetError(err instanceof ApiError ? err.message : "Couldn't add that home asset.");
    }
  }

  async function loadAssetRuleTemplates(assetId: string) {
    if (ruleTemplatesByAsset[assetId]) return;
    try {
      const templates = await api.get<MaintenanceRuleTemplate[]>(`/v1/home-assets/${assetId}/maintenance-rule-templates`);
      setRuleTemplatesByAsset((prev) => ({ ...prev, [assetId]: templates }));
    } catch {
      setRuleTemplatesByAsset((prev) => ({ ...prev, [assetId]: [] }));
    }
  }

  async function addAssetRuleFromTemplate(assetId: string, templateKey: string) {
    setRuleError(null);
    try {
      await api.post("/v1/maintenance-rules/from-template", { homeAssetId: assetId, templateKey });
      await mutate();
    } catch (err) {
      setRuleError(err instanceof ApiError ? err.message : "Couldn't add that suggested rule.");
    }
  }

  async function addCustomAssetRule(assetId: string) {
    if (!ruleLabel.trim() || !ruleIntervalDays.trim()) return;
    setRuleError(null);
    try {
      await api.post("/v1/maintenance-rules", {
        homeAssetId: assetId,
        label: ruleLabel,
        intervalType: "calendar",
        intervalDays: Math.round(Number(ruleIntervalDays)),
      });
      setRuleLabel("");
      setRuleIntervalDays("");
      setAddingRuleForAsset(null);
      await mutate();
    } catch (err) {
      setRuleError(err instanceof ApiError ? err.message : "Couldn't add that maintenance rule.");
    }
  }

  async function completeAssetRule(ruleId: string) {
    setRuleBusyId(ruleId);
    setRuleError(null);
    try {
      await api.post(`/v1/maintenance-rules/${ruleId}/complete`, {});
      await mutate();
    } catch (err) {
      setRuleError(err instanceof ApiError ? err.message : "Couldn't mark that done.");
    } finally {
      setRuleBusyId(null);
    }
  }

  async function deleteAssetRule(ruleId: string) {
    if (!window.confirm("Remove this maintenance rule?")) return;
    setRuleBusyId(ruleId);
    try {
      await api.delete(`/v1/maintenance-rules/${ruleId}`);
      await mutate();
    } finally {
      setRuleBusyId(null);
    }
  }

  async function removeAsset(assetId: string, label: string) {
    if (!window.confirm(`Remove "${label}"?`)) return;
    await api.delete(`/v1/home-assets/${assetId}`);
    await mutate();
  }

  async function checkAssetRecalls(assetId: string) {
    setCheckingAssetId(assetId);
    try {
      await api.post(`/v1/home-assets/${assetId}/check-recalls`, {});
      await mutate();
    } finally {
      setCheckingAssetId(null);
    }
  }

  async function confirmAssetRecall(recallId: string) {
    await api.post(`/v1/recall-matches/${recallId}/confirm`, {});
    await mutate();
  }

  async function resolveAssetRecall(recallId: string) {
    await api.post(`/v1/recall-matches/${recallId}/resolve`, {});
    await mutate();
  }

  return (
    <div className="space-y-6">
      <Link href="/life" className="text-sm text-tertiary hover:text-primary">
        ← Back to Life
      </Link>
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-primary">{property.label}</h1>
            {openRecallCount > 0 && <Badge tone="critical">{openRecallCount} recall{openRecallCount === 1 ? "" : "s"}</Badge>}
          </div>
          <p className="mt-1 text-sm text-tertiary">
            {property.address}
            {property.address && moveIn ? " — " : ""}
            {moveIn && `Moved in ${moveIn}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => setSharing((s) => !s)}>
            Share
          </Button>
          <Button variant="secondary" onClick={remove} loading={deleting}>
            Remove
          </Button>
        </div>
      </header>

      <SharedNoteBanner note={data.sharedNote} />

      <Card>
        <CardBody>
          <HouseholdAssignmentControl
            householdId={property.householdId}
            onChange={async (next) => {
              await api.put(`/v1/properties/${id}`, { householdId: next });
              await mutate();
            }}
          />
        </CardBody>
      </Card>

      {sharing && (
        <Card>
          <CardBody>
            <ShareResourcePanel resourceId={String(id)} collectionPath="/v1/properties" resourceLabel="property" />
          </CardBody>
        </Card>
      )}

      <Card>
        <CardBody className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wide text-tertiary">Home assets</p>
            {!addingAsset && (
              <button onClick={() => setAddingAsset(true)} className="text-sm font-medium text-brand hover:underline">
                + Add an asset
              </button>
            )}
          </div>
          {homeAssets.length === 0 && !addingAsset && <p className="text-sm text-tertiary">No systems or appliances tracked yet.</p>}
          {homeAssets.map((a) => {
            const openAssetRecalls = a.recalls.filter((r) => r.status !== "closed_or_repaired");
            return (
              <div key={a.id} className="space-y-1.5 border-t border-border-subtle py-3 first:border-t-0">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <span className="text-sm font-medium text-primary">{a.label}</span>
                    {a.room && <span className="ml-2 text-xs text-tertiary">{a.room}</span>}
                    {(a.make || a.model) && <span className="ml-2 text-xs text-tertiary">{[a.make, a.model].filter(Boolean).join(" ")}</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    {openAssetRecalls.length > 0 && <Badge tone="critical">{openAssetRecalls.length} recall{openAssetRecalls.length === 1 ? "" : "s"}</Badge>}
                    <button onClick={() => checkAssetRecalls(a.id)} disabled={checkingAssetId === a.id} className="text-xs font-medium text-brand hover:underline disabled:opacity-50">
                      {checkingAssetId === a.id ? "Checking…" : "Check for recalls"}
                    </button>
                    <button onClick={() => removeAsset(a.id, a.label)} className="text-xs font-medium text-tertiary hover:underline">
                      Remove
                    </button>
                  </div>
                </div>
                {a.maintenanceRules.map((r) => {
                  const last = formatTemporal(r.lastPerformedDate);
                  const busy = ruleBusyId === r.id;
                  return (
                    <div key={r.id} className="ml-2 flex items-center justify-between rounded-lg bg-subtle p-2">
                      <div>
                        <p className="text-xs font-medium text-primary">{r.label}</p>
                        <p className="text-xs text-tertiary">
                          Every {r.intervalDays} days{last && ` — last done ${last}`}
                        </p>
                        {r.source === "seeded_generic_guidance" && r.confidenceNote && <p className="text-xs italic text-tertiary">{r.confidenceNote}</p>}
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <button onClick={() => completeAssetRule(r.id)} disabled={busy} className="text-xs font-medium text-brand hover:underline disabled:opacity-50">
                          Mark done
                        </button>
                        <button onClick={() => deleteAssetRule(r.id)} disabled={busy} className="text-xs font-medium text-tertiary hover:underline disabled:opacity-50">
                          Remove
                        </button>
                      </div>
                    </div>
                  );
                })}
                {addingRuleForAsset === a.id ? (
                  <div className="ml-2 space-y-2 rounded-lg bg-subtle p-2">
                    {(ruleTemplatesByAsset[a.id]?.length ?? 0) > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {ruleTemplatesByAsset[a.id]!.map((t) => (
                          <button
                            key={t.key}
                            onClick={() => addAssetRuleFromTemplate(a.id, t.key)}
                            title={t.confidenceNote}
                            className="rounded-full border border-border-subtle px-2 py-0.5 text-xs font-medium text-secondary hover:border-brand hover:text-brand"
                          >
                            + {t.label}
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="flex flex-wrap items-end gap-2">
                      <Input value={ruleLabel} onChange={(e) => setRuleLabel(e.target.value)} placeholder="e.g. Filter change" className="min-w-[140px] flex-1" />
                      <div className="w-28 shrink-0">
                        <Input value={ruleIntervalDays} onChange={(e) => setRuleIntervalDays(e.target.value)} placeholder="Every N days" inputMode="numeric" />
                      </div>
                      <Button size="sm" onClick={() => addCustomAssetRule(a.id)} disabled={!ruleLabel.trim() || !ruleIntervalDays.trim()}>
                        Add
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setAddingRuleForAsset(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => {
                      setAddingRuleForAsset(a.id);
                      void loadAssetRuleTemplates(a.id);
                    }}
                    className="ml-2 text-xs font-medium text-brand hover:underline"
                  >
                    + Add maintenance rule
                  </button>
                )}
                {a.recalls.map((r) => (
                  <div key={r.id} className="ml-2 space-y-1 rounded-lg bg-subtle p-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-primary">{r.component ?? "Recall"}</span>
                      <Badge tone={RECALL_STATUS_TONE[r.status]}>{RECALL_STATUS_LABEL[r.status]}</Badge>
                    </div>
                    <p className="text-xs text-secondary">{r.summary}</p>
                    {r.status !== "closed_or_repaired" && (
                      <div className="flex gap-2">
                        {r.status === "potential_match_verify_vin" && (
                          <button onClick={() => confirmAssetRecall(r.id)} className="text-xs font-medium text-brand hover:underline">
                            This affects my unit
                          </button>
                        )}
                        <button onClick={() => resolveAssetRecall(r.id)} className="text-xs font-medium text-tertiary hover:underline">
                          Mark repaired
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
          {addingAsset && (
            <div className="flex flex-wrap items-end gap-2 border-t border-border-subtle pt-3">
              <Input value={assetLabel} onChange={(e) => setAssetLabel(e.target.value)} placeholder="e.g. Kitchen refrigerator" className="min-w-[180px] flex-1" />
              {/* HOMEOS-002 "Add rooms as needed... without forcing setup" — free text, no room list to set up first. */}
              <Input value={assetRoom} onChange={(e) => setAssetRoom(e.target.value)} placeholder="Room (optional)" className="min-w-[120px] flex-1" />
              <Input value={assetMake} onChange={(e) => setAssetMake(e.target.value)} placeholder="Make" className="min-w-[120px] flex-1" />
              <Input value={assetModel} onChange={(e) => setAssetModel(e.target.value)} placeholder="Model" className="min-w-[120px] flex-1" />
              <Button onClick={addAsset} disabled={!assetLabel.trim()}>
                Add
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setAddingAsset(false);
                  setAssetLabel("");
                  setAssetRoom("");
                  setAssetMake("");
                  setAssetModel("");
                  setAssetError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          )}
          {assetError && <p className="text-sm text-critical">{assetError}</p>}
          {ruleError && <p className="text-sm text-critical">{ruleError}</p>}
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-2">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tertiary">Warranties</p>
          {warranties.length === 0 && <p className="text-sm text-tertiary">None linked yet.</p>}
          {warranties.map((w) => {
            const days = daysUntil(w.expirationDate);
            return (
              <Link key={w.id} href={`/life/warranties/${w.id}`} className="flex items-center justify-between py-1 text-sm hover:text-brand">
                <span className="text-primary">{w.productLabel}</span>
                {days != null && <Badge tone={days <= 30 ? "warning" : "neutral"}>{days > 0 ? `${days}d left` : "Expired"}</Badge>}
              </Link>
            );
          })}
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wide text-tertiary">Maintenance history</p>
            {!addingRecord && (
              <button onClick={() => setAddingRecord(true)} className="text-sm font-medium text-brand hover:underline">
                + Add a record
              </button>
            )}
          </div>
          {maintenance.length === 0 && !addingRecord && <p className="text-sm text-tertiary">No service history logged yet.</p>}
          {maintenance.map((m) => {
            const date = formatTemporal(m.serviceDate);
            const amount = formatMoneyMinorUnits(m.costMinorUnits, m.costCurrency);
            return (
              <div key={m.id} className="flex items-center justify-between border-t border-border-subtle py-2 text-sm first:border-t-0">
                <div>
                  <p className="text-primary">{m.description}</p>
                  {date && <p className="text-xs text-tertiary">{date}</p>}
                </div>
                {amount && <p className="text-primary">{amount}</p>}
              </div>
            );
          })}
          {addingRecord && (
            <div className="flex flex-wrap items-end gap-2 border-t border-border-subtle pt-3">
              <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Roof repair" className="min-w-[180px] flex-1" />
              {/* Wrapped instead of passing className="w-40" straight to Input: Input's own base class
                  already hardcodes `w-full`, and `cn()` (lib/cn.ts) is a plain string join with no
                  Tailwind conflict resolution — a bare `w-40` on the input loses to that `w-full` in the
                  compiled stylesheet (verified via computed style: renders at full container width,
                  ~862px, not 160px), which was forcing this field onto its own full-width row instead of
                  sitting beside the description field. Constraining the wrapper's width sidesteps the
                  conflict without touching the shared Input component. */}
              <div className="w-40 shrink-0">
                <Input value={cost} onChange={(e) => setCost(e.target.value)} placeholder="Cost (USD, optional)" inputMode="decimal" />
              </div>
              <Button onClick={addRecord} loading={submitting} disabled={!description.trim()}>
                Add
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setAddingRecord(false);
                  setDescription("");
                  setCost("");
                  setError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          )}
          {error && <p className="text-sm text-critical">{error}</p>}
        </CardBody>
      </Card>
    </div>
  );
}
