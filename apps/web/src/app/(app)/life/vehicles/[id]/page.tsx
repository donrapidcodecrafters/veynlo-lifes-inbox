"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import useSWR from "swr";
import { api, swrFetcher, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, FieldError } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/ui/empty-state";
import { FetchError } from "@/components/ui/fetch-error";
import { ShareResourcePanel } from "@/components/sharing/share-resource-panel";
import { SharedNoteBanner } from "@/components/sharing/shared-note-banner";
import { HouseholdAssignmentControl } from "@/components/ui/household-picker";
import { formatMoneyMinorUnits, formatTemporal, daysUntil, type TemporalValueLike } from "@/lib/format";

interface RecallMatch {
  id: string;
  campaignNumber: string;
  component: string | null;
  summary: string;
  remedy: string | null;
  url: string | null;
  status: "open" | "potential_match_verify_vin" | "closed_or_repaired";
  checkedAt: string;
}

interface OdometerObservation {
  id: string;
  mileage: number;
  observedAt: TemporalValueLike;
  source: string;
}

interface Tire {
  id: string;
  brand: string | null;
  model: string | null;
  size: string | null;
  installDate: TemporalValueLike | null;
  installMileage: number | null;
  pressureSpecPsi: number | null;
  warrantyMonths: number | null;
  roadHazardWarranty: string | null;
  status: "active" | "replaced";
  replacedAt: TemporalValueLike | null;
  rotationHistory: Array<{ date: string; mileage: number | null }>;
}

interface VinDecodeAttributes {
  decodedFromVin: string;
  trim: string | null;
  series: string | null;
  bodyClass: string | null;
  vehicleType: string | null;
  manufacturer: string | null;
  engineCylinders: number | null;
  engineHP: number | null;
  fuelTypePrimary: string | null;
  driveType: string | null;
  doors: number | null;
  plantCountry: string | null;
}

interface MaintenanceRule {
  id: string;
  label: string;
  intervalType: "calendar" | "mileage" | "calendar_or_mileage";
  intervalDays: number | null;
  intervalMiles: number | null;
  baselineMileage: number | null;
  lastPerformedDate: TemporalValueLike | null;
  source: "user_added" | "seeded_generic_guidance";
  confidenceNote: string | null;
}

interface MaintenanceRuleTemplate {
  key: string;
  label: string;
  intervalType: "calendar" | "mileage" | "calendar_or_mileage";
  intervalDays?: number;
  intervalMiles?: number;
  confidenceNote: string;
}

interface RegistrationRecord {
  id: string;
  recordType: "registration" | "inspection" | "emissions" | "other";
  jurisdiction: string | null;
  renewalDueDate: TemporalValueLike | null;
  reminderLeadDays: number;
  lastRenewedDate: TemporalValueLike | null;
  status: "active" | "expired";
}

interface VehicleDetail {
  vehicle: {
    id: string;
    label: string;
    make: string | null;
    model: string | null;
    year: number | null;
    vin: string | null;
    vinDecodedAt: string | null;
    vinDecodeAttributes: VinDecodeAttributes | null;
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
  recalls: RecallMatch[];
  odometerObservations: OdometerObservation[];
  tires: Tire[];
  maintenanceRules: MaintenanceRule[];
  registrationRecords: RegistrationRecord[];
  sharedNote: string | null;
}

const INTERVAL_LABEL: Record<MaintenanceRule["intervalType"], (r: { intervalDays: number | null; intervalMiles: number | null }) => string> = {
  calendar: (r) => `Every ${r.intervalDays} days`,
  mileage: (r) => `Every ${r.intervalMiles?.toLocaleString()} mi`,
  calendar_or_mileage: (r) => `Every ${r.intervalDays} days or ${r.intervalMiles?.toLocaleString()} mi, whichever first`,
};

const REGISTRATION_TYPE_LABEL: Record<RegistrationRecord["recordType"], string> = {
  registration: "Registration",
  inspection: "Inspection",
  emissions: "Emissions test",
  other: "Renewal",
};

// VEH-006 "Alerts distinguish open, repaired/closed if known, and 'potential match; verify VIN'" — one
// place both this page and the mobile equivalent's wording should stay in sync with (they don't share
// code, but the vocabulary should read identically to a user moving between platforms).
const RECALL_STATUS_LABEL: Record<RecallMatch["status"], string> = {
  open: "Confirmed — needs action",
  potential_match_verify_vin: "Potential match — verify VIN",
  closed_or_repaired: "Repaired / closed",
};
const RECALL_STATUS_TONE: Record<RecallMatch["status"], "critical" | "warning" | "positive"> = {
  open: "critical",
  potential_match_verify_vin: "warning",
  closed_or_repaired: "positive",
};

export default function VehicleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data, error: fetchError, isLoading, mutate } = useSWR<VehicleDetail | null>(`/v1/vehicles/${id}`, swrFetcher);
  const [addingRecord, setAddingRecord] = useState(false);
  const [description, setDescription] = useState("");
  const [cost, setCost] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [checkingRecalls, setCheckingRecalls] = useState(false);
  const [recallError, setRecallError] = useState<string | null>(null);
  const [addingOdometer, setAddingOdometer] = useState(false);
  const [odometerReading, setOdometerReading] = useState("");
  const [odometerError, setOdometerError] = useState<string | null>(null);
  const [addingTire, setAddingTire] = useState(false);
  const [tireBrand, setTireBrand] = useState("");
  const [tireModel, setTireModel] = useState("");
  const [tireSize, setTireSize] = useState("");
  const [tireInstallDate, setTireInstallDate] = useState("");
  const [tireInstallMileage, setTireInstallMileage] = useState("");
  const [tirePressure, setTirePressure] = useState("");
  const [tireWarrantyMonths, setTireWarrantyMonths] = useState("");
  const [tireHasRoadHazard, setTireHasRoadHazard] = useState(false);
  const [tireRoadHazardDetail, setTireRoadHazardDetail] = useState("");
  const [tireError, setTireError] = useState<string | null>(null);
  const [tireFieldErrors, setTireFieldErrors] = useState<Record<string, string>>({});
  const [expandedTireId, setExpandedTireId] = useState<string | null>(null);
  const [tireBusyId, setTireBusyId] = useState<string | null>(null);
  const [decodingVin, setDecodingVin] = useState(false);
  const [vinDecodeMessage, setVinDecodeMessage] = useState<string | null>(null);
  const [vinDecodeError, setVinDecodeError] = useState<string | null>(null);
  const [ruleTemplates, setRuleTemplates] = useState<MaintenanceRuleTemplate[] | null>(null);
  const [addingRule, setAddingRule] = useState(false);
  const [ruleLabel, setRuleLabel] = useState("");
  const [ruleIntervalType, setRuleIntervalType] = useState<MaintenanceRule["intervalType"]>("calendar_or_mileage");
  const [ruleIntervalDays, setRuleIntervalDays] = useState("");
  const [ruleIntervalMiles, setRuleIntervalMiles] = useState("");
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [ruleBusyId, setRuleBusyId] = useState<string | null>(null);
  const [addingRegistration, setAddingRegistration] = useState(false);
  const [regType, setRegType] = useState<RegistrationRecord["recordType"]>("registration");
  const [regJurisdiction, setRegJurisdiction] = useState("");
  const [regDueDate, setRegDueDate] = useState("");
  const [regError, setRegError] = useState<string | null>(null);
  const [regBusyId, setRegBusyId] = useState<string | null>(null);

  if (isLoading) return <div className="h-40 animate-pulse rounded-xl bg-subtle" />;
  if (fetchError && !data) {
    return (
      <div className="space-y-6">
        <Link href="/life" className="text-sm text-tertiary hover:text-primary">
          ← Back to Life
        </Link>
        <FetchError what="this vehicle" message={fetchError instanceof ApiError ? fetchError.message : undefined} onRetry={() => mutate()} />
      </div>
    );
  }
  if (!data) return <EmptyState title="Not found" description="This vehicle doesn't exist or you don't have access to it." />;

  const { vehicle, warranties, maintenance, recalls, odometerObservations, tires } = data;
  const subtitle = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ");
  // VEH-006 "badge on the vehicle detail page" — counts anything not yet resolved, whether it's still an
  // automated potential match or a confirmed open recall; a closed_or_repaired one is handled and doesn't count.
  const openRecallCount = recalls.filter((r) => r.status !== "closed_or_repaired").length;
  const latestMileage = odometerObservations[0]?.mileage ?? null; // already ordered latest-first by the API

  async function addRecord() {
    if (!description.trim()) return;
    // `Math.round(Number("abc") * 100)` is NaN, and `JSON.stringify` silently turns NaN into `null` — the
    // record used to save with the cost quietly dropped and no error shown at all. Same bug apps/mobile's
    // vehicle detail screen already fixed (see its addRecord for the identical comment); validate
    // client-side instead of letting a typo through as silent data loss.
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
        vehicleProfileId: id,
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
    if (!window.confirm(`Remove "${vehicle.label}"? Its warranty and maintenance history go with it — this can't be undone.`)) return;
    setDeleting(true);
    try {
      await api.delete(`/v1/vehicles/${id}`);
      router.push("/life");
    } finally {
      setDeleting(false);
    }
  }

  async function checkRecalls() {
    setCheckingRecalls(true);
    setRecallError(null);
    try {
      await api.post(`/v1/vehicles/${id}/check-recalls`, {});
      await mutate();
    } catch (err) {
      setRecallError(err instanceof ApiError ? err.message : "Couldn't check for recalls right now.");
    } finally {
      setCheckingRecalls(false);
    }
  }

  async function confirmRecall(recallId: string) {
    await api.post(`/v1/recall-matches/${recallId}/confirm`, {});
    await mutate();
  }

  async function resolveRecall(recallId: string) {
    await api.post(`/v1/recall-matches/${recallId}/resolve`, {});
    await mutate();
  }

  async function addOdometerReading() {
    const trimmed = odometerReading.trim();
    const mileage = trimmed ? Number(trimmed) : NaN;
    if (!trimmed || Number.isNaN(mileage) || mileage < 0) {
      setOdometerError("Enter a valid, non-negative mileage.");
      return;
    }
    setOdometerError(null);
    try {
      await api.post("/v1/odometer-observations", { vehicleProfileId: id, mileage: Math.round(mileage), source: "user_entered" });
      setOdometerReading("");
      setAddingOdometer(false);
      await mutate();
    } catch (err) {
      setOdometerError(err instanceof ApiError ? err.message : "Couldn't save that reading.");
    }
  }

  // Mirrors the DTO's own bounds (CreateTireDtoSchema in services/api/src/modules/assets/dto.ts) so a bad
  // value is caught here, next to the field the user is looking at, instead of round-tripping to the server
  // for a generic-banner rejection — matching addRecord/addOdometerReading's client-side validation above.
  function validateTireFields(): Record<string, string> | null {
    const errs: Record<string, string> = {};
    const mileage = tireInstallMileage.trim();
    if (mileage) {
      const n = Number(mileage);
      if (!Number.isInteger(n) || n < 0 || n > 2_000_000) errs.installMileage = "Enter a whole number of miles (0–2,000,000).";
    }
    const pressure = tirePressure.trim();
    if (pressure) {
      const n = Number(pressure);
      if (!Number.isInteger(n) || n < 1 || n > 200) errs.pressureSpecPsi = "Enter a realistic tire pressure in PSI (1–200).";
    }
    const warranty = tireWarrantyMonths.trim();
    if (warranty) {
      const n = Number(warranty);
      if (!Number.isInteger(n) || n < 0 || n > 600) errs.warrantyMonths = "Enter a whole number of months (0–600).";
    }
    return Object.keys(errs).length > 0 ? errs : null;
  }

  async function addTire() {
    setTireError(null);
    const validationErrors = validateTireFields();
    if (validationErrors) {
      setTireFieldErrors(validationErrors);
      return;
    }
    setTireFieldErrors({});
    try {
      await api.post("/v1/tires", {
        vehicleProfileId: id,
        brand: tireBrand.trim() || undefined,
        model: tireModel.trim() || undefined,
        size: tireSize.trim() || undefined,
        installDateIso: tireInstallDate || undefined,
        installMileage: tireInstallMileage.trim() ? Math.round(Number(tireInstallMileage)) : undefined,
        pressureSpecPsi: tirePressure.trim() ? Math.round(Number(tirePressure)) : undefined,
        warrantyMonths: tireWarrantyMonths.trim() ? Math.round(Number(tireWarrantyMonths)) : undefined,
        roadHazardWarranty: tireHasRoadHazard ? tireRoadHazardDetail.trim() || "Yes" : undefined,
      });
      setTireBrand("");
      setTireModel("");
      setTireSize("");
      setTireInstallDate("");
      setTireInstallMileage("");
      setTirePressure("");
      setTireWarrantyMonths("");
      setTireHasRoadHazard(false);
      setTireRoadHazardDetail("");
      setAddingTire(false);
      await mutate();
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors) {
        setTireFieldErrors(Object.fromEntries(Object.entries(err.fieldErrors).map(([k, v]) => [k, v[0] ?? ""])));
      }
      setTireError(err instanceof ApiError ? err.message : "Couldn't add that tire.");
    }
  }

  async function rotateTire(tireId: string) {
    setTireError(null);
    setTireBusyId(tireId);
    try {
      await api.post(`/v1/tires/${tireId}/rotate`, { mileage: latestMileage ?? undefined });
      await mutate();
    } catch (err) {
      setTireError(err instanceof ApiError ? err.message : "Couldn't log that rotation.");
    } finally {
      setTireBusyId(null);
    }
  }

  async function replaceTire(tireId: string) {
    if (!window.confirm("Mark this tire replaced? Its history stays on record.")) return;
    setTireError(null);
    setTireBusyId(tireId);
    try {
      await api.post(`/v1/tires/${tireId}/replace`, {});
      await mutate();
    } catch (err) {
      setTireError(err instanceof ApiError ? err.message : "Couldn't replace that tire.");
    } finally {
      setTireBusyId(null);
    }
  }

  // VEH-001 "VIN decode may prefill public vehicle attributes; user confirms" — decodes the VIN already on
  // file and shows what, if anything, got filled in (empty fields only — see AssetsService.applyVinDecode).
  async function decodeVin() {
    setDecodingVin(true);
    setVinDecodeError(null);
    setVinDecodeMessage(null);
    try {
      const result = await api.post<{ suggestion: { success: boolean; errorText: string | null; attributes: VinDecodeAttributes }; applied: { make: boolean; model: boolean; year: boolean } }>(`/v1/vehicles/${id}/vin-decode`, {});
      if (!result.suggestion.success) {
        setVinDecodeError(result.suggestion.errorText ?? "Couldn't decode that VIN.");
      } else {
        const filled = (["make", "model", "year"] as const).filter((f) => result.applied[f]);
        setVinDecodeMessage(filled.length > 0 ? `Filled in ${filled.join(", ")} from the VIN. Review and correct anything that's wrong.` : "Decoded successfully — nothing new to fill in.");
      }
      await mutate();
    } catch (err) {
      setVinDecodeError(err instanceof ApiError ? err.message : "Couldn't decode that VIN right now.");
    } finally {
      setDecodingVin(false);
    }
  }

  async function loadRuleTemplates() {
    if (ruleTemplates) return;
    try {
      const templates = await api.get<MaintenanceRuleTemplate[]>(`/v1/vehicles/${id}/maintenance-rule-templates`);
      setRuleTemplates(templates);
    } catch {
      setRuleTemplates([]);
    }
  }

  async function addRuleFromTemplate(templateKey: string) {
    setRuleError(null);
    try {
      await api.post("/v1/maintenance-rules/from-template", { vehicleProfileId: id, templateKey });
      await mutate();
    } catch (err) {
      setRuleError(err instanceof ApiError ? err.message : "Couldn't add that suggested rule.");
    }
  }

  async function addCustomRule() {
    setRuleError(null);
    if (!ruleLabel.trim()) return;
    const days = ruleIntervalDays.trim() ? Math.round(Number(ruleIntervalDays)) : undefined;
    const miles = ruleIntervalMiles.trim() ? Math.round(Number(ruleIntervalMiles)) : undefined;
    try {
      await api.post("/v1/maintenance-rules", {
        vehicleProfileId: id,
        label: ruleLabel,
        intervalType: ruleIntervalType,
        intervalDays: ruleIntervalType !== "mileage" ? days : undefined,
        intervalMiles: ruleIntervalType !== "calendar" ? miles : undefined,
      });
      setRuleLabel("");
      setRuleIntervalDays("");
      setRuleIntervalMiles("");
      setAddingRule(false);
      await mutate();
    } catch (err) {
      setRuleError(err instanceof ApiError ? err.message : "Couldn't add that maintenance rule.");
    }
  }

  async function completeRule(ruleId: string) {
    setRuleBusyId(ruleId);
    setRuleError(null);
    try {
      await api.post(`/v1/maintenance-rules/${ruleId}/complete`, { performedMileage: latestMileage ?? undefined });
      await mutate();
    } catch (err) {
      setRuleError(err instanceof ApiError ? err.message : "Couldn't mark that done.");
    } finally {
      setRuleBusyId(null);
    }
  }

  async function deleteRule(ruleId: string) {
    if (!window.confirm("Remove this maintenance rule?")) return;
    setRuleBusyId(ruleId);
    try {
      await api.delete(`/v1/maintenance-rules/${ruleId}`);
      await mutate();
    } finally {
      setRuleBusyId(null);
    }
  }

  async function addRegistrationRecord() {
    setRegError(null);
    try {
      await api.post("/v1/registration-records", {
        vehicleProfileId: id,
        recordType: regType,
        jurisdiction: regJurisdiction.trim() || undefined,
        renewalDueDateIso: regDueDate || undefined,
      });
      setRegJurisdiction("");
      setRegDueDate("");
      setAddingRegistration(false);
      await mutate();
    } catch (err) {
      setRegError(err instanceof ApiError ? err.message : "Couldn't add that record.");
    }
  }

  async function renewRegistrationRecord(recordId: string) {
    const newDueDateIso = window.prompt("New renewal due date (YYYY-MM-DD)?");
    if (!newDueDateIso) return;
    setRegBusyId(recordId);
    setRegError(null);
    try {
      await api.post(`/v1/registration-records/${recordId}/renew`, { newDueDateIso });
      await mutate();
    } catch (err) {
      setRegError(err instanceof ApiError ? err.message : "Couldn't renew that record.");
    } finally {
      setRegBusyId(null);
    }
  }

  async function deleteRegistrationRecord(recordId: string) {
    if (!window.confirm("Remove this registration record?")) return;
    setRegBusyId(recordId);
    try {
      await api.delete(`/v1/registration-records/${recordId}`);
      await mutate();
    } finally {
      setRegBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <Link href="/life" className="text-sm text-tertiary hover:text-primary">
        ← Back to Life
      </Link>
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-primary">{vehicle.label}</h1>
            {openRecallCount > 0 && <Badge tone="critical">{openRecallCount} recall{openRecallCount === 1 ? "" : "s"}</Badge>}
          </div>
          <p className="mt-1 text-sm text-tertiary">
            {subtitle}
            {subtitle && vehicle.vin ? " — " : ""}
            {vehicle.vin && `VIN ${vehicle.vin}`}
            {latestMileage != null && ` — ${latestMileage.toLocaleString()} mi`}
          </p>
          {vehicle.vinDecodeAttributes && (
            <p className="mt-1 text-xs text-tertiary">
              {[vehicle.vinDecodeAttributes.trim, vehicle.vinDecodeAttributes.bodyClass, vehicle.vinDecodeAttributes.fuelTypePrimary].filter(Boolean).join(" · ")}
              {" — decoded from VIN (NHTSA)"}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {vehicle.vin && (
            <Button variant="ghost" onClick={decodeVin} loading={decodingVin}>
              Decode VIN
            </Button>
          )}
          <Button variant="ghost" onClick={() => setSharing((s) => !s)}>
            Share
          </Button>
          <Button variant="secondary" onClick={remove} loading={deleting}>
            Remove
          </Button>
        </div>
      </header>
      {vinDecodeMessage && <p className="text-sm text-secondary">{vinDecodeMessage}</p>}
      {vinDecodeError && <p className="text-sm text-critical">{vinDecodeError}</p>}

      <SharedNoteBanner note={data.sharedNote} />

      <Card>
        <CardBody>
          <HouseholdAssignmentControl
            householdId={vehicle.householdId}
            onChange={async (next) => {
              await api.put(`/v1/vehicles/${id}`, { householdId: next });
              await mutate();
            }}
          />
        </CardBody>
      </Card>

      {sharing && (
        <Card>
          <CardBody>
            <ShareResourcePanel resourceId={String(id)} collectionPath="/v1/vehicles" resourceLabel="vehicle" />
          </CardBody>
        </Card>
      )}

      <Card>
        <CardBody className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wide text-tertiary">Recalls</p>
            <Button variant="ghost" onClick={checkRecalls} loading={checkingRecalls}>
              Check for recalls
            </Button>
          </div>
          {recalls.length === 0 && !checkingRecalls && (
            <p className="text-sm text-tertiary">
              No recalls found{vehicle.make && vehicle.model && vehicle.year ? " against NHTSA." : " yet — add a make, model, and year to check."}
            </p>
          )}
          {recalls.map((r) => (
            <div key={r.id} className="space-y-1.5 border-t border-border-subtle py-3 first:border-t-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-primary">{r.component ?? "Recall"}</span>
                <Badge tone={RECALL_STATUS_TONE[r.status]}>{RECALL_STATUS_LABEL[r.status]}</Badge>
              </div>
              <p className="text-sm text-secondary">{r.summary}</p>
              {r.remedy && <p className="text-xs text-tertiary">Remedy: {r.remedy}</p>}
              {r.url && (
                <a href={r.url} target="_blank" rel="noreferrer" className="text-xs text-brand hover:underline">
                  Full recall notice ↗
                </a>
              )}
              {r.status !== "closed_or_repaired" && (
                <div className="flex gap-2 pt-1">
                  {r.status === "potential_match_verify_vin" && (
                    <button onClick={() => confirmRecall(r.id)} className="text-xs font-medium text-brand hover:underline">
                      This affects my VIN
                    </button>
                  )}
                  <button onClick={() => resolveRecall(r.id)} className="text-xs font-medium text-tertiary hover:underline">
                    Mark repaired / not applicable
                  </button>
                </div>
              )}
            </div>
          ))}
          {recallError && <p className="text-sm text-critical">{recallError}</p>}
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
            <p className="text-xs font-medium uppercase tracking-wide text-tertiary">Odometer</p>
            {!addingOdometer && (
              <button onClick={() => setAddingOdometer(true)} className="text-sm font-medium text-brand hover:underline">
                + Add a reading
              </button>
            )}
          </div>
          {latestMileage != null ? (
            <p className="text-sm text-primary">{latestMileage.toLocaleString()} miles, last recorded {formatTemporal(odometerObservations[0]!.observedAt) ?? "recently"}</p>
          ) : (
            !addingOdometer && <p className="text-sm text-tertiary">No readings yet — mileage-based maintenance reminders need at least one.</p>
          )}
          {addingOdometer && (
            <div className="flex flex-wrap items-end gap-2 border-t border-border-subtle pt-3">
              <div className="w-40 shrink-0">
                <Input value={odometerReading} onChange={(e) => setOdometerReading(e.target.value)} placeholder="Current mileage" inputMode="numeric" />
              </div>
              <Button onClick={addOdometerReading} disabled={!odometerReading.trim()}>
                Save
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setAddingOdometer(false);
                  setOdometerReading("");
                  setOdometerError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          )}
          {odometerError && <p className="text-sm text-critical">{odometerError}</p>}
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wide text-tertiary">Tires</p>
            {!addingTire && (
              <button onClick={() => setAddingTire(true)} className="text-sm font-medium text-brand hover:underline">
                + Add tires
              </button>
            )}
          </div>
          {tires.length === 0 && !addingTire && <p className="text-sm text-tertiary">No tires on record yet.</p>}
          {tires.map((t) => {
            const label = [t.brand, t.model].filter(Boolean).join(" ") || "Tires";
            const install = formatTemporal(t.installDate);
            const replaced = formatTemporal(t.replacedAt);
            const expanded = expandedTireId === t.id;
            const busy = tireBusyId === t.id;
            return (
              <div key={t.id} className="border-t border-border-subtle py-2 text-sm first:border-t-0">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-primary">
                      {label}
                      {t.size && ` — ${t.size}`}
                    </p>
                    <p className="text-xs text-tertiary">
                      {t.status === "replaced" ? `Replaced${replaced ? ` ${replaced}` : ""}` : "Active"}
                      {install && ` — installed ${install}`}
                      {t.installMileage != null && ` at ${t.installMileage.toLocaleString()} mi`}
                    </p>
                    <p className="text-xs text-tertiary">
                      {t.pressureSpecPsi != null && `Spec ${t.pressureSpecPsi} PSI`}
                      {t.warrantyMonths != null && `${t.pressureSpecPsi != null ? " — " : ""}${t.warrantyMonths}mo warranty`}
                      {t.roadHazardWarranty && `${t.pressureSpecPsi != null || t.warrantyMonths != null ? " — " : ""}Road hazard: ${t.roadHazardWarranty}`}
                    </p>
                  </div>
                  {t.status === "active" && (
                    <div className="flex shrink-0 gap-3">
                      <button onClick={() => rotateTire(t.id)} disabled={busy} className="text-xs font-medium text-brand hover:underline disabled:opacity-50">
                        Log rotation
                      </button>
                      <button onClick={() => replaceTire(t.id)} disabled={busy} className="text-xs font-medium text-critical hover:underline disabled:opacity-50">
                        Replace
                      </button>
                    </div>
                  )}
                </div>
                {t.rotationHistory.length > 0 && (
                  <div className="mt-1">
                    <button
                      onClick={() => setExpandedTireId(expanded ? null : t.id)}
                      className="text-xs font-medium text-tertiary hover:underline"
                    >
                      {expanded ? "Hide" : "Show"} rotation history ({t.rotationHistory.length})
                    </button>
                    {expanded && (
                      <ul className="mt-1.5 space-y-1 border-l border-border-subtle pl-3">
                        {t.rotationHistory
                          .slice()
                          .reverse()
                          .map((r, i) => (
                            <li key={i} className="text-xs text-tertiary">
                              {r.date}
                              {r.mileage != null && ` — ${r.mileage.toLocaleString()} mi`}
                            </li>
                          ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {addingTire && (
            <div className="space-y-3 border-t border-border-subtle pt-3">
              <div className="flex flex-wrap items-end gap-2">
                <Input value={tireBrand} onChange={(e) => setTireBrand(e.target.value)} placeholder="Brand" className="min-w-[140px] flex-1" />
                <Input value={tireModel} onChange={(e) => setTireModel(e.target.value)} placeholder="Model" className="min-w-[140px] flex-1" />
                <div className="w-32 shrink-0">
                  <Input value={tireSize} onChange={(e) => setTireSize(e.target.value)} placeholder="Size" />
                </div>
              </div>
              <div className="flex flex-wrap items-start gap-2">
                <div className="w-40 shrink-0">
                  <Input type="date" value={tireInstallDate} onChange={(e) => setTireInstallDate(e.target.value)} aria-label="Install date" />
                </div>
                <div className="w-36 shrink-0">
                  <Input
                    value={tireInstallMileage}
                    onChange={(e) => setTireInstallMileage(e.target.value)}
                    placeholder="Install mileage"
                    inputMode="numeric"
                    error={tireFieldErrors.installMileage}
                  />
                  <FieldError>{tireFieldErrors.installMileage}</FieldError>
                </div>
                <div className="w-36 shrink-0">
                  <Input
                    value={tirePressure}
                    onChange={(e) => setTirePressure(e.target.value)}
                    placeholder="Pressure spec (PSI)"
                    inputMode="numeric"
                    error={tireFieldErrors.pressureSpecPsi}
                  />
                  <FieldError>{tireFieldErrors.pressureSpecPsi}</FieldError>
                </div>
                <div className="w-40 shrink-0">
                  <Input
                    value={tireWarrantyMonths}
                    onChange={(e) => setTireWarrantyMonths(e.target.value)}
                    placeholder="Warranty (months)"
                    inputMode="numeric"
                    error={tireFieldErrors.warrantyMonths}
                  />
                  <FieldError>{tireFieldErrors.warrantyMonths}</FieldError>
                </div>
              </div>
              <Switch
                id="tire-road-hazard"
                checked={tireHasRoadHazard}
                onCheckedChange={(checked) => {
                  setTireHasRoadHazard(checked);
                  if (!checked) setTireRoadHazardDetail("");
                }}
                label="Road hazard warranty"
                description="Covers this tire against punctures/damage beyond the manufacturer's defect warranty."
              />
              {tireHasRoadHazard && (
                <Input
                  value={tireRoadHazardDetail}
                  onChange={(e) => setTireRoadHazardDetail(e.target.value)}
                  placeholder="Provider / terms (optional)"
                />
              )}
              <div className="flex gap-2">
                <Button onClick={addTire}>Add</Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setAddingTire(false);
                    setTireBrand("");
                    setTireModel("");
                    setTireSize("");
                    setTireInstallDate("");
                    setTireInstallMileage("");
                    setTirePressure("");
                    setTireWarrantyMonths("");
                    setTireHasRoadHazard(false);
                    setTireRoadHazardDetail("");
                    setTireError(null);
                    setTireFieldErrors({});
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {tireError && <p className="text-sm text-critical">{tireError}</p>}
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wide text-tertiary">Maintenance schedule</p>
            {!addingRule && (
              <button
                onClick={() => {
                  setAddingRule(true);
                  void loadRuleTemplates();
                }}
                className="text-sm font-medium text-brand hover:underline"
              >
                + Add a rule
              </button>
            )}
          </div>
          {data.maintenanceRules.length === 0 && !addingRule && <p className="text-sm text-tertiary">No maintenance rules set up yet.</p>}
          {data.maintenanceRules.map((r) => {
            const last = formatTemporal(r.lastPerformedDate);
            const busy = ruleBusyId === r.id;
            return (
              <div key={r.id} className="space-y-1 border-t border-border-subtle py-2 text-sm first:border-t-0">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-primary">{r.label}</p>
                    <p className="text-xs text-tertiary">
                      {INTERVAL_LABEL[r.intervalType](r)}
                      {last && ` — last done ${last}`}
                    </p>
                    {r.source === "seeded_generic_guidance" && r.confidenceNote && <p className="text-xs text-tertiary italic">{r.confidenceNote}</p>}
                  </div>
                  <div className="flex shrink-0 gap-3">
                    <button onClick={() => completeRule(r.id)} disabled={busy} className="text-xs font-medium text-brand hover:underline disabled:opacity-50">
                      Mark done
                    </button>
                    <button onClick={() => deleteRule(r.id)} disabled={busy} className="text-xs font-medium text-tertiary hover:underline disabled:opacity-50">
                      Remove
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
          {addingRule && (
            <div className="space-y-3 border-t border-border-subtle pt-3">
              {ruleTemplates && ruleTemplates.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-tertiary">Suggested (general guidance, not manufacturer-specific):</p>
                  <div className="flex flex-wrap gap-2">
                    {ruleTemplates.map((t) => (
                      <button
                        key={t.key}
                        onClick={() => addRuleFromTemplate(t.key)}
                        title={t.confidenceNote}
                        className="rounded-full border border-border-subtle px-3 py-1 text-xs font-medium text-secondary hover:border-brand hover:text-brand"
                      >
                        + {t.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <p className="text-xs font-medium text-tertiary">Or add your own:</p>
              <div className="flex flex-wrap items-end gap-2">
                <Input value={ruleLabel} onChange={(e) => setRuleLabel(e.target.value)} placeholder="e.g. Brake pads" className="min-w-[160px] flex-1" />
                <select
                  value={ruleIntervalType}
                  onChange={(e) => setRuleIntervalType(e.target.value as MaintenanceRule["intervalType"])}
                  className="h-10 rounded-lg border border-border-subtle bg-transparent px-2 text-sm text-primary"
                >
                  <option value="calendar">By time</option>
                  <option value="mileage">By mileage</option>
                  <option value="calendar_or_mileage">Whichever first</option>
                </select>
                {ruleIntervalType !== "mileage" && (
                  <div className="w-32 shrink-0">
                    <Input value={ruleIntervalDays} onChange={(e) => setRuleIntervalDays(e.target.value)} placeholder="Days" inputMode="numeric" />
                  </div>
                )}
                {ruleIntervalType !== "calendar" && (
                  <div className="w-32 shrink-0">
                    <Input value={ruleIntervalMiles} onChange={(e) => setRuleIntervalMiles(e.target.value)} placeholder="Miles" inputMode="numeric" />
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <Button onClick={addCustomRule} disabled={!ruleLabel.trim()}>
                  Add
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setAddingRule(false);
                    setRuleLabel("");
                    setRuleIntervalDays("");
                    setRuleIntervalMiles("");
                    setRuleError(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {ruleError && <p className="text-sm text-critical">{ruleError}</p>}
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wide text-tertiary">Registration &amp; inspection</p>
            {!addingRegistration && (
              <button onClick={() => setAddingRegistration(true)} className="text-sm font-medium text-brand hover:underline">
                + Add a deadline
              </button>
            )}
          </div>
          {data.registrationRecords.length === 0 && !addingRegistration && <p className="text-sm text-tertiary">No registration or inspection deadlines tracked yet.</p>}
          {data.registrationRecords.map((r) => {
            const due = formatTemporal(r.renewalDueDate);
            const days = daysUntil(r.renewalDueDate);
            const busy = regBusyId === r.id;
            return (
              <div key={r.id} className="flex items-center justify-between border-t border-border-subtle py-2 text-sm first:border-t-0">
                <div>
                  <p className="text-primary">
                    {REGISTRATION_TYPE_LABEL[r.recordType]}
                    {r.jurisdiction && ` — ${r.jurisdiction}`}
                  </p>
                  {due && <p className="text-xs text-tertiary">Due {due}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {r.status === "expired" && <Badge tone="critical">Expired</Badge>}
                  {r.status === "active" && days != null && <Badge tone={days <= 14 ? "warning" : "neutral"}>{days}d left</Badge>}
                  <button onClick={() => renewRegistrationRecord(r.id)} disabled={busy} className="text-xs font-medium text-brand hover:underline disabled:opacity-50">
                    Renewed
                  </button>
                  <button onClick={() => deleteRegistrationRecord(r.id)} disabled={busy} className="text-xs font-medium text-tertiary hover:underline disabled:opacity-50">
                    Remove
                  </button>
                </div>
              </div>
            );
          })}
          {addingRegistration && (
            <div className="space-y-2 border-t border-border-subtle pt-3">
              <div className="flex flex-wrap items-end gap-2">
                <select
                  value={regType}
                  onChange={(e) => setRegType(e.target.value as RegistrationRecord["recordType"])}
                  className="h-10 rounded-lg border border-border-subtle bg-transparent px-2 text-sm text-primary"
                >
                  <option value="registration">Registration</option>
                  <option value="inspection">Inspection</option>
                  <option value="emissions">Emissions test</option>
                  <option value="other">Other</option>
                </select>
                <Input value={regJurisdiction} onChange={(e) => setRegJurisdiction(e.target.value)} placeholder="Jurisdiction (optional)" className="min-w-[140px] flex-1" />
                <div className="w-40 shrink-0">
                  <Input type="date" value={regDueDate} onChange={(e) => setRegDueDate(e.target.value)} aria-label="Due date" />
                </div>
              </div>
              <div className="flex gap-2">
                <Button onClick={addRegistrationRecord} disabled={!regDueDate}>
                  Add
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setAddingRegistration(false);
                    setRegJurisdiction("");
                    setRegDueDate("");
                    setRegError(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {regError && <p className="text-sm text-critical">{regError}</p>}
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
              <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Oil change" className="min-w-[180px] flex-1" />
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
