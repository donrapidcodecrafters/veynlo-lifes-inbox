import { useCallback, useState } from "react";
import { Pressable, Switch, Text, View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { TextField } from "@/components/text-field";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";
import { ShareResourcePanel } from "@/components/share-resource-panel";
import { FetchError } from "@/components/fetch-error";
import { HouseholdPicker } from "@/components/household-picker";
import { formatMoneyMinorUnits, formatTemporal, daysUntil, type TemporalValueLike } from "@/lib/format";

interface RecallMatch {
  id: string;
  campaignNumber: string;
  component: string | null;
  summary: string;
  remedy: string | null;
  url: string | null;
  status: "open" | "potential_match_verify_vin" | "closed_or_repaired";
}

interface OdometerObservation {
  id: string;
  mileage: number;
  observedAt: TemporalValueLike;
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
  maintenance: Array<{ id: string; description: string; serviceDate: TemporalValueLike; costMinorUnits: number | null; costCurrency: string | null }>;
  recalls: RecallMatch[];
  odometerObservations: OdometerObservation[];
  tires: Tire[];
  maintenanceRules: MaintenanceRule[];
  registrationRecords: RegistrationRecord[];
}

// Mirrors apps/web's identical lookup tables (life/vehicles/[id]/page.tsx) so the wording reads the same
// across platforms.
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

// VEH-006 — mirrors apps/web's identical vocabulary (vehicles/[id]/page.tsx) so a user moving between
// platforms reads the same wording.
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

export default function VehicleDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { theme } = useAppTheme();
  const [data, setData] = useState<VehicleDetail | null | undefined>(undefined);
  const [addingRecord, setAddingRecord] = useState(false);
  const [description, setDescription] = useState("");
  const [cost, setCost] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [checkingRecalls, setCheckingRecalls] = useState(false);
  const [addingOdometer, setAddingOdometer] = useState(false);
  const [odometerReading, setOdometerReading] = useState("");
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
  const [tireFieldErrors, setTireFieldErrors] = useState<Record<string, string>>({});
  const [tireSubmitting, setTireSubmitting] = useState(false);
  const [expandedTireId, setExpandedTireId] = useState<string | null>(null);
  const [tireBusyId, setTireBusyId] = useState<string | null>(null);
  // Inline confirm state, not RN's Alert.alert — matches this app's established destructive-confirm
  // convention (see list/[id].tsx's own doc comment on `confirmingDeleteList` for why: react-native-web's
  // Alert.alert is a permanent no-op, confirmed live). Only one tire's "Replace" can be confirming at a
  // time, mirroring list/[id].tsx's single `assigningItemId`.
  const [confirmingReplaceTireId, setConfirmingReplaceTireId] = useState<string | null>(null);
  // Inline confirm state for the destructive "Remove vehicle" action, same convention — mirrors
  // person/[id].tsx's identical `confirmingDelete` for its own "Remove person" action.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [decodingVin, setDecodingVin] = useState(false);
  const [vinDecodeMessage, setVinDecodeMessage] = useState<string | null>(null);
  const [vinDecodeError, setVinDecodeError] = useState<string | null>(null);
  const [ruleTemplates, setRuleTemplates] = useState<MaintenanceRuleTemplate[] | null>(null);
  const [addingRule, setAddingRule] = useState(false);
  const [ruleLabel, setRuleLabel] = useState("");
  const [ruleIntervalType, setRuleIntervalType] = useState<MaintenanceRule["intervalType"]>("calendar_or_mileage");
  const [ruleIntervalDays, setRuleIntervalDays] = useState("");
  const [ruleIntervalMiles, setRuleIntervalMiles] = useState("");
  const [ruleSubmitting, setRuleSubmitting] = useState(false);
  const [ruleBusyId, setRuleBusyId] = useState<string | null>(null);
  const [addingRegistration, setAddingRegistration] = useState(false);
  const [regType, setRegType] = useState<RegistrationRecord["recordType"]>("registration");
  const [regJurisdiction, setRegJurisdiction] = useState("");
  const [regDueDate, setRegDueDate] = useState("");
  const [regSubmitting, setRegSubmitting] = useState(false);
  const [regBusyId, setRegBusyId] = useState<string | null>(null);
  const [renewingId, setRenewingId] = useState<string | null>(null);
  const [renewDueDate, setRenewDueDate] = useState("");
  // A bare `.then`/`await` with no `.catch` on a mount-time fetch (or on the add-record/remove actions
  // below) becomes an unhandled promise rejection on any failure, which React Native Web surfaces as a
  // full-screen "Uncaught Error" dev overlay blocking the entire app, not just this screen (confirmed
  // live — see entity/[id].tsx's identical fix and doc comment). Unlike the other 8 detail screens in this
  // app, `GET /v1/vehicles/:id` responds with an actual 404 HTTP status for a missing/inaccessible vehicle
  // (assets.controller.ts throws NotFoundException) rather than a 200 with a `null` body — so a bogus id
  // here doesn't resolve `.then(setData)` with null the way e.g. bill/warranty/purchase detail do; it
  // *rejects*. Without catching that and mapping it back to `setData(null)`, the "Not found" branch below
  // was dead code and every bogus/forbidden vehicle id crashed the whole app instead (confirmed live via
  // Playwright). A genuine network/server error still surfaces as an inline message rather than a silent
  // infinite loading skeleton.
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api
      .get<VehicleDetail | null>(`/v1/vehicles/${id}`)
      .then(setData)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) {
          setData(null);
        } else {
          setError(err instanceof ApiError ? err.message : "Couldn't load this. Please try again.");
        }
      })
      .finally(() => setRetrying(false));
  }, [id]);

  useFocusEffect(load);

  async function addRecord() {
    if (!description.trim()) return;
    // `Math.round(Number("abc") * 100)` is NaN, and `JSON.stringify` silently turns NaN into `null` — the
    // record was saved with the cost quietly dropped and no error shown at all (confirmed live: typing
    // "abc" into Cost produced a record with no dollar amount, no warning). Validate client-side instead of
    // letting a typo through as silent data loss.
    const trimmedCost = cost.trim();
    const parsedCost = trimmedCost ? Number(trimmedCost) : null;
    if (trimmedCost && (Number.isNaN(parsedCost) || parsedCost! < 0)) {
      setActionError("Enter a valid, non-negative cost (e.g. 42.50), or leave it blank.");
      return;
    }
    setSubmitting(true);
    setActionError(null);
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
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't add this record. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function remove() {
    setDeleting(true);
    setActionError(null);
    try {
      await api.delete(`/v1/vehicles/${id}`);
      router.back();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't remove this vehicle. Please try again.");
    } finally {
      setDeleting(false);
    }
  }

  // Household-assignment gap close — mirrors person/[id].tsx's identical immediate-save private/household
  // toggle. `PUT /v1/vehicles/{id}` is the new edit endpoint; `null` explicitly means "make private again".
  async function saveHousehold(householdId: string | null) {
    await api.put(`/v1/vehicles/${id}`, { householdId });
    load();
  }

  async function checkRecalls() {
    setCheckingRecalls(true);
    setActionError(null);
    try {
      await api.post(`/v1/vehicles/${id}/check-recalls`, {});
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't check for recalls right now.");
    } finally {
      setCheckingRecalls(false);
    }
  }

  async function confirmRecall(recallId: string) {
    try {
      await api.post(`/v1/recall-matches/${recallId}/confirm`, {});
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't update that recall.");
    }
  }

  async function resolveRecall(recallId: string) {
    try {
      await api.post(`/v1/recall-matches/${recallId}/resolve`, {});
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't update that recall.");
    }
  }

  async function addOdometerReading() {
    const trimmed = odometerReading.trim();
    const mileage = trimmed ? Number(trimmed) : NaN;
    if (!trimmed || Number.isNaN(mileage) || mileage < 0) {
      setActionError("Enter a valid, non-negative mileage.");
      return;
    }
    try {
      await api.post("/v1/odometer-observations", { vehicleProfileId: id, mileage: Math.round(mileage), source: "user_entered" });
      setOdometerReading("");
      setAddingOdometer(false);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't save that reading.");
    }
  }

  // Mirrors the DTO's own bounds (CreateTireDtoSchema in services/api/src/modules/assets/dto.ts) so a bad
  // value is caught here, next to the field the user is looking at (TextField's own `error` prop), instead
  // of round-tripping to the server for a generic-banner rejection.
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

  function resetTireForm() {
    setTireBrand("");
    setTireModel("");
    setTireSize("");
    setTireInstallDate("");
    setTireInstallMileage("");
    setTirePressure("");
    setTireWarrantyMonths("");
    setTireHasRoadHazard(false);
    setTireRoadHazardDetail("");
    setTireFieldErrors({});
  }

  async function addTire() {
    const validationErrors = validateTireFields();
    if (validationErrors) {
      setTireFieldErrors(validationErrors);
      return;
    }
    setTireFieldErrors({});
    setTireSubmitting(true);
    setActionError(null);
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
      resetTireForm();
      setAddingTire(false);
      load();
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors) {
        setTireFieldErrors(Object.fromEntries(Object.entries(err.fieldErrors).map(([k, v]) => [k, v[0] ?? ""])));
      }
      setActionError(err instanceof ApiError ? err.message : "Couldn't add that tire. Please try again.");
    } finally {
      setTireSubmitting(false);
    }
  }

  async function rotateTire(tireId: string) {
    setActionError(null);
    setTireBusyId(tireId);
    try {
      await api.post(`/v1/tires/${tireId}/rotate`, { mileage: latestMileage ?? undefined });
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't log that rotation.");
    } finally {
      setTireBusyId(null);
    }
  }

  async function replaceTire(tireId: string) {
    setActionError(null);
    setTireBusyId(tireId);
    try {
      await api.post(`/v1/tires/${tireId}/replace`, {});
      setConfirmingReplaceTireId(null);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't replace that tire.");
    } finally {
      setTireBusyId(null);
    }
  }

  // VEH-001 "VIN decode may prefill public vehicle attributes; user confirms" — decodes the VIN already on
  // file and shows what, if anything, got filled in (empty fields only — see AssetsService.applyVinDecode).
  // Mirrors apps/web's vehicles/[id]/page.tsx decodeVin exactly.
  async function decodeVin() {
    setDecodingVin(true);
    setVinDecodeError(null);
    setVinDecodeMessage(null);
    try {
      const result = await api.post<{
        suggestion: { success: boolean; errorText: string | null; attributes: VinDecodeAttributes };
        applied: { make: boolean; model: boolean; year: boolean };
      }>(`/v1/vehicles/${id}/vin-decode`, {});
      if (!result.suggestion.success) {
        setVinDecodeError(result.suggestion.errorText ?? "Couldn't decode that VIN.");
      } else {
        const filled = (["make", "model", "year"] as const).filter((f) => result.applied[f]);
        setVinDecodeMessage(
          filled.length > 0 ? `Filled in ${filled.join(", ")} from the VIN. Review and correct anything that's wrong.` : "Decoded successfully — nothing new to fill in.",
        );
      }
      load();
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
    setActionError(null);
    try {
      await api.post("/v1/maintenance-rules/from-template", { vehicleProfileId: id, templateKey });
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't add that suggested rule.");
    }
  }

  function resetRuleForm() {
    setRuleLabel("");
    setRuleIntervalDays("");
    setRuleIntervalMiles("");
  }

  async function addCustomRule() {
    if (!ruleLabel.trim()) return;
    setActionError(null);
    setRuleSubmitting(true);
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
      resetRuleForm();
      setAddingRule(false);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't add that maintenance rule.");
    } finally {
      setRuleSubmitting(false);
    }
  }

  async function completeRule(ruleId: string) {
    setRuleBusyId(ruleId);
    setActionError(null);
    try {
      // For a vehicle rule, pass the vehicle's current latest odometer reading if known, same as apps/web.
      await api.post(`/v1/maintenance-rules/${ruleId}/complete`, { performedMileage: latestMileage ?? undefined });
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't mark that done.");
    } finally {
      setRuleBusyId(null);
    }
  }

  async function deleteRule(ruleId: string) {
    setRuleBusyId(ruleId);
    setActionError(null);
    try {
      await api.delete(`/v1/maintenance-rules/${ruleId}`);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't remove that rule.");
    } finally {
      setRuleBusyId(null);
    }
  }

  async function addRegistrationRecord() {
    setActionError(null);
    setRegSubmitting(true);
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
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't add that record.");
    } finally {
      setRegSubmitting(false);
    }
  }

  // No `window.prompt` on React Native — an inline text field + confirm button takes its place (matching
  // this app's established inline-instead-of-Alert convention; see list/[id].tsx's doc comment on why
  // react-native-web's Alert is a permanent no-op).
  function startRenew(recordId: string) {
    setRenewingId(recordId);
    setRenewDueDate("");
    setActionError(null);
  }

  async function confirmRenew(recordId: string) {
    if (!renewDueDate.trim()) return;
    setRegBusyId(recordId);
    setActionError(null);
    try {
      await api.post(`/v1/registration-records/${recordId}/renew`, { newDueDateIso: renewDueDate.trim() });
      setRenewingId(null);
      setRenewDueDate("");
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't renew that record.");
    } finally {
      setRegBusyId(null);
    }
  }

  async function deleteRegistrationRecord(recordId: string) {
    setRegBusyId(recordId);
    setActionError(null);
    try {
      await api.delete(`/v1/registration-records/${recordId}`);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't remove that record.");
    } finally {
      setRegBusyId(null);
    }
  }

  // Guarded on `data === undefined` (not just `error` alone) so a refetch that fails after this screen
  // already loaded successfully once — `load` reruns on every `useFocusEffect`, e.g. navigating back into
  // this screen — doesn't blow away the already-loaded vehicle view. Mirrors trip/[id].tsx's identical
  // guard.
  if (error && data === undefined) {
    return (
      <Screen>
        <ScreenHeader title="Something went wrong" />
        <FetchError
          message={error}
          what="this vehicle"
          retrying={retrying}
          onRetry={() => {
            setRetrying(true);
            load();
          }}
        />
      </Screen>
    );
  }
  if (data === undefined) {
    return (
      <Screen>
        <View style={{ height: 120, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />
      </Screen>
    );
  }
  if (!data) {
    return (
      <Screen>
        <ScreenHeader title="Not found" />
        <EmptyState title="Not found" description="This vehicle doesn't exist or you don't have access to it." />
      </Screen>
    );
  }

  const { vehicle, warranties, maintenance, recalls, odometerObservations, tires } = data;
  const subtitle = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ");
  const openRecallCount = recalls.filter((r) => r.status !== "closed_or_repaired").length;
  const latestMileage = odometerObservations[0]?.mileage ?? null;

  // A row of chip-style buttons for a small enum choice, matching this app's established alternative to a
  // native `<select>` (see inbox.tsx's identical `Chip` inside `AddToCalendarForm`).
  function Chip({ selected, label, onPress }: { selected: boolean; label: string; onPress: () => void }) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected }}
        onPress={onPress}
        style={{
          paddingHorizontal: 10,
          paddingVertical: 6,
          borderRadius: theme.radius.md,
          borderWidth: 1,
          borderColor: selected ? theme.colors.brandDefault : theme.colors.borderDefault,
          backgroundColor: selected ? theme.colors.brandDefault : "transparent",
        }}
      >
        <Text style={{ fontSize: 12, fontWeight: "600", color: selected ? theme.colors.textOnBrand : theme.colors.textPrimary }}>{label}</Text>
      </Pressable>
    );
  }

  return (
    <Screen>
      <ScreenHeader
        title={openRecallCount > 0 ? `${vehicle.label} ⚠` : vehicle.label}
        subtitle={[subtitle, vehicle.vin ? `VIN ${vehicle.vin}` : null, latestMileage != null ? `${latestMileage.toLocaleString()} mi` : null].filter(Boolean).join(" — ")}
      />
      {vehicle.vinDecodeAttributes && (
        <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
          {[vehicle.vinDecodeAttributes.trim, vehicle.vinDecodeAttributes.bodyClass, vehicle.vinDecodeAttributes.fuelTypePrimary].filter(Boolean).join(" · ")}
          {" — decoded from VIN (NHTSA)"}
        </Text>
      )}

      {/* This screen has five separate action handlers (recall check/confirm/resolve, add odometer
          reading, add maintenance record, remove vehicle) that all funnel into this one shared
          `actionError` state, but the error text used to render only once, right before the "Remove
          vehicle" button at the very bottom of a long, scrollable page — confirmed live: typing "abc"
          into the Odometer form's mileage field and tapping Save left the error message a full screen-or-
          more of scrolling below the field the user was actually looking at (past Tires and Maintenance
          history), easy to miss entirely. Shown immediately below the header instead, matching
          automations.tsx's own top-of-screen placement for its equally multi-action `actionError`. */}
      {actionError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{actionError}</Text>}
      {vinDecodeMessage && <Text style={{ fontSize: 13, color: theme.colors.textSecondary }}>{vinDecodeMessage}</Text>}
      {vinDecodeError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{vinDecodeError}</Text>}

      {/* Phase 2 §52.2 "object sharing" — mirrors apps/web's vehicles/[id]/page.tsx. VehicleDetail's
          payload carries no owner id, so (matching documents.tsx's own precedent) the button is always
          shown and the backend's 403 on a non-owner's grant/link attempt does the gating. */}
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
        {/* VEH-001 — decodes the VIN already on file; only shown once there's a VIN to decode. */}
        {vehicle.vin && (
          <Button variant="ghost" onPress={decodeVin} loading={decodingVin}>
            Decode VIN
          </Button>
        )}
        <Button variant="ghost" onPress={() => setSharing((s) => !s)}>
          Share
        </Button>
      </View>
      {sharing && (
        <Card>
          <ShareResourcePanel resourceId={String(id)} collectionPath="/v1/vehicles" resourceLabel="vehicle" />
        </Card>
      )}

      <HouseholdPicker mode="edit" value={vehicle.householdId} onSave={saveHousehold} />

      <Card style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>
            Recalls{openRecallCount > 0 ? ` (${openRecallCount})` : ""}
          </Text>
          <Button variant="ghost" onPress={checkRecalls} loading={checkingRecalls}>
            Check
          </Button>
        </View>
        {recalls.length === 0 && !checkingRecalls && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>No recalls found.</Text>}
        {recalls.map((r) => (
          <View key={r.id} style={{ gap: 4, paddingVertical: 6, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textPrimary, flex: 1 }}>{r.component ?? "Recall"}</Text>
              <Badge tone={RECALL_STATUS_TONE[r.status]}>{RECALL_STATUS_LABEL[r.status]}</Badge>
            </View>
            <Text style={{ fontSize: 12, color: theme.colors.textSecondary }}>{r.summary}</Text>
            {r.status !== "closed_or_repaired" && (
              <View style={{ flexDirection: "row", gap: 12 }}>
                {r.status === "potential_match_verify_vin" && (
                  <Pressable accessibilityRole="button" onPress={() => confirmRecall(r.id)}>
                    <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.brandDefault }}>This affects my VIN</Text>
                  </Pressable>
                )}
                <Pressable accessibilityRole="button" onPress={() => resolveRecall(r.id)}>
                  <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.textTertiary }}>Mark repaired</Text>
                </Pressable>
              </View>
            )}
          </View>
        ))}
      </Card>

      <Card style={{ gap: 6 }}>
        <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Warranties</Text>
        {warranties.length === 0 && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>None linked yet.</Text>}
        {warranties.map((w) => {
          const days = daysUntil(w.expirationDate);
          return (
            <Pressable accessibilityRole="button"
              key={w.id}
              onPress={() => router.push(`/warranty/${w.id}`)}
              style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 4 }}
            >
              <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>{w.productLabel}</Text>
              {days != null && <Badge tone={days <= 30 ? "warning" : "neutral"}>{days > 0 ? `${days}d left` : "Expired"}</Badge>}
            </Pressable>
          );
        })}
      </Card>

      <Card style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Odometer</Text>
          {!addingOdometer && (
            <Pressable accessibilityRole="button" onPress={() => setAddingOdometer(true)}>
              <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }}>+ Add reading</Text>
            </Pressable>
          )}
        </View>
        {latestMileage != null ? (
          <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>
            {latestMileage.toLocaleString()} miles, last recorded {formatTemporal(odometerObservations[0]!.observedAt) ?? "recently"}
          </Text>
        ) : (
          !addingOdometer && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>No readings yet.</Text>
        )}
        {addingOdometer && (
          <View style={{ gap: 8 }}>
            <TextField label="Current mileage" value={odometerReading} onChangeText={setOdometerReading} keyboardType="number-pad" />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Button onPress={addOdometerReading} disabled={!odometerReading.trim()}>
                  Save
                </Button>
              </View>
              <View style={{ flex: 1 }}>
                <Button variant="secondary" onPress={() => setAddingOdometer(false)}>
                  Cancel
                </Button>
              </View>
            </View>
          </View>
        )}
      </Card>

      <Card style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Tires</Text>
          {!addingTire && (
            <Pressable accessibilityRole="button" onPress={() => setAddingTire(true)}>
              <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }}>+ Add tires</Text>
            </Pressable>
          )}
        </View>
        {tires.length === 0 && !addingTire && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>No tires on record yet.</Text>}
        {tires.map((t) => {
          const label = [t.brand, t.model].filter(Boolean).join(" ") || "Tires";
          const install = formatTemporal(t.installDate);
          const replaced = formatTemporal(t.replacedAt);
          const expanded = expandedTireId === t.id;
          const busy = tireBusyId === t.id;
          return (
            <View key={t.id} style={{ paddingVertical: 6, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>
                    {label}
                    {t.size && ` — ${t.size}`}
                  </Text>
                  <Text style={{ fontSize: 11, color: theme.colors.textTertiary }}>
                    {t.status === "replaced" ? `Replaced${replaced ? ` ${replaced}` : ""}` : "Active"}
                    {install && ` — installed ${install}`}
                    {t.installMileage != null && ` at ${t.installMileage.toLocaleString()} mi`}
                  </Text>
                  {(t.pressureSpecPsi != null || t.warrantyMonths != null || t.roadHazardWarranty) && (
                    <Text style={{ fontSize: 11, color: theme.colors.textTertiary }}>
                      {t.pressureSpecPsi != null && `Spec ${t.pressureSpecPsi} PSI`}
                      {t.warrantyMonths != null && `${t.pressureSpecPsi != null ? " — " : ""}${t.warrantyMonths}mo warranty`}
                      {t.roadHazardWarranty && `${t.pressureSpecPsi != null || t.warrantyMonths != null ? " — " : ""}Road hazard: ${t.roadHazardWarranty}`}
                    </Text>
                  )}
                </View>
                {t.status === "active" && confirmingReplaceTireId !== t.id && (
                  <View style={{ flexDirection: "row", gap: 12 }}>
                    <Pressable accessibilityRole="button" onPress={() => rotateTire(t.id)} disabled={busy}>
                      <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.brandDefault, opacity: busy ? 0.5 : 1 }}>Rotate</Text>
                    </Pressable>
                    <Pressable accessibilityRole="button" onPress={() => setConfirmingReplaceTireId(t.id)} disabled={busy}>
                      <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.critical, opacity: busy ? 0.5 : 1 }}>Replace</Text>
                    </Pressable>
                  </View>
                )}
              </View>
              {confirmingReplaceTireId === t.id && (
                <View style={{ marginTop: 6, backgroundColor: theme.colors.criticalSubtleBg, borderRadius: theme.radius.md, padding: 12, gap: 8 }}>
                  <Text style={{ fontSize: 12, color: theme.colors.criticalSubtleText }}>Mark {label} as replaced? This can&apos;t be undone.</Text>
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <Button variant="critical" onPress={() => replaceTire(t.id)} loading={busy}>
                        Confirm replace
                      </Button>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Button variant="secondary" onPress={() => setConfirmingReplaceTireId(null)}>
                        Cancel
                      </Button>
                    </View>
                  </View>
                </View>
              )}
              {t.rotationHistory.length > 0 && (
                <View style={{ marginTop: 4 }}>
                  <Pressable accessibilityRole="button" onPress={() => setExpandedTireId(expanded ? null : t.id)}>
                    <Text style={{ fontSize: 11, fontWeight: "600", color: theme.colors.textTertiary }}>
                      {expanded ? "Hide" : "Show"} rotation history ({t.rotationHistory.length})
                    </Text>
                  </Pressable>
                  {expanded && (
                    <View style={{ marginTop: 4, gap: 2, borderLeftWidth: 1, borderLeftColor: theme.colors.borderSubtle, paddingLeft: 8 }}>
                      {t.rotationHistory
                        .slice()
                        .reverse()
                        .map((r, i) => (
                          <Text key={i} style={{ fontSize: 11, color: theme.colors.textTertiary }}>
                            {r.date}
                            {r.mileage != null && ` — ${r.mileage.toLocaleString()} mi`}
                          </Text>
                        ))}
                    </View>
                  )}
                </View>
              )}
            </View>
          );
        })}
        {addingTire && (
          <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, paddingTop: 8 }}>
            <TextField label="Brand" value={tireBrand} onChangeText={setTireBrand} />
            <TextField label="Model" value={tireModel} onChangeText={setTireModel} />
            <TextField label="Size" placeholder="e.g. 225/45R17" value={tireSize} onChangeText={setTireSize} />
            <TextField label="Install date (optional, YYYY-MM-DD)" value={tireInstallDate} onChangeText={setTireInstallDate} />
            <TextField
              label="Install mileage (optional)"
              value={tireInstallMileage}
              onChangeText={setTireInstallMileage}
              keyboardType="number-pad"
              error={tireFieldErrors.installMileage}
            />
            <TextField
              label="Pressure spec, PSI (optional)"
              value={tirePressure}
              onChangeText={setTirePressure}
              keyboardType="number-pad"
              error={tireFieldErrors.pressureSpecPsi}
            />
            <TextField
              label="Warranty, months (optional)"
              value={tireWarrantyMonths}
              onChangeText={setTireWarrantyMonths}
              keyboardType="number-pad"
              error={tireFieldErrors.warrantyMonths}
            />
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textSecondary }}>Road hazard warranty</Text>
              {/* trackColor/activeThumbColor set on every Switch in this app so RNW's default teal
                  doesn't clash with the brand purple — see place/[id].tsx's identical fix and doc
                  comment for the confirmed-live getComputedStyle diagnosis. */}
              <Switch
                value={tireHasRoadHazard}
                onValueChange={(v) => {
                  setTireHasRoadHazard(v);
                  if (!v) setTireRoadHazardDetail("");
                }}
                accessibilityLabel="Road hazard warranty"
                trackColor={{ false: theme.colors.borderDefault, true: theme.colors.brandDefault }}
                {...({ activeThumbColor: theme.colors.textOnBrand } as Record<string, string>)}
              />
            </View>
            {tireHasRoadHazard && (
              <TextField label="Provider / terms (optional)" value={tireRoadHazardDetail} onChangeText={setTireRoadHazardDetail} />
            )}
            <View style={{ flexDirection: "row", gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Button onPress={addTire} loading={tireSubmitting}>
                  Add
                </Button>
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  variant="secondary"
                  onPress={() => {
                    setAddingTire(false);
                    resetTireForm();
                  }}
                >
                  Cancel
                </Button>
              </View>
            </View>
          </View>
        )}
      </Card>

      <Card style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Maintenance schedule</Text>
          {!addingRule && (
            <Pressable accessibilityRole="button"
              onPress={() => {
                setAddingRule(true);
                loadRuleTemplates();
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }}>+ Add a rule</Text>
            </Pressable>
          )}
        </View>
        {data.maintenanceRules.length === 0 && !addingRule && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>No maintenance rules set up yet.</Text>}
        {data.maintenanceRules.map((r) => {
          const last = formatTemporal(r.lastPerformedDate);
          const busy = ruleBusyId === r.id;
          return (
            <View key={r.id} style={{ paddingVertical: 6, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>{r.label}</Text>
                  <Text style={{ fontSize: 11, color: theme.colors.textTertiary }}>
                    {INTERVAL_LABEL[r.intervalType](r)}
                    {last && ` — last done ${last}`}
                  </Text>
                  {/* Never presented as manufacturer-specific fact — see AssetsService's seeded templates. */}
                  {r.source === "seeded_generic_guidance" && r.confidenceNote && (
                    <Text style={{ fontSize: 11, color: theme.colors.textTertiary, fontStyle: "italic" }}>{r.confidenceNote}</Text>
                  )}
                </View>
                <View style={{ flexDirection: "row", gap: 12 }}>
                  <Pressable accessibilityRole="button" onPress={() => completeRule(r.id)} disabled={busy}>
                    <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.brandDefault, opacity: busy ? 0.5 : 1 }}>Mark done</Text>
                  </Pressable>
                  <Pressable accessibilityRole="button" onPress={() => deleteRule(r.id)} disabled={busy}>
                    <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.textTertiary, opacity: busy ? 0.5 : 1 }}>Remove</Text>
                  </Pressable>
                </View>
              </View>
            </View>
          );
        })}
        {addingRule && (
          <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, paddingTop: 8 }}>
            {ruleTemplates && ruleTemplates.length > 0 && (
              <View style={{ gap: 6 }}>
                <Text style={{ fontSize: 11, fontWeight: "600", color: theme.colors.textTertiary }}>
                  SUGGESTED (general guidance, not manufacturer-specific)
                </Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {ruleTemplates.map((t) => (
                    <Pressable accessibilityRole="button"
                      key={t.key}
                      onPress={() => addRuleFromTemplate(t.key)}
                      style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: theme.radius.md, borderWidth: 1, borderColor: theme.colors.borderDefault }}
                    >
                      <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.textPrimary }}>+ {t.label}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            )}
            <Text style={{ fontSize: 11, fontWeight: "600", color: theme.colors.textTertiary }}>OR ADD YOUR OWN</Text>
            <TextField label="Label" placeholder="e.g. Brake pads" value={ruleLabel} onChangeText={setRuleLabel} />
            <View style={{ flexDirection: "row", gap: 6 }}>
              <Chip selected={ruleIntervalType === "calendar"} label="By time" onPress={() => setRuleIntervalType("calendar")} />
              <Chip selected={ruleIntervalType === "mileage"} label="By mileage" onPress={() => setRuleIntervalType("mileage")} />
              <Chip selected={ruleIntervalType === "calendar_or_mileage"} label="Whichever first" onPress={() => setRuleIntervalType("calendar_or_mileage")} />
            </View>
            {ruleIntervalType !== "mileage" && <TextField label="Days" value={ruleIntervalDays} onChangeText={setRuleIntervalDays} keyboardType="number-pad" />}
            {ruleIntervalType !== "calendar" && <TextField label="Miles" value={ruleIntervalMiles} onChangeText={setRuleIntervalMiles} keyboardType="number-pad" />}
            <View style={{ flexDirection: "row", gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Button onPress={addCustomRule} loading={ruleSubmitting} disabled={!ruleLabel.trim()}>
                  Add
                </Button>
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  variant="secondary"
                  onPress={() => {
                    setAddingRule(false);
                    resetRuleForm();
                  }}
                >
                  Cancel
                </Button>
              </View>
            </View>
          </View>
        )}
      </Card>

      <Card style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Registration &amp; inspection</Text>
          {!addingRegistration && (
            <Pressable accessibilityRole="button" onPress={() => setAddingRegistration(true)}>
              <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }}>+ Add a deadline</Text>
            </Pressable>
          )}
        </View>
        {data.registrationRecords.length === 0 && !addingRegistration && (
          <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>No registration or inspection deadlines tracked yet.</Text>
        )}
        {data.registrationRecords.map((r) => {
          const due = formatTemporal(r.renewalDueDate);
          const days = daysUntil(r.renewalDueDate);
          const busy = regBusyId === r.id;
          const renewing = renewingId === r.id;
          return (
            <View key={r.id} style={{ gap: 6, paddingVertical: 6, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>
                    {REGISTRATION_TYPE_LABEL[r.recordType]}
                    {r.jurisdiction && ` — ${r.jurisdiction}`}
                  </Text>
                  {due && <Text style={{ fontSize: 11, color: theme.colors.textTertiary }}>Due {due}</Text>}
                </View>
                {r.status === "expired" && <Badge tone="critical">Expired</Badge>}
                {r.status === "active" && days != null && <Badge tone={days <= 14 ? "warning" : "neutral"}>{`${days}d left`}</Badge>}
              </View>
              {renewing ? (
                <View style={{ gap: 6 }}>
                  <TextField label="New due date (YYYY-MM-DD)" value={renewDueDate} onChangeText={setRenewDueDate} />
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <View style={{ flex: 1 }}>
                      <Button onPress={() => confirmRenew(r.id)} loading={busy} disabled={!renewDueDate.trim()}>
                        Confirm
                      </Button>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Button variant="secondary" onPress={() => setRenewingId(null)}>
                        Cancel
                      </Button>
                    </View>
                  </View>
                </View>
              ) : (
                <View style={{ flexDirection: "row", gap: 12 }}>
                  <Pressable accessibilityRole="button" onPress={() => startRenew(r.id)} disabled={busy}>
                    <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.brandDefault, opacity: busy ? 0.5 : 1 }}>Renewed</Text>
                  </Pressable>
                  <Pressable accessibilityRole="button" onPress={() => deleteRegistrationRecord(r.id)} disabled={busy}>
                    <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.textTertiary, opacity: busy ? 0.5 : 1 }}>Remove</Text>
                  </Pressable>
                </View>
              )}
            </View>
          );
        })}
        {addingRegistration && (
          <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, paddingTop: 8 }}>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              <Chip selected={regType === "registration"} label="Registration" onPress={() => setRegType("registration")} />
              <Chip selected={regType === "inspection"} label="Inspection" onPress={() => setRegType("inspection")} />
              <Chip selected={regType === "emissions"} label="Emissions test" onPress={() => setRegType("emissions")} />
              <Chip selected={regType === "other"} label="Other" onPress={() => setRegType("other")} />
            </View>
            <TextField label="Jurisdiction (optional)" value={regJurisdiction} onChangeText={setRegJurisdiction} />
            <TextField label="Due date (YYYY-MM-DD)" value={regDueDate} onChangeText={setRegDueDate} />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Button onPress={addRegistrationRecord} loading={regSubmitting} disabled={!regDueDate.trim()}>
                  Add
                </Button>
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  variant="secondary"
                  onPress={() => {
                    setAddingRegistration(false);
                    setRegJurisdiction("");
                    setRegDueDate("");
                  }}
                >
                  Cancel
                </Button>
              </View>
            </View>
          </View>
        )}
      </Card>

      <Card style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Maintenance history</Text>
          {!addingRecord && (
            <Pressable accessibilityRole="button" onPress={() => setAddingRecord(true)}>
              <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }}>+ Add a record</Text>
            </Pressable>
          )}
        </View>
        {maintenance.length === 0 && !addingRecord && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>No service history logged yet.</Text>}
        {maintenance.map((m) => {
          const date = formatTemporal(m.serviceDate);
          const amount = formatMoneyMinorUnits(m.costMinorUnits, m.costCurrency);
          return (
            <View key={m.id} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 }}>
              <View>
                <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>{m.description}</Text>
                {date && <Text style={{ fontSize: 11, color: theme.colors.textTertiary }}>{date}</Text>}
              </View>
              {amount && <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>{amount}</Text>}
            </View>
          );
        })}
        {addingRecord && (
          <View style={{ gap: 8 }}>
            <TextField label="Description" placeholder="e.g. Oil change" value={description} onChangeText={setDescription} />
            <TextField label="Cost (USD, optional)" value={cost} onChangeText={setCost} keyboardType="decimal-pad" />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Button onPress={addRecord} loading={submitting} disabled={!description.trim()}>
                  Add
                </Button>
              </View>
              <View style={{ flex: 1 }}>
                <Button variant="secondary" onPress={() => setAddingRecord(false)}>
                  Cancel
                </Button>
              </View>
            </View>
          </View>
        )}
      </Card>

      {!confirmingDelete ? (
        <Button variant="secondary" onPress={() => setConfirmingDelete(true)}>
          Remove vehicle
        </Button>
      ) : (
        <View style={{ backgroundColor: theme.colors.criticalSubtleBg, borderRadius: theme.radius.md, padding: 12, gap: 8 }}>
          <Text style={{ fontSize: 13, color: theme.colors.criticalSubtleText }}>
            This removes {vehicle.label} and its tires, recalls, and maintenance history. It can&apos;t be undone.
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button variant="critical" onPress={remove} loading={deleting}>
                Confirm remove
              </Button>
            </View>
            <View style={{ flex: 1 }}>
              <Button variant="secondary" onPress={() => setConfirmingDelete(false)}>
                Cancel
              </Button>
            </View>
          </View>
        </View>
      )}
    </Screen>
  );
}
