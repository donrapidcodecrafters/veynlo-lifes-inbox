import { useCallback, useEffect, useState } from "react";
import { Pressable, RefreshControl, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import type { RecurrenceRule } from "@veynlo/core";
import { api, ApiError } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { FetchError } from "@/components/fetch-error";
import { ScreenHeader } from "@/components/screen-header";
import { TextField } from "@/components/text-field";
import { RecurrencePicker } from "@/components/recurrence-picker";
import { describeRecurrence } from "@/lib/recurrence-description";
import { formatMoneyMinorUnits, formatTemporal, daysUntil, type TemporalValueLike } from "@/lib/format";
import { ShareResourcePanel } from "@/components/share-resource-panel";
import { HouseholdPicker } from "@/components/household-picker";
import { PERSON_RELATIONSHIP_SUGGESTIONS, relationshipLabelText } from "@/lib/people";
import { SectionTabs } from "@/components/section-tabs";
import { useSectionTabs } from "@/lib/use-section-tabs";

// Mirrors apps/web's identical Life-page LIFE_TABS — this screen used to stack all 15 of its sections
// (16 on web, which also inlines Identity & legal documents; this screen only ever linked out to a
// standalone Identity screen — see the "Documents" tab's content below) vertically with no way to jump
// between them. "All" (the default, and the only tab not written to AsyncStorage) renders every section
// below in exactly the order they've always been in; each other tab just conditionally hides the sections
// outside its group — no section's own data fetching, empty states, or add-forms change based on which
// tab is selected, since load() and every section component still run regardless of visibility.
const LIFE_TABS = [
  { value: "all", label: "All" },
  { value: "schedule", label: "Schedule" },
  { value: "money", label: "Money" },
  { value: "home_vehicles", label: "Home & Vehicles" },
  { value: "family", label: "Family" },
  { value: "health", label: "Health" },
  { value: "documents", label: "Documents" },
] as const;
type LifeTab = (typeof LIFE_TABS)[number]["value"];

// CAL-001 "duplicate copies visually collapse while preserving original records" — a cross-source-linked
// member's own minimal fields (see ScheduleService.upcomingEvents' lean list projection — no per-member
// evidence/provider-name lookup here, that's resolved lazily on the member's own detail screen instead).
interface LinkedEventSummary {
  id: string;
  title: string;
  start: TemporalValueLike;
  isAllDay: boolean;
  location: string | null;
  source: string;
  providerEventId: string | null;
  status: string;
}

interface EventRow {
  id: string;
  title: string;
  start: TemporalValueLike;
  isAllDay: boolean;
  location: string | null;
  recurrenceRule: RecurrenceRule | null;
  nextOccurrences: string[];
  providerEventId: string | null;
  // CAL-001 — the other record(s) this event has been cross-source-linked with (never a merge — both rows
  // keep their own independent data forever); empty for an ordinary, unlinked event.
  linkedEvents: LinkedEventSummary[];
}

interface ScheduleConflict {
  id: string;
  kind: string;
  involvedEventIds: string[];
  // Adult-availability heuristic (ConflictService.schoolTransportConflicts, school_transport conflicts
  // only — always "standard" for a plain time_overlap conflict, which has no adult-availability concept).
  // "elevated" means at least one of the two events has NO free adult household member at all, per
  // unavailableEventIds below.
  severity?: "standard" | "elevated";
  unavailableEventIds?: string[];
}

interface Purchase {
  id: string;
  orderNumber: string | null;
  purchaseDate: TemporalValueLike;
  totalMinorUnits: number | null;
  totalCurrency: string | null;
}

interface ReturnRow {
  returnCase: {
    id: string;
    state: string;
    deadline: TemporalValueLike;
    valueAtStakeMinorUnits: number | null;
    valueAtStakeCurrency: string | null;
  };
  purchase: { orderNumber: string | null };
}

interface SavingsSummary {
  resolvedReturnsMinorUnits: number;
  redeemedStoreCreditsMinorUnits: number;
  outstandingStoreCreditsMinorUnits: number;
}

interface MonthlySpendSummary {
  totalMinorUnits: number;
  capMinorUnits: number | null;
  overCap: boolean;
}

interface ShipmentRow {
  shipment: { id: string; carrier: string; trackingNumber: string; status: string; estimatedDelivery: TemporalValueLike | null };
  purchase: { id: string; orderNumber: string | null } | null;
}

// Kept in sync with apps/mobile/app/shipment/[id].tsx and apps/web's shipment detail/list pages — this
// list view previously only special-cased "delivered" (everything else, "returned_to_sender"/"lost"
// included, fell back to the same neutral tone as routine "in transit"), the same gap already fixed on
// the detail screens and web's list but missed here.
const SHIPMENT_STATUS_TONE: Record<string, "positive" | "warning" | "neutral" | "critical"> = {
  delivered: "positive",
  out_for_delivery: "warning",
  in_transit: "neutral",
  label_created: "neutral",
  exception: "warning",
  returned_to_sender: "critical",
  lost: "critical",
};

// §40.3 Return state machine (eligible → initiated → label/dropoff ready → in transit → merchant received
// → refund expected → refunded/exchanged/disputed/closed) — mirrors apps/web's identical Life-page mapping,
// adapted to this app's Badge component, which has no "info" tone (only neutral/critical/warning/positive/
// brand — see components/badge.tsx) — "brand" stands in for web's "info" here.
// "resolved" is the legacy generic terminal state, still written automatically by
// PlaidAdapter.matchTransaction's refund-matching path.
const RETURN_STATE_TONE: Record<string, "positive" | "warning" | "neutral" | "brand" | "critical"> = {
  eligible: "neutral",
  initiated: "brand",
  label_ready: "brand",
  in_transit: "brand",
  merchant_received: "warning",
  refund_expected: "warning",
  refunded: "positive",
  exchanged: "positive",
  disputed: "critical",
  closed: "neutral",
  resolved: "positive",
};
const RETURN_TERMINAL_STATES = new Set(["resolved", "refunded", "exchanged", "disputed", "closed"]);

interface SubscriptionRow {
  subscription: { id: string; state: string; trialEndsAt: TemporalValueLike | null };
  stream: { serviceLabel: string; typicalAmountMinorUnits: number | null; typicalAmountCurrency: string | null; cadence: string };
}

interface BillRow {
  bill: {
    id: string;
    billerLabel: string;
    amountDueMinorUnits: number | null;
    amountDueCurrency: string | null;
    dueDate: TemporalValueLike;
    paymentObservedTransactionId: string | null;
  };
}

interface Warranty {
  id: string;
  productLabel: string;
  expirationDate: TemporalValueLike;
  registrationConfirmed: boolean | null;
}

interface TaskRow {
  id: string;
  title: string;
  dueCondition: TemporalValueLike | null;
  state: string;
  ownerUserId: string;
  assignedToUserId: string | null;
  assignmentStatus: "unassigned" | "pending" | "accepted" | "declined";
  recurrenceRule: RecurrenceRule | null;
  nextOccurrences: string[];
}

interface PropertyProfile {
  id: string;
  label: string;
  propertyType: string;
  address: string | null;
}

interface VehicleProfile {
  id: string;
  label: string;
  make: string | null;
  model: string | null;
  year: number | null;
}

interface StoreCredit {
  id: string;
  merchantName: string | null;
  amountMinorUnits: number;
  currency: string;
  expirationDate: TemporalValueLike;
  redeemed: boolean;
}

function SectionHeading({ title }: { title: string }) {
  const { theme } = useAppTheme();
  return (
    <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase", letterSpacing: 0.4 }}>
      {title}
    </Text>
  );
}

function AddPropertyRow({ onAdded }: { onAdded: () => void }) {
  const { theme } = useAppTheme();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [householdId, setHouseholdId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Found live: submit() below had try/finally with no catch — a failed POST (validation error, network
  // drop) still propagated as an unhandled promise rejection (React Native Web's crash overlay), and even
  // if it hadn't, there was no error state to show the user what went wrong.
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button">
        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.brandDefault }}>+ Add a property</Text>
      </Pressable>
    );
  }

  async function submit() {
    if (!label.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post("/v1/properties", { label, address: address || undefined, householdId });
      setLabel("");
      setAddress("");
      setHouseholdId(null);
      setOpen(false);
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add this property. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card style={{ gap: 8 }}>
      <TextField label="Name" placeholder="e.g. Home" value={label} onChangeText={setLabel} />
      <TextField label="Address (optional)" value={address} onChangeText={setAddress} />
      <HouseholdPicker mode="create" value={householdId} onChange={setHouseholdId} />
      {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button onPress={submit} loading={submitting} disabled={!label.trim()}>
            Add
          </Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button variant="secondary" onPress={() => setOpen(false)}>
            Cancel
          </Button>
        </View>
      </View>
    </Card>
  );
}

function AddStoreCreditRow({ onAdded }: { onAdded: () => void }) {
  const { theme } = useAppTheme();
  const [open, setOpen] = useState(false);
  const [merchantName, setMerchantName] = useState("");
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Same missing-catch bug as AddPropertyRow.submit above — see its comment.
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button">
        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.brandDefault }}>+ Add a store credit</Text>
      </Pressable>
    );
  }

  async function submit() {
    if (!merchantName.trim() || !amount) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post("/v1/store-credits", { merchantName, amountMinorUnits: Math.round(Number(amount) * 100) });
      setMerchantName("");
      setAmount("");
      setOpen(false);
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add this store credit. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card style={{ gap: 8 }}>
      <TextField label="Merchant" value={merchantName} onChangeText={setMerchantName} />
      <TextField label="Amount (USD)" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" />
      {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button onPress={submit} loading={submitting} disabled={!merchantName.trim() || !amount}>
            Add
          </Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button variant="secondary" onPress={() => setOpen(false)}>
            Cancel
          </Button>
        </View>
      </View>
    </Card>
  );
}

/** Mirrors apps/web's SafeSpendCard — see its own doc comment for the Phase 2 §52.2 "safe-spend
 * awareness" reasoning. */
function SafeSpendCard({ summary, onCapSaved }: { summary: MonthlySpendSummary; onCapSaved: () => void }) {
  const { theme } = useAppTheme();
  const [editing, setEditing] = useState(false);
  const [capInput, setCapInput] = useState(summary.capMinorUnits != null ? (summary.capMinorUnits / 100).toFixed(2) : "");
  const [saving, setSaving] = useState(false);
  // Same missing-catch bug as AddPropertyRow.submit above — see its comment.
  const [error, setError] = useState<string | null>(null);

  async function saveCap() {
    setSaving(true);
    setError(null);
    try {
      const parsed = capInput.trim() === "" ? null : Math.round(Number(capInput) * 100);
      await api.put("/v1/notification-preferences", { monthlySpendCapMinorUnits: parsed });
      setEditing(false);
      onCapSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save this. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card style={{ gap: 8 }}>
      <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Monthly subscription spend</Text>
      <Text style={{ fontSize: 18, fontWeight: "700", color: theme.colors.textPrimary }}>{formatMoneyMinorUnits(summary.totalMinorUnits, "USD")}</Text>
      {summary.capMinorUnits != null && (
        <Text style={{ fontSize: 12, color: summary.overCap ? theme.colors.critical : theme.colors.textTertiary }}>
          {summary.overCap ? "Over" : "Under"} your {formatMoneyMinorUnits(summary.capMinorUnits, "USD")} cap
        </Text>
      )}
      {editing ? (
        <>
          <TextField label="Monthly cap (USD, blank to clear)" value={capInput} onChangeText={setCapInput} keyboardType="decimal-pad" />
          {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Button onPress={saveCap} loading={saving}>
                Save
              </Button>
            </View>
            <View style={{ flex: 1 }}>
              <Button variant="secondary" onPress={() => setEditing(false)}>
                Cancel
              </Button>
            </View>
          </View>
        </>
      ) : (
        <Button variant="secondary" onPress={() => setEditing(true)}>
          {summary.capMinorUnits != null ? "Edit cap" : "Set a cap"}
        </Button>
      )}
    </Card>
  );
}

function AddVehicleRow({ onAdded }: { onAdded: () => void }) {
  const { theme } = useAppTheme();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [year, setYear] = useState("");
  const [vin, setVin] = useState("");
  const [householdId, setHouseholdId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Same missing-catch bug as AddPropertyRow.submit above — see its comment.
  const [error, setError] = useState<string | null>(null);
  // VEH-001 "VIN decode may prefill public vehicle attributes; user confirms" — decodes before create, so
  // the user reviews/edits the suggestion in these same fields rather than it silently applying anywhere.
  // Mirrors apps/web's AddVehicleForm.decodeVin exactly (life/page.tsx).
  const [decoding, setDecoding] = useState(false);
  const [decodeNote, setDecodeNote] = useState<string | null>(null);

  async function decodeVin() {
    if (!vin.trim()) return;
    setDecoding(true);
    setDecodeNote(null);
    try {
      const result = await api.post<{ success: boolean; errorText: string | null; make: string | null; model: string | null; modelYear: number | null }>(
        "/v1/vehicles/vin-decode",
        { vin: vin.trim() },
      );
      if (!result.success) {
        setDecodeNote(result.errorText ?? "Couldn't decode that VIN.");
      } else {
        if (!make.trim() && result.make) setMake(result.make);
        if (!model.trim() && result.model) setModel(result.model);
        if (!year.trim() && result.modelYear) setYear(String(result.modelYear));
        setDecodeNote("Filled in make/model/year from the VIN — review before saving.");
      }
    } catch (err) {
      setDecodeNote(err instanceof ApiError ? err.message : "Couldn't decode that VIN right now.");
    } finally {
      setDecoding(false);
    }
  }

  if (!open) {
    return (
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button">
        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.brandDefault }}>+ Add a vehicle</Text>
      </Pressable>
    );
  }

  async function submit() {
    if (!label.trim()) return;
    const trimmedYear = year.trim();
    const parsedYear = trimmedYear ? Number(trimmedYear) : null;
    if (trimmedYear && (!Number.isInteger(parsedYear) || parsedYear! < 1900 || parsedYear! > 2100)) {
      setError("Enter a valid year (e.g. 2021), or leave it blank.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await api.post("/v1/vehicles", {
        label,
        make: make || undefined,
        model: model || undefined,
        year: parsedYear ?? undefined,
        vin: vin || undefined,
        householdId,
      });
      setLabel("");
      setMake("");
      setModel("");
      setYear("");
      setVin("");
      setHouseholdId(null);
      setOpen(false);
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add this vehicle. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card style={{ gap: 8 }}>
      <TextField label="Name" placeholder="e.g. My car" value={label} onChangeText={setLabel} />
      <TextField label="Make" value={make} onChangeText={setMake} />
      <TextField label="Model" value={model} onChangeText={setModel} />
      <TextField label="Year" value={year} onChangeText={setYear} keyboardType="number-pad" />
      <TextField label="VIN (optional)" value={vin} onChangeText={setVin} autoCapitalize="characters" />
      <Button variant="ghost" onPress={decodeVin} loading={decoding} disabled={!vin.trim()}>
        Decode VIN
      </Button>
      {decodeNote && <Text style={{ fontSize: 12, color: theme.colors.textSecondary }}>{decodeNote}</Text>}
      <HouseholdPicker mode="create" value={householdId} onChange={setHouseholdId} />
      {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button onPress={submit} loading={submitting} disabled={!label.trim()}>
            Add
          </Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button variant="secondary" onPress={() => setOpen(false)}>
            Cancel
          </Button>
        </View>
      </View>
    </Card>
  );
}

interface SchoolEventRow {
  id: string;
  title: string;
  kind: string;
  start: TemporalValueLike;
  location: string | null;
  dependentId: string | null;
  requiresDropoff: boolean;
  requiresPickup: boolean;
}

interface PermissionFormRow {
  id: string;
  title: string;
  state: "discovered" | "opened" | "completed" | "submitted" | "confirmed";
  dueDate: TemporalValueLike | null;
}

interface SchoolHouseholdDependent {
  id: string;
  displayName: string;
}

interface MyHouseholdRow {
  household: { id: string; name: string };
}

const SCHOOL_KIND_LABELS: Record<string, string> = {
  no_school: "No school",
  picture_day: "Picture day",
  permission_deadline: "Permission deadline",
  conference: "Conference",
  field_trip: "Field trip",
  fee_due: "Fee due",
  game: "Game",
  practice: "Practice",
  announcement: "Announcement",
  other: "School",
};

const FORM_STATE_ORDER = ["discovered", "opened", "completed", "submitted", "confirmed"] as const;
const FORM_STATE_LABELS: Record<(typeof FORM_STATE_ORDER)[number], string> = {
  discovered: "Discovered",
  opened: "Opened",
  completed: "Completed",
  submitted: "Submitted",
  confirmed: "Confirmed",
};
function nextFormState(state: string): (typeof FORM_STATE_ORDER)[number] | null {
  const idx = FORM_STATE_ORDER.indexOf(state as (typeof FORM_STATE_ORDER)[number]);
  if (idx < 0 || idx >= FORM_STATE_ORDER.length - 1) return null;
  return FORM_STATE_ORDER[idx + 1] ?? null;
}

const SUGGESTED_PREP_ITEMS: Record<string, string[]> = {
  game: ["Water bottle", "Team jersey"],
  practice: ["Water bottle", "Practice gear"],
  field_trip: ["Comfortable shoes"],
  picture_day: ["Picture-day outfit"],
};

function AddSchoolSourceRow({ householdId, onAdded }: { householdId: string; onAdded: () => void }) {
  const { theme } = useAppTheme();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [icsUrl, setIcsUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button">
        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.brandDefault }}>+ Subscribe to a school/team calendar feed</Text>
      </Pressable>
    );
  }

  async function submit() {
    if (!label.trim() || !icsUrl.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post("/v1/school/sources", { householdId, label, kind: "ics", icsUrl });
      setLabel("");
      setIcsUrl("");
      setOpen(false);
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't subscribe to that feed. Check the URL and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card style={{ gap: 8 }}>
      <TextField label="Name" placeholder="e.g. Travel soccer team" value={label} onChangeText={setLabel} />
      <TextField label="ICS feed URL" value={icsUrl} onChangeText={setIcsUrl} autoCapitalize="none" keyboardType="url" />
      {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button onPress={submit} loading={submitting} disabled={!label.trim() || !icsUrl.trim()}>
            Subscribe
          </Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button variant="secondary" onPress={() => setOpen(false)}>
            Cancel
          </Button>
        </View>
      </View>
    </Card>
  );
}

/**
 * §25 "School, Children & Activities" — SCH-001/002/005/006/007. A self-contained section with its own
 * data load (rather than joining LifeScreen's own big `load()` Promise.all) — same reasoning as apps/web's
 * SchoolSection: this domain needs several endpoints (events, forms, conflicts, household, dependents)
 * together, and keeping it independent avoids widening an already-large shared fetch. SCH-007: a
 * kind-specific "Suggested" checklist is computed client-side only from SUGGESTED_PREP_ITEMS — never
 * fetched or persisted as a fact (see school.service.ts's identical doc comment on why).
 */
function SchoolSection() {
  const { theme } = useAppTheme();
  const [events, setEvents] = useState<SchoolEventRow[] | null>(null);
  const [forms, setForms] = useState<PermissionFormRow[] | null>(null);
  const [transportConflicts, setTransportConflicts] = useState<ScheduleConflict[] | null>(null);
  const [dependents, setDependents] = useState<SchoolHouseholdDependent[] | null>(null);
  const [primaryHouseholdId, setPrimaryHouseholdId] = useState<string | null>(null);
  const [advancingId, setAdvancingId] = useState<string | null>(null);
  const [resolvingConflictId, setResolvingConflictId] = useState<string | null>(null);
  const [assigningId, setAssigningId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [ev, f, conflicts, households] = await Promise.all([
        api.get<SchoolEventRow[]>("/v1/school/events"),
        api.get<PermissionFormRow[]>("/v1/school/forms"),
        api.get<ScheduleConflict[]>("/v1/school/conflicts"),
        api.get<MyHouseholdRow[]>("/v1/households"),
      ]);
      setEvents(ev);
      setForms(f);
      setTransportConflicts(conflicts);
      const householdId = households[0]?.household.id ?? null;
      setPrimaryHouseholdId(householdId);
      if (householdId) {
        const deps = await api.get<SchoolHouseholdDependent[]>(`/v1/households/${householdId}/dependents`);
        setDependents(deps);
      } else {
        setDependents([]);
      }
    } catch {
      // Best-effort section — a failure here shouldn't block the rest of the Life screen from rendering.
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function assignChild(eventId: string, dependentId: string) {
    setAssigningId(eventId);
    try {
      await api.put(`/v1/school/events/${eventId}/assign-child`, { dependentId });
      await load();
    } finally {
      setAssigningId(null);
    }
  }

  async function advanceForm(id: string, state: string) {
    setAdvancingId(id);
    try {
      await api.put(`/v1/school/forms/${id}/state`, { state });
      await load();
    } finally {
      setAdvancingId(null);
    }
  }

  async function resolveTransportConflict(id: string) {
    setResolvingConflictId(id);
    try {
      await api.post(`/v1/schedule-conflicts/${id}/resolve`);
      await load();
    } finally {
      setResolvingConflictId(null);
    }
  }

  const dependentsById = new Map((dependents ?? []).map((d) => [d.id, d.displayName]));
  const eventsById = new Map((events ?? []).map((e) => [e.id, e]));

  return (
    <View style={{ gap: 8 }}>
      <SectionHeading title="School & activities" />

      {transportConflicts && transportConflicts.length > 0 && (
        <Card style={{ gap: 8, backgroundColor: theme.colors.warningSubtleBg }}>
          <Text style={{ fontSize: 13, fontWeight: "700", color: theme.colors.warning }}>
            {transportConflicts.length === 1 ? "1 drop-off/pickup conflict" : `${transportConflicts.length} drop-off/pickup conflicts`}
          </Text>
          {transportConflicts.map((c) => {
            const elevated = c.severity === "elevated";
            const names = c.involvedEventIds.map((id) => eventsById.get(id)?.title ?? "another event");
            const unavailableNames = (c.unavailableEventIds ?? []).map((id) => eventsById.get(id)?.title ?? "an event");
            // Best-effort heuristic against each adult's own calendar (see ConflictService's own doc
            // comment) — never a guarantee a driver actually shows up, just a real signal worth surfacing.
            const message = elevated
              ? unavailableNames.length > 0
                ? `No available adult for ${unavailableNames.join(" or ")} — everyone in the household looks busy then.`
                : "Both kids need a ride and nobody in the household looks free — check who can cover this."
              : `${names.join(" and ")} need drop-off/pickup around the same time, but someone's available for each.`;
            return (
            <View key={c.id} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <Text style={{ fontSize: 13, fontWeight: elevated ? "700" : "400", color: elevated ? theme.colors.critical : theme.colors.warning, flex: 1 }}>
                {message}
              </Text>
              <Button variant="secondary" onPress={() => resolveTransportConflict(c.id)} loading={resolvingConflictId === c.id}>
                Dismiss
              </Button>
            </View>
            );
          })}
        </Card>
      )}

      {!events && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />}
      {events?.length === 0 && (
        <EmptyState title="Nothing from school yet" description="No-school days, picture day, field trips, games, and permission slips will show up here." />
      )}
      {events && events.length > 0 && (
        <Card style={{ padding: 0 }}>
          {events.map((e, i) => {
            const when = formatTemporal(e.start);
            const dependentName = e.dependentId ? dependentsById.get(e.dependentId) : null;
            const suggested = SUGGESTED_PREP_ITEMS[e.kind];
            const needsAssignment = !e.dependentId && dependents && dependents.length > 1;
            return (
              <View
                key={e.id}
                style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 6, borderTopWidth: i === 0 ? 0 : 1, borderTopColor: theme.colors.borderSubtle }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Badge tone="neutral">{SCHOOL_KIND_LABELS[e.kind] ?? e.kind}</Badge>
                  <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary, flex: 1 }}>{e.title}</Text>
                </View>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                  {when && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{when}</Text>}
                  {e.location && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{e.location}</Text>}
                  {dependentName && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>For {dependentName}</Text>}
                  {(e.requiresDropoff || e.requiresPickup) && (
                    <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Needs drop-off/pickup</Text>
                  )}
                </View>
                {suggested && (
                  <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
                    <Text style={{ fontWeight: "600" }}>Suggested</Text> (not confirmed): {suggested.join(", ")}
                  </Text>
                )}
                {needsAssignment && (
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 2 }}>
                    <Text style={{ fontSize: 12, color: theme.colors.textTertiary, alignSelf: "center" }}>Assign to:</Text>
                    {dependents.map((d) => (
                      <Pressable accessibilityRole="button"
                        key={d.id}
                        disabled={assigningId === e.id}
                        onPress={() => assignChild(e.id, d.id)}
                        style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: theme.colors.borderDefault }}
                      >
                        <Text style={{ fontSize: 12, color: theme.colors.textPrimary }}>{d.displayName}</Text>
                      </Pressable>
                    ))}
                  </View>
                )}
              </View>
            );
          })}
        </Card>
      )}

      {forms && forms.length > 0 && (
        <>
          <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase", letterSpacing: 0.4, marginTop: 4 }}>
            Permission slips & forms
          </Text>
          <Card style={{ padding: 0 }}>
            {forms.map((f, i) => {
              const due = f.dueDate ? formatTemporal(f.dueDate) : null;
              const next = nextFormState(f.state);
              return (
                <View
                  key={f.id}
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "center",
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    gap: 8,
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: theme.colors.borderSubtle,
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{f.title}</Text>
                    {due && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Due {due}</Text>}
                    <Badge tone={f.state === "confirmed" ? "positive" : f.state === "discovered" ? "warning" : "brand"}>{FORM_STATE_LABELS[f.state]}</Badge>
                  </View>
                  {next && (
                    <Button variant="secondary" onPress={() => advanceForm(f.id, next)} loading={advancingId === f.id}>
                      {`Mark ${FORM_STATE_LABELS[next].toLowerCase()}`}
                    </Button>
                  )}
                </View>
              );
            })}
          </Card>
        </>
      )}

      {primaryHouseholdId && <AddSchoolSourceRow householdId={primaryHouseholdId} onAdded={load} />}
    </View>
  );
}

interface HealthAppointmentRow {
  id: string;
  providerName: string | null;
  appointmentType: string | null;
  dateTime: TemporalValueLike;
  location: string | null;
  prepInstructions: string | null;
  visibility: "private" | "household" | "selected_people" | "shared_link";
}

interface RefillReminderRow {
  id: string;
  medicationName: string;
  nextRefillDate: TemporalValueLike;
  pharmacy: string | null;
  pickedUpAt: string | null;
}

/** §27 "Health Logistics (Non-Diagnostic)" — mirrors apps/web's identical Health section (life/page.tsx).
 * A self-contained section (same pattern as SchoolSection above) rather than threading through the
 * screen-wide `load()` Promise.all, so a failure here can't block the rest of the Life screen. */
function AddHealthAppointmentRow({ onAdded }: { onAdded: () => void }) {
  const { theme } = useAppTheme();
  const [open, setOpen] = useState(false);
  const [providerName, setProviderName] = useState("");
  const [appointmentType, setAppointmentType] = useState("");
  const [start, setStart] = useState("");
  const [location, setLocation] = useState("");
  const [prepInstructions, setPrepInstructions] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button">
        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.brandDefault }}>+ Add an appointment</Text>
      </Pressable>
    );
  }

  async function submit() {
    if (!start) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post("/v1/health/appointments", {
        providerName: providerName || undefined,
        appointmentType: appointmentType || undefined,
        startIso: new Date(start).toISOString(),
        location: location || undefined,
        prepInstructions: prepInstructions || undefined,
      });
      setProviderName("");
      setAppointmentType("");
      setStart("");
      setLocation("");
      setPrepInstructions("");
      setOpen(false);
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add this appointment. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card style={{ gap: 8 }}>
      <TextField label="Provider" placeholder="e.g. Dr. Chen" value={providerName} onChangeText={setProviderName} />
      <TextField label="Type (optional)" placeholder="e.g. dental" value={appointmentType} onChangeText={setAppointmentType} />
      <TextField label="Date & time (YYYY-MM-DDTHH:mm)" value={start} onChangeText={setStart} placeholder="2026-10-20T09:30" />
      <TextField label="Location (optional)" value={location} onChangeText={setLocation} />
      <TextField label="Prep notes (optional)" placeholder="e.g. bring insurance card" value={prepInstructions} onChangeText={setPrepInstructions} />
      <Text style={{ fontSize: 11, color: theme.colors.textTertiary }}>Private by default — only you can see this unless you share it below.</Text>
      {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button onPress={submit} loading={submitting} disabled={!start}>
            Add
          </Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button variant="secondary" onPress={() => setOpen(false)}>
            Cancel
          </Button>
        </View>
      </View>
    </Card>
  );
}

function AddRefillReminderRow({ onAdded }: { onAdded: () => void }) {
  const { theme } = useAppTheme();
  const [open, setOpen] = useState(false);
  const [medicationName, setMedicationName] = useState("");
  const [nextRefillDate, setNextRefillDate] = useState("");
  const [pharmacy, setPharmacy] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button">
        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.brandDefault }}>+ Add a refill reminder</Text>
      </Pressable>
    );
  }

  async function submit() {
    if (!medicationName.trim() || !nextRefillDate) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post("/v1/health/refill-reminders", { medicationName, nextRefillIso: nextRefillDate, pharmacy: pharmacy || undefined });
      setMedicationName("");
      setNextRefillDate("");
      setPharmacy("");
      setOpen(false);
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add this reminder. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card style={{ gap: 8 }}>
      <TextField label="Medication name" value={medicationName} onChangeText={setMedicationName} />
      <TextField label="Next refill date (YYYY-MM-DD)" value={nextRefillDate} onChangeText={setNextRefillDate} placeholder="2026-10-15" />
      <TextField label="Pharmacy (optional)" value={pharmacy} onChangeText={setPharmacy} />
      {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button onPress={submit} loading={submitting} disabled={!medicationName.trim() || !nextRefillDate}>
            Add
          </Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button variant="secondary" onPress={() => setOpen(false)}>
            Cancel
          </Button>
        </View>
      </View>
    </Card>
  );
}

function HealthSection() {
  const { theme } = useAppTheme();
  const router = useRouter();
  const [appointments, setAppointments] = useState<HealthAppointmentRow[] | null>(null);
  const [reminders, setReminders] = useState<RefillReminderRow[] | null>(null);
  const [sharingAppointmentId, setSharingAppointmentId] = useState<string | null>(null);
  const [markingId, setMarkingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [appts, refills] = await Promise.all([
        api.get<HealthAppointmentRow[]>("/v1/health/appointments"),
        api.get<RefillReminderRow[]>("/v1/health/refill-reminders"),
      ]);
      setAppointments(appts);
      setReminders(refills);
    } catch {
      // Best-effort section — a failure here shouldn't block the rest of the Life screen (same stance as SchoolSection).
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function markPickedUp(id: string) {
    setMarkingId(id);
    try {
      await api.post(`/v1/health/refill-reminders/${id}/picked-up`);
      await load();
    } finally {
      setMarkingId(null);
    }
  }

  const openReminders = reminders?.filter((r) => !r.pickedUpAt);

  return (
    <View style={{ gap: 8 }}>
      <SectionHeading title="Health" />
      <Text style={{ fontSize: 11, color: theme.colors.textTertiary }}>
        Private by default — a household member can&apos;t see these unless you share them individually.
      </Text>

      <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary }}>Appointments</Text>
      {!appointments && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />}
      {appointments?.length === 0 && (
        <EmptyState title="No upcoming health appointments" description="Appointments discovered from email, or added manually, will show up here." />
      )}
      {appointments && appointments.length > 0 && (
        <View style={{ gap: 8 }}>
          {appointments.map((a) => (
            <Card key={a.id} style={{ gap: 6 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{a.providerName ?? a.appointmentType ?? "Appointment"}</Text>
                  {a.location && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{a.location}</Text>}
                  {a.prepInstructions && <Text style={{ fontSize: 12, color: theme.colors.textSecondary }}>Prep: {a.prepInstructions}</Text>}
                </View>
                <View style={{ alignItems: "flex-end", gap: 4 }}>
                  <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{formatTemporal(a.dateTime)}</Text>
                  <Badge tone={a.visibility === "private" ? "neutral" : "brand"}>{a.visibility === "private" ? "Private" : "Household"}</Badge>
                </View>
              </View>
              <View style={{ flexDirection: "row", gap: 8 }}>
                {/* HLTH-001 — links/tasks/bills/document-attach and "export this appointment's packet" all
                    live on the standalone detail screen, not crammed into this inline card. */}
                <Button variant="secondary" onPress={() => router.push(`/health-appointment/${a.id}`)} style={{ flex: 1 }}>
                  Details
                </Button>
                <Button variant="secondary" onPress={() => setSharingAppointmentId(sharingAppointmentId === a.id ? null : a.id)} style={{ flex: 1 }}>
                  {sharingAppointmentId === a.id ? "Hide sharing" : "Share"}
                </Button>
              </View>
              {sharingAppointmentId === a.id && <ShareResourcePanel resourceId={a.id} collectionPath="/v1/health/appointments" resourceLabel="appointment" />}
            </Card>
          ))}
        </View>
      )}
      <AddHealthAppointmentRow onAdded={load} />

      <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, marginTop: 8 }}>Refill reminders</Text>
      {!reminders && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />}
      {openReminders?.length === 0 && <EmptyState title="No refill reminders" description="Add a medication refill or pickup reminder — just a name, a date, and an optional pharmacy." />}
      {openReminders && openReminders.length > 0 && (
        <View style={{ gap: 8 }}>
          {openReminders.map((r) => (
            <Card key={r.id} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <View>
                <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{r.medicationName}</Text>
                <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Refill by {formatTemporal(r.nextRefillDate)}</Text>
                {r.pharmacy && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{r.pharmacy}</Text>}
              </View>
              <Button variant="secondary" onPress={() => markPickedUp(r.id)} loading={markingId === r.id}>
                Mark picked up
              </Button>
            </Card>
          ))}
        </View>
      )}
      <AddRefillReminderRow onAdded={load} />
    </View>
  );
}

interface PetProfile {
  id: string;
  label: string;
  species: string | null;
  breed: string | null;
  lifecycleStatus: string;
}

function AddPetRow({ onAdded }: { onAdded: () => void }) {
  const { theme } = useAppTheme();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [species, setSpecies] = useState("");
  const [breed, setBreed] = useState("");
  const [householdId, setHouseholdId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button">
        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.brandDefault }}>+ Add a pet</Text>
      </Pressable>
    );
  }

  async function submit() {
    if (!label.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post("/v1/pets", { label, species: species || undefined, breed: breed || undefined, householdId });
      setLabel("");
      setSpecies("");
      setBreed("");
      setHouseholdId(null);
      setOpen(false);
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add this pet. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card style={{ gap: 8 }}>
      <TextField label="Name" placeholder="e.g. Rex" value={label} onChangeText={setLabel} />
      <TextField label="Species" placeholder="e.g. Dog" value={species} onChangeText={setSpecies} />
      <TextField label="Breed (optional)" value={breed} onChangeText={setBreed} />
      <HouseholdPicker mode="create" value={householdId} onChange={setHouseholdId} />
      {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button onPress={submit} loading={submitting} disabled={!label.trim()}>
            Add
          </Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button variant="secondary" onPress={() => setOpen(false)}>
            Cancel
          </Button>
        </View>
      </View>
    </Card>
  );
}

interface PersonRow {
  id: string;
  displayName: string;
  organizationId: string | null;
  relationshipLabel: string | null;
  relationshipLabelSource: "user_set" | "suggested";
  isImportant: boolean;
  lastContactAt: string | null;
  visibility: "private" | "household" | "selected_people" | "shared_link";
  relatedEntityIds: string[];
}

interface OrganizationRow {
  id: string;
  name: string;
  organizationType: string | null;
}

interface MergeCandidateGroup {
  reason: "matching_email" | "matching_phone" | "matching_name_and_organization";
  personIds: string[];
  people: PersonRow[];
}

/** PEO-001 manual "Add person" — `displayName` is the only required field; relationship label offers
 * PERSON_RELATIONSHIP_SUGGESTIONS as quick-pick chips but stays free text (see people.ts's own schema doc
 * comment). Mirrors AddPetRow's open/closed shape and apps/web's identical AddPersonForm. */
function AddPersonRow({ organizations, onAdded }: { organizations: OrganizationRow[]; onAdded: () => void }) {
  const { theme } = useAppTheme();
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [relationshipLabel, setRelationshipLabel] = useState("");
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [emails, setEmails] = useState("");
  const [phones, setPhones] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button">
        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.brandDefault }}>+ Add a person</Text>
      </Pressable>
    );
  }

  async function submit() {
    if (!displayName.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post("/v1/people", {
        displayName,
        relationshipLabel: relationshipLabel.trim() || undefined,
        organizationId: organizationId ?? undefined,
        emails: emails
          .split(/[,\n]+/)
          .map((e) => e.trim())
          .filter(Boolean),
        phones: phones
          .split(/[,\n]+/)
          .map((p) => p.trim())
          .filter(Boolean),
      });
      setDisplayName("");
      setRelationshipLabel("");
      setOrganizationId(null);
      setEmails("");
      setPhones("");
      setOpen(false);
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add this person. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card style={{ gap: 8 }}>
      <TextField label="Name" placeholder="e.g. Dr. Chen" value={displayName} onChangeText={setDisplayName} maxLength={200} />
      {organizations.length > 0 && (
        <View style={{ gap: 6 }}>
          <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textSecondary }}>Organization (optional)</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            <Pressable accessibilityRole="button"
              onPress={() => setOrganizationId(null)}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 4,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: organizationId === null ? theme.colors.brandDefault : theme.colors.borderSubtle,
              }}
            >
              <Text style={{ fontSize: 12, color: organizationId === null ? theme.colors.brandDefault : theme.colors.textTertiary }}>None</Text>
            </Pressable>
            {organizations.map((o) => (
              <Pressable accessibilityRole="button"
                key={o.id}
                onPress={() => setOrganizationId(o.id)}
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 4,
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: organizationId === o.id ? theme.colors.brandDefault : theme.colors.borderSubtle,
                }}
              >
                <Text style={{ fontSize: 12, color: organizationId === o.id ? theme.colors.brandDefault : theme.colors.textTertiary }}>{o.name}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}
      <TextField label="Relationship (optional)" placeholder="e.g. dentist, sister" value={relationshipLabel} onChangeText={setRelationshipLabel} maxLength={60} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {PERSON_RELATIONSHIP_SUGGESTIONS.map((s) => (
          <Pressable accessibilityRole="button"
            key={s}
            onPress={() => setRelationshipLabel(s)}
            style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: theme.colors.borderSubtle }}
          >
            <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{relationshipLabelText(s)}</Text>
          </Pressable>
        ))}
      </View>
      <TextField label="Email(s), comma-separated (optional)" value={emails} onChangeText={setEmails} autoCapitalize="none" keyboardType="email-address" />
      <TextField label="Phone(s), comma-separated (optional)" value={phones} onChangeText={setPhones} keyboardType="phone-pad" />
      {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button onPress={submit} loading={submitting} disabled={!displayName.trim()}>
            Add
          </Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button variant="secondary" onPress={() => setOpen(false)}>
            Cancel
          </Button>
        </View>
      </View>
    </Card>
  );
}

/**
 * §14 "Contacts, People & Relationships" (PEO-001..005) — self-contained section mirroring PetsSection's
 * shape below (own data load via useFocusEffect, plus its own manual-add form), with a link out to a full
 * detail screen (person/[id].tsx) for aliases/notes/important dates/relationships/linked history/sharing.
 * PEO-003's "suggested" relationship labels get a visibly distinct badge plus a one-tap confirm right in
 * this list — the same "never authoritative until confirmed" discipline PeopleService's own doc comment
 * describes. PEO-002's "possible duplicate" review lives on its own screen (person/merge.tsx), linked from
 * here with a live count.
 */
function PeopleSection() {
  const { theme } = useAppTheme();
  const router = useRouter();
  const [people, setPeople] = useState<PersonRow[] | null>(null);
  const [organizations, setOrganizations] = useState<OrganizationRow[]>([]);
  const [mergeCandidateCount, setMergeCandidateCount] = useState(0);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [ppl, orgs, candidates] = await Promise.all([
        api.get<PersonRow[]>("/v1/people"),
        api.get<OrganizationRow[]>("/v1/organizations"),
        api.get<MergeCandidateGroup[]>("/v1/people/merge-candidates"),
      ]);
      setPeople(ppl);
      setOrganizations(orgs);
      setMergeCandidateCount(candidates.length);
    } catch {
      // Best-effort section — a failure here shouldn't block the rest of the Life screen from rendering.
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function confirmSuggestion(personId: string) {
    setConfirmingId(personId);
    try {
      await api.post(`/v1/people/${personId}/relationship-label/confirm`);
      await load();
    } catch {
      // Best-effort — the badge just stays "suggested" if this fails; the user can retry the tap.
    } finally {
      setConfirmingId(null);
    }
  }

  const organizationsById = new Map(organizations.map((o) => [o.id, o.name]));

  return (
    <View style={{ gap: 8 }}>
      <SectionHeading title="People" />
      {!people && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />}
      {people?.length === 0 && (
        <EmptyState title="No people added yet" description="Add family, providers, contractors, or anyone else worth keeping track of — private by default." />
      )}
      {people && people.length > 0 && (
        <Card style={{ padding: 0 }}>
          {people.map((p, i) => (
            <Pressable accessibilityRole="button"
              key={p.id}
              onPress={() => router.push(`/person/${p.id}`)}
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
                paddingHorizontal: 16,
                paddingVertical: 12,
                gap: 8,
                borderTopWidth: i === 0 ? 0 : 1,
                borderTopColor: theme.colors.borderSubtle,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{p.displayName}</Text>
                <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 4 }}>
                  {p.organizationId && organizationsById.get(p.organizationId) && (
                    <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{organizationsById.get(p.organizationId)}</Text>
                  )}
                  {p.relationshipLabel && (
                    <Badge tone={p.relationshipLabelSource === "suggested" ? "warning" : "neutral"}>
                      {`${relationshipLabelText(p.relationshipLabel)}${p.relationshipLabelSource === "suggested" ? " · suggested" : ""}`}
                    </Badge>
                  )}
                </View>
              </View>
              <View style={{ alignItems: "flex-end", gap: 4 }}>
                {p.isImportant && <Badge tone="brand">★ Important</Badge>}
                {p.relationshipLabelSource === "suggested" && (
                  <Button
                    variant="secondary"
                    loading={confirmingId === p.id}
                    onPress={(e) => {
                      e.stopPropagation();
                      confirmSuggestion(p.id);
                    }}
                  >
                    Confirm
                  </Button>
                )}
              </View>
            </Pressable>
          ))}
        </Card>
      )}
      <AddPersonRow organizations={organizations} onAdded={load} />
      <Pressable onPress={() => router.push("/person/merge")} accessibilityRole="button">
        <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }}>
          Review possible duplicates{mergeCandidateCount > 0 ? ` (${mergeCandidateCount})` : ""}
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * Chapter 28 "Pets" (PET-001..005) — self-contained section mirroring SchoolSection's shape above (own
 * data load via useFocusEffect, rather than joining LifeScreen's own big load() Promise.all). See
 * apps/web's identical PetsSection for the same reasoning, and pet/[id].tsx for the full profile.
 */
function PetsSection() {
  const { theme } = useAppTheme();
  const router = useRouter();
  const [pets, setPets] = useState<PetProfile[] | null>(null);
  // §40.1/40.2 "Entity Resolution" — same live merge-candidate count pattern as PeopleSection's own.
  const [mergeCandidateCount, setMergeCandidateCount] = useState(0);

  const load = useCallback(async () => {
    try {
      const [p, candidates] = await Promise.all([api.get<PetProfile[]>("/v1/pets"), api.get<{ petIds: string[] }[]>("/v1/pets/merge-candidates")]);
      setPets(p);
      setMergeCandidateCount(candidates.length);
    } catch {
      // Best-effort section — a failure here shouldn't block the rest of the Life screen from rendering.
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const activePets = pets?.filter((p) => p.lifecycleStatus === "active");

  return (
    <View style={{ gap: 8 }}>
      <SectionHeading title="Pets" />
      {!pets && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />}
      {activePets?.length === 0 && (
        <EmptyState title="No pets added yet" description="Add a pet to track vet/grooming appointments, vaccinations, medications, and insurance." />
      )}
      {activePets && activePets.length > 0 && (
        <Card style={{ padding: 0 }}>
          {activePets.map((p, i) => (
            <Pressable accessibilityRole="button"
              key={p.id}
              onPress={() => router.push(`/pet/${p.id}`)}
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
                paddingHorizontal: 16,
                paddingVertical: 12,
                borderTopWidth: i === 0 ? 0 : 1,
                borderTopColor: theme.colors.borderSubtle,
              }}
            >
              <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{p.label}</Text>
              {(p.species || p.breed) && (
                <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{[p.species, p.breed].filter(Boolean).join(" · ")}</Text>
              )}
            </Pressable>
          ))}
        </Card>
      )}
      <AddPetRow onAdded={load} />
      <Pressable onPress={() => router.push("/pet/merge")} accessibilityRole="button">
        <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }}>
          Review possible duplicates{mergeCandidateCount > 0 ? ` (${mergeCandidateCount})` : ""}
        </Text>
      </Pressable>
    </View>
  );
}

/** CAP-010-style manual add — mirrors apps/web's identical AddTaskForm; this screen previously had no way
 * to create a reminder at all, only act on ones synced/discovered elsewhere. */
function AddTaskRow({ onAdded }: { onAdded: () => void }) {
  const { theme } = useAppTheme();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [recurrenceRule, setRecurrenceRule] = useState<RecurrenceRule | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // VEH-003 — fetched only once the form is actually open (not on every screen render) purely so
  // RecurrencePicker can offer the "mileage_or_calendar" option; mirrors apps/web's identical reasoning.
  const [vehicles, setVehicles] = useState<VehicleProfile[]>([]);
  useEffect(() => {
    if (open) api.get<VehicleProfile[]>("/v1/vehicles").then(setVehicles).catch(() => {});
  }, [open]);

  if (!open) {
    return (
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button">
        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.brandDefault }}>+ Add a reminder</Text>
      </Pressable>
    );
  }

  async function submit() {
    if (!title.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post("/v1/tasks", { title, dueIso: dueDate ? new Date(dueDate).toISOString() : null, recurrenceRule });
      setTitle("");
      setDueDate("");
      setRecurrenceRule(null);
      setOpen(false);
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add this reminder. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card style={{ gap: 8 }}>
      <TextField label="What do you need to do?" value={title} onChangeText={setTitle} maxLength={300} />
      <TextField label="Due date (optional, YYYY-MM-DD)" value={dueDate} onChangeText={setDueDate} placeholder="2026-10-01" />
      <RecurrencePicker value={recurrenceRule} onChange={setRecurrenceRule} vehicles={vehicles} />
      {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button onPress={submit} loading={submitting} disabled={!title.trim()}>
            Add
          </Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button variant="secondary" onPress={() => setOpen(false)}>
            Cancel
          </Button>
        </View>
      </View>
    </Card>
  );
}

/**
 * TASK-003 — mirrors apps/web's identical AddEventForm; this screen previously had no way to create a
 * calendar event at all, only view discovered/synced ones. Also the mobile side of CAL-003's synchronous
 * conflict check.
 */
function AddEventRow({ onAdded }: { onAdded: () => void }) {
  const { theme } = useAppTheme();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [start, setStart] = useState("");
  const [location, setLocation] = useState("");
  const [recurrenceRule, setRecurrenceRule] = useState<RecurrenceRule | null>(null);
  // CAL-003 "double-booked shared assets" — fetched only once the form is open (same lazy-load reasoning
  // as AddTaskRow's identical `vehicles` fetch above), purely to offer an optional vehicle tag.
  const [vehicles, setVehicles] = useState<VehicleProfile[]>([]);
  const [vehicleProfileId, setVehicleProfileId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [conflictNote, setConflictNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) api.get<VehicleProfile[]>("/v1/vehicles").then(setVehicles).catch(() => {});
  }, [open]);

  if (!open) {
    return (
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button">
        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.brandDefault }}>+ Add an event</Text>
      </Pressable>
    );
  }

  async function submit() {
    if (!title.trim() || !start) return;
    setSubmitting(true);
    setError(null);
    setConflictNote(null);
    try {
      const result = await api.post<{ id: string; conflicts: { id: string; kind: string }[] }>("/v1/events", {
        title,
        startIso: new Date(start).toISOString(),
        isAllDay: false,
        location: location || undefined,
        recurrenceRule,
        vehicleProfileId,
      });
      setTitle("");
      setStart("");
      setLocation("");
      setRecurrenceRule(null);
      setVehicleProfileId(null);
      onAdded();
      if (result.conflicts.some((c) => c.kind === "vehicle_double_booked")) {
        setConflictNote("That vehicle is already booked for an overlapping event");
      } else if (result.conflicts.length > 0) {
        setConflictNote("This overlaps with another event on your calendar — see the conflict banner above.");
      } else {
        setOpen(false);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add this event. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card style={{ gap: 8 }}>
      <TextField label="Event title" value={title} onChangeText={setTitle} maxLength={300} />
      <TextField label="Date & time (YYYY-MM-DDTHH:mm)" value={start} onChangeText={setStart} placeholder="2026-10-12T15:00" />
      <TextField label="Location (optional)" value={location} onChangeText={setLocation} />
      <RecurrencePicker value={recurrenceRule} onChange={setRecurrenceRule} />
      {vehicles.length > 0 && (
        <View style={{ gap: 6 }}>
          <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textSecondary }}>Vehicle (optional)</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            <Pressable accessibilityRole="button"
              onPress={() => setVehicleProfileId(null)}
              style={{
                paddingVertical: 6,
                paddingHorizontal: 12,
                borderRadius: 999,
                backgroundColor: vehicleProfileId === null ? theme.colors.brandDefault : theme.colors.bgSubtle,
              }}
            >
              <Text
                style={{ fontSize: 13, fontWeight: "600", color: vehicleProfileId === null ? theme.colors.textOnBrand : theme.colors.textSecondary }}
              >
                None
              </Text>
            </Pressable>
            {vehicles.map((v) => (
              <Pressable accessibilityRole="button"
                key={v.id}
                onPress={() => setVehicleProfileId(v.id)}
                style={{
                  paddingVertical: 6,
                  paddingHorizontal: 12,
                  borderRadius: 999,
                  backgroundColor: vehicleProfileId === v.id ? theme.colors.brandDefault : theme.colors.bgSubtle,
                }}
              >
                <Text
                  style={{ fontSize: 13, fontWeight: "600", color: vehicleProfileId === v.id ? theme.colors.textOnBrand : theme.colors.textSecondary }}
                >
                  {v.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}
      {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
      {conflictNote && <Text style={{ fontSize: 12, color: theme.colors.warning }}>{conflictNote}</Text>}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Button onPress={submit} loading={submitting} disabled={!title.trim() || !start}>
            Add
          </Button>
        </View>
        <View style={{ flex: 1 }}>
          <Button
            variant="secondary"
            onPress={() => {
              setOpen(false);
              setError(null);
              setConflictNote(null);
            }}
          >
            {conflictNote ? "Done" : "Cancel"}
          </Button>
        </View>
      </View>
    </Card>
  );
}

/** CAL-003 — mirrors apps/web's identical ConflictBanner (life/page.tsx) for the same reasoning. */
function ConflictBanner({ conflicts, events, onResolved }: { conflicts: ScheduleConflict[]; events: EventRow[] | null; onResolved: () => void }) {
  const { theme } = useAppTheme();
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const titleFor = (id: string) => events?.find((e) => e.id === id)?.title ?? "another event";

  async function resolve(id: string) {
    setResolvingId(id);
    try {
      await api.post(`/v1/schedule-conflicts/${id}/resolve`);
      onResolved();
    } finally {
      setResolvingId(null);
    }
  }

  if (conflicts.length === 0) return null;
  return (
    <Card style={{ gap: 8, backgroundColor: theme.colors.warningSubtleBg }}>
      <Text style={{ fontSize: 13, fontWeight: "700", color: theme.colors.warning }}>
        {conflicts.length === 1 ? "1 scheduling conflict" : `${conflicts.length} scheduling conflicts`}
      </Text>
      {conflicts.map((c) => (
        <View key={c.id} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <Text style={{ fontSize: 13, color: theme.colors.warning, flex: 1 }}>{c.involvedEventIds.map((id) => titleFor(id)).join(" overlaps with ")}</Text>
          <Button variant="secondary" onPress={() => resolve(c.id)} loading={resolvingId === c.id}>
            Dismiss
          </Button>
        </View>
      ))}
    </Card>
  );
}

export default function LifeScreen() {
  const { theme } = useAppTheme();
  const { user } = useAuth();
  const router = useRouter();
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [purchases, setPurchases] = useState<Purchase[] | null>(null);
  const [returns, setReturns] = useState<ReturnRow[] | null>(null);
  const [shipments, setShipments] = useState<ShipmentRow[] | null>(null);
  const [subscriptions, setSubscriptions] = useState<SubscriptionRow[] | null>(null);
  const [bills, setBills] = useState<BillRow[] | null>(null);
  const [warranties, setWarranties] = useState<Warranty[] | null>(null);
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  const [properties, setProperties] = useState<PropertyProfile[] | null>(null);
  const [vehicles, setVehicles] = useState<VehicleProfile[] | null>(null);
  // §40.1/40.2 "Entity Resolution" — same live merge-candidate count pattern as PeopleSection's own.
  const [propertyMergeCandidateCount, setPropertyMergeCandidateCount] = useState(0);
  const [vehicleMergeCandidateCount, setVehicleMergeCandidateCount] = useState(0);
  const [storeCredits, setStoreCredits] = useState<StoreCredit[] | null>(null);
  const [savings, setSavings] = useState<SavingsSummary | null>(null);
  const [monthlySpend, setMonthlySpend] = useState<MonthlySpendSummary | null>(null);
  const [conflicts, setConflicts] = useState<ScheduleConflict[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [completingTaskId, setCompletingTaskId] = useState<string | null>(null);
  // CAL-001 — which cross-source-linked appointment card (if any) currently has its "N sources" disclosure open.
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  // Which of this screen's grouped section tabs is selected — "all" (the default) renders every section
  // below in their original order, matching this screen's behavior before tabs existed.
  const [lifeTab, setLifeTab] = useSectionTabs("veynlo_section_tab_life", LIFE_TABS, "all");
  const showSchedule = lifeTab === "all" || lifeTab === "schedule";
  const showMoney = lifeTab === "all" || lifeTab === "money";
  const showHomeVehicles = lifeTab === "all" || lifeTab === "home_vehicles";
  const showFamily = lifeTab === "all" || lifeTab === "family";
  const showHealth = lifeTab === "all" || lifeTab === "health";
  const showDocuments = lifeTab === "all" || lifeTab === "documents";
  // Found live: this 13-way Promise.all had no try/catch, and useFocusEffect below calls load() without
  // awaiting it or attaching a .catch — so any single one of these 13 requests failing (transient network
  // error, an expired session mid-flight, etc.) becomes an unhandled promise rejection, which React Native
  // Web surfaces as a full-screen "Uncaught Error" dev overlay blocking the entire app, not just this tab.
  // Same fix already applied elsewhere in this app (documents.tsx, entities.tsx, home tab, etc.).
  const [loadError, setLoadError] = useState<string | null>(null);
  // Found live: redeemStoreCredit / resolveReturn / completeTask / respondToAssignment below all fire an
  // api.post from a bare onPress with no try/catch (completeTask had try/finally but no catch, which still
  // lets the rejection propagate unhandled) — same crash-overlay bug class as load() above.
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [ev, p, r, sh, s, b, w, t, props, vehs, credits, savingsSummary, spendSummary, unresolvedConflicts, propMergeCandidates, vehMergeCandidates] = await Promise.all([
        api.get<EventRow[]>("/v1/events"),
        api.get<Purchase[]>("/v1/purchases"),
        api.get<ReturnRow[]>("/v1/returns"),
        api.get<ShipmentRow[]>("/v1/shipments"),
        api.get<SubscriptionRow[]>("/v1/subscriptions"),
        api.get<BillRow[]>("/v1/bills"),
        api.get<Warranty[]>("/v1/warranties"),
        api.get<TaskRow[]>("/v1/tasks"),
        api.get<PropertyProfile[]>("/v1/properties"),
        api.get<VehicleProfile[]>("/v1/vehicles"),
        api.get<StoreCredit[]>("/v1/store-credits"),
        api.get<SavingsSummary>("/v1/savings-summary"),
        api.get<MonthlySpendSummary>("/v1/monthly-spend-summary"),
        api.get<ScheduleConflict[]>("/v1/schedule-conflicts"),
        // §40.1/40.2 "Entity Resolution" — same live merge-candidate count pattern as PeopleSection's own.
        api.get<{ propertyIds: string[] }[]>("/v1/properties/merge-candidates"),
        api.get<{ vehicleIds: string[] }[]>("/v1/vehicles/merge-candidates"),
      ]);
      setLoadError(null);
      setEvents(ev);
      setConflicts(unresolvedConflicts);
      setPurchases(p);
      // GET /v1/returns returns every return case regardless of state (no "still open" filter server-side)
      // — apps/web's Life page already filters terminal ones out client-side (see its own identical
      // comment); this screen was missing the same filter, so a return marked "resolved" (or, now that
      // §40.3's real return state machine exists, "refunded"/"exchanged"/"disputed"/"closed") stayed
      // sitting in this "No open returns"-titled section forever, "Mark refunded" button and all.
      setReturns(r.filter((row) => !RETURN_TERMINAL_STATES.has(row.returnCase.state)));
      setShipments(sh);
      setSubscriptions(s);
      setBills(b);
      setWarranties(w);
      setTasks(t.filter((task) => task.state !== "completed" && task.state !== "dismissed"));
      setProperties(props);
      setVehicles(vehs);
      setPropertyMergeCandidateCount(propMergeCandidates.length);
      setVehicleMergeCandidateCount(vehMergeCandidates.length);
      setStoreCredits(credits);
      setSavings(savingsSummary);
      setMonthlySpend(spendSummary);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Couldn't load this. Please try again.");
    }
  }, []);

  async function redeemStoreCredit(id: string) {
    setActionError(null);
    try {
      await api.post(`/v1/store-credits/${id}/redeem`);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't redeem this. Please try again.");
    }
  }

  async function resolveReturn(id: string) {
    setActionError(null);
    try {
      await api.post(`/v1/returns/${id}/resolve`);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't update this return. Please try again.");
    }
  }

  async function completeTask(id: string) {
    setCompletingTaskId(id);
    setActionError(null);
    try {
      await api.post(`/v1/tasks/${id}/complete`);
      setTasks((prev) => prev?.filter((t) => t.id !== id) ?? null);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't complete this task. Please try again.");
    } finally {
      setCompletingTaskId(null);
    }
  }

  async function respondToAssignment(id: string, decision: "accept" | "decline") {
    setActionError(null);
    try {
      await api.post(`/v1/tasks/${id}/${decision}`);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't update this task. Please try again.");
    }
  }

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.brandDefault} />}>
      {/* showBack=false: this is a tab ROOT (see ScreenHeader's own doc comment) — canGoBack() goes true
          after any tab switch under React Navigation's default backBehavior, which isn't the same thing as
          "this screen was pushed and should offer a way back." */}
      <ScreenHeader title="Life" subtitle="Everything Veynlo knows you own, owe, and are due back." showBack={false} />

      <SectionTabs accessibilityLabel="Life sections" value={lifeTab} onChange={setLifeTab} options={LIFE_TABS} />

      {loadError && <FetchError what="your Life page" message={loadError} onRetry={load} />}
      {actionError && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{actionError}</Text>}
      {conflicts && conflicts.length > 0 && <ConflictBanner conflicts={conflicts} events={events} onResolved={load} />}

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <View style={{ flex: 1, minWidth: 100 }}>
          <Button variant="secondary" onPress={() => router.push("/timeline")}>
            Timeline
          </Button>
        </View>
        <View style={{ flex: 1, minWidth: 100 }}>
          <Button variant="secondary" onPress={() => router.push("/documents")}>
            Documents
          </Button>
        </View>
        <View style={{ flex: 1, minWidth: 100 }}>
          <Button variant="secondary" onPress={() => router.push("/saved")}>
            Saved
          </Button>
        </View>
        <View style={{ flex: 1, minWidth: 100 }}>
          <Button variant="secondary" onPress={() => router.push("/trips")}>
            Trips
          </Button>
        </View>
        <View style={{ flex: 1, minWidth: 100 }}>
          <Button variant="secondary" onPress={() => router.push("/identity-records")}>
            Identity
          </Button>
        </View>
      </View>

      {savings && (savings.resolvedReturnsMinorUnits > 0 || savings.redeemedStoreCreditsMinorUnits > 0 || savings.outstandingStoreCreditsMinorUnits > 0) && (
        <Card style={{ gap: 6 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Text style={{ fontSize: 11, color: theme.colors.textTertiary }}>Saved from returns</Text>
            <Text style={{ fontSize: 11, color: theme.colors.textTertiary }}>Credits redeemed</Text>
            <Text style={{ fontSize: 11, color: theme.colors.textTertiary }}>Credits available</Text>
          </View>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Text style={{ fontSize: 15, fontWeight: "700", color: theme.colors.textPrimary }}>
              {formatMoneyMinorUnits(savings.resolvedReturnsMinorUnits, "USD")}
            </Text>
            <Text style={{ fontSize: 15, fontWeight: "700", color: theme.colors.textPrimary }}>
              {formatMoneyMinorUnits(savings.redeemedStoreCreditsMinorUnits, "USD")}
            </Text>
            <Text style={{ fontSize: 15, fontWeight: "700", color: theme.colors.textPrimary }}>
              {formatMoneyMinorUnits(savings.outstandingStoreCreditsMinorUnits, "USD")}
            </Text>
          </View>
        </Card>
      )}

      {monthlySpend && <SafeSpendCard summary={monthlySpend} onCapSaved={load} />}

      {showSchedule && (
      <View style={{ gap: 8 }}>
        <SectionHeading title="Appointments" />
        {!events && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />}
        {events?.length === 0 && (
          <EmptyState title="No upcoming appointments" description="Appointments and events discovered from email or a connected calendar will show up here." />
        )}
        {events && events.length > 0 && (
          <Card style={{ padding: 0 }}>
            {events.map((e, i) => {
              const when = formatTemporal(e.start);
              // CAL-001 "duplicate copies visually collapse while preserving original records" — this card
              // plus any cross-source-linked duplicates collapse into ONE row with a "N sources" disclosure,
              // rather than each independently-discovered copy of the same real-world appointment showing
              // up as its own separate row forever. Neither underlying record is ever deleted or merged —
              // expanding just lists both (or more), each still tappable through to its own detail screen.
              const memberCount = 1 + e.linkedEvents.length;
              const expanded = expandedEventId === e.id;
              return (
                <View key={e.id} style={{ borderTopWidth: i === 0 ? 0 : 1, borderTopColor: theme.colors.borderSubtle }}>
                  <Pressable accessibilityRole="button"
                    onPress={() => router.push(`/event/${e.id}`)}
                    style={{
                      flexDirection: "row",
                      justifyContent: "space-between",
                      alignItems: "center",
                      paddingHorizontal: 16,
                      paddingVertical: 12,
                      gap: 12,
                    }}
                  >
                    {/* `flex: 1` on the title/location column (matching the Reminders row's identical layout
                        just below) — without it, a long event title has no width constraint to shrink or
                        wrap against, so `justifyContent: "space-between"` has no leftover space left to
                        distribute and the timestamp on the right runs directly into the title with no gap at
                        all (confirmed live: "Parent-Teacher Conference — MayaSep 2, 5:17 AM" rendered as one
                        glued-together run of text). */}
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{e.title}</Text>
                      {e.location && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{e.location}</Text>}
                      {e.recurrenceRule && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{describeRecurrence(e.recurrenceRule)}</Text>}
                    </View>
                    <View style={{ alignItems: "flex-end", gap: 4 }}>
                      {when && <Text style={{ fontSize: 12, color: theme.colors.textTertiary, textAlign: "right" }}>{when}</Text>}
                      {memberCount > 1 && (
                        <Pressable accessibilityRole="button"
                          onPress={(evt) => {
                            evt.stopPropagation();
                            setExpandedEventId(expanded ? null : e.id);
                          }}
                          style={{ borderWidth: 1, borderColor: theme.colors.borderSubtle, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 }}
                        >
                          <Text style={{ fontSize: 11, fontWeight: "600", color: theme.colors.textTertiary }}>{memberCount} sources</Text>
                        </Pressable>
                      )}
                    </View>
                  </Pressable>
                  {memberCount > 1 && expanded && (
                    <View style={{ backgroundColor: theme.colors.bgSubtle, paddingHorizontal: 16, paddingVertical: 8, gap: 6 }}>
                      {[{ id: e.id, title: e.title, providerEventId: e.providerEventId }, ...e.linkedEvents].map((member) => (
                        <Pressable key={member.id} onPress={() => router.push(`/event/${member.id}`)} accessibilityRole="button" style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                          <Text style={{ fontSize: 11, color: theme.colors.textTertiary }}>{member.providerEventId ? "Synced calendar" : "Discovered from email"}</Text>
                          <Text style={{ fontSize: 11, color: theme.colors.textPrimary, flexShrink: 1, textAlign: "right" }} numberOfLines={1}>
                            {member.title}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  )}
                </View>
              );
            })}
          </Card>
        )}
        <AddEventRow onAdded={load} />
      </View>
      )}

      {showSchedule && (
      <View style={{ gap: 8 }}>
        <SectionHeading title="Reminders" />
        {!tasks && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />}
        {tasks?.length === 0 && (
          <EmptyState title="No open reminders" description="Sync your Reminders app from Connections, or tasks discovered elsewhere will show up here." />
        )}
        {tasks && tasks.length > 0 && (
          <Card style={{ padding: 0 }}>
            {tasks.map((t, i) => {
              const when = t.dueCondition ? formatTemporal(t.dueCondition) : null;
              const awaitingMyDecision = t.assignmentStatus === "pending" && t.assignedToUserId === user?.id;
              // A task the current user personally declined isn't their responsibility anymore — showing
              // it with a "Done" button (confirmed live: identical in every way to a normal accepted
              // task, no indication it was ever declined) reads as if declining silently did nothing.
              // Matches the owner's own "Declined" badge below, and the decline notification's own
              // wording ("reassign it or take it back yourself") — action from here on is the owner's.
              const declinedByMe = t.assignmentStatus === "declined" && t.assignedToUserId === user?.id && t.ownerUserId !== user?.id;
              return (
                <View
                  key={t.id}
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "center",
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: theme.colors.borderSubtle,
                    gap: 12,
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{t.title}</Text>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 }}>
                      {when && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{when}</Text>}
                      {t.assignmentStatus === "declined" && (t.ownerUserId === user?.id || declinedByMe) && <Badge tone="critical">Declined</Badge>}
                    </View>
                    {t.recurrenceRule && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{describeRecurrence(t.recurrenceRule)}</Text>}
                  </View>
                  {awaitingMyDecision ? (
                    <View style={{ flexDirection: "row", gap: 6 }}>
                      <Button onPress={() => respondToAssignment(t.id, "accept")}>Accept</Button>
                      <Button variant="secondary" onPress={() => respondToAssignment(t.id, "decline")}>
                        Decline
                      </Button>
                    </View>
                  ) : declinedByMe ? null : (
                    <Button variant="secondary" onPress={() => completeTask(t.id)} loading={completingTaskId === t.id}>
                      Done
                    </Button>
                  )}
                </View>
              );
            })}
          </Card>
        )}
        <AddTaskRow onAdded={load} />
      </View>
      )}

      {showMoney && (
      <View style={{ gap: 8 }}>
        <SectionHeading title="Returns" />
        {!returns && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />}
        {returns?.length === 0 && (
          <EmptyState title="No open returns" description="When a return window is closing, it'll show up here with the deadline and value at stake." />
        )}
        {returns && returns.length > 0 && (
          <View style={{ gap: 8 }}>
            {returns.map((r) => {
              const days = daysUntil(r.returnCase.deadline);
              const value = formatMoneyMinorUnits(r.returnCase.valueAtStakeMinorUnits, r.returnCase.valueAtStakeCurrency);
              return (
                <Card key={r.returnCase.id} style={{ gap: 6 }}>
                  <Pressable onPress={() => router.push(`/return-case/${r.returnCase.id}`)} accessibilityRole="button">
                    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                      <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>
                        Order {r.purchase.orderNumber ?? "—"}
                      </Text>
                      <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
                        {/* §40.3 Return state machine — only shown once a return has actually moved past
                            the default "eligible" state, mirroring apps/web's identical Life-page badge. */}
                        {r.returnCase.state !== "eligible" && (
                          <Badge tone={RETURN_STATE_TONE[r.returnCase.state] ?? "neutral"}>{r.returnCase.state.replace(/_/g, " ")}</Badge>
                        )}
                        {days != null && <Badge tone={days <= 3 ? "critical" : "warning"}>{days > 0 ? `${days}d left` : "Due today"}</Badge>}
                      </View>
                    </View>
                    {value && <Text style={{ fontSize: 18, fontWeight: "700", color: theme.colors.textPrimary }}>{value}</Text>}
                  </Pressable>
                  <Button variant="secondary" onPress={() => resolveReturn(r.returnCase.id)}>
                    Mark refunded
                  </Button>
                </Card>
              );
            })}
          </View>
        )}
      </View>
      )}

      {showSchedule && (
      <View style={{ gap: 8 }}>
        <SectionHeading title="Shipments" />
        {!shipments && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />}
        {shipments?.length === 0 && (
          <EmptyState title="No shipments tracked yet" description="Order confirmations and tracking updates will show up here automatically." />
        )}
        {shipments && shipments.length > 0 && (
          <View style={{ gap: 8 }}>
            {shipments.map((s) => {
              const estimated = s.shipment.estimatedDelivery ? formatTemporal(s.shipment.estimatedDelivery) : null;
              return (
                <Pressable key={s.shipment.id} onPress={() => router.push(`/shipment/${s.shipment.id}`)} accessibilityRole="button">
                  <Card style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                    <View>
                      <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{s.shipment.carrier}</Text>
                      <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{s.shipment.trackingNumber}</Text>
                    </View>
                    <View style={{ alignItems: "flex-end" }}>
                      <Badge tone={SHIPMENT_STATUS_TONE[s.shipment.status] ?? "neutral"}>{s.shipment.status.replace(/_/g, " ")}</Badge>
                      {estimated && <Text style={{ fontSize: 11, color: theme.colors.textTertiary, marginTop: 2 }}>Est. {estimated}</Text>}
                    </View>
                  </Card>
                </Pressable>
              );
            })}
          </View>
        )}
      </View>
      )}

      {showMoney && (
      <View style={{ gap: 8 }}>
        <SectionHeading title="Store credits" />
        {!storeCredits && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />}
        {storeCredits?.length === 0 && <EmptyState title="No store credits tracked yet" description="Store credits found in email, or added manually, will show up here." />}
        {storeCredits && storeCredits.length > 0 && (
          <View style={{ gap: 8 }}>
            {storeCredits.map((c) => {
              const expires = formatTemporal(c.expirationDate);
              const amount = formatMoneyMinorUnits(c.amountMinorUnits, c.currency);
              return (
                <Card key={c.id} style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <View>
                    <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{c.merchantName ?? "Unknown merchant"}</Text>
                    {expires && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Expires {expires}</Text>}
                    <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.textPrimary }}>{amount}</Text>
                  </View>
                  {c.redeemed ? (
                    <Badge tone="neutral">Redeemed</Badge>
                  ) : (
                    <Button variant="secondary" onPress={() => redeemStoreCredit(c.id)}>
                      Mark redeemed
                    </Button>
                  )}
                </Card>
              );
            })}
          </View>
        )}
        <AddStoreCreditRow onAdded={load} />
      </View>
      )}

      {showMoney && (
      <View style={{ gap: 8 }}>
        <SectionHeading title="Subscriptions" />
        {!subscriptions && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />}
        {subscriptions?.length === 0 && (
          <EmptyState title="No subscriptions detected yet" description="Connect email and Veynlo will find recurring charges automatically." />
        )}
        {subscriptions && subscriptions.length > 0 && (
          <Card style={{ padding: 0 }}>
            {subscriptions.map((s, i) => {
              const amount = formatMoneyMinorUnits(s.stream.typicalAmountMinorUnits, s.stream.typicalAmountCurrency);
              // SUB-002 — a trial previously looked identical to any other subscription on this list
              // (only "price_changed" got a badge here); the actual end date is what makes it actionable.
              const trialEnds = s.subscription.state === "trial" ? formatTemporal(s.subscription.trialEndsAt) : null;
              return (
                <Pressable accessibilityRole="button"
                  key={s.subscription.id}
                  onPress={() => router.push(`/subscription/${s.subscription.id}`)}
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "center",
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: theme.colors.borderSubtle,
                  }}
                >
                  <View>
                    <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{s.stream.serviceLabel}</Text>
                    <Text style={{ fontSize: 12, color: theme.colors.textTertiary, textTransform: "capitalize" }}>{s.stream.cadence}</Text>
                    {trialEnds && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Trial ends {trialEnds}</Text>}
                  </View>
                  <View style={{ alignItems: "flex-end", gap: 4 }}>
                    {amount && <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{amount}</Text>}
                    {s.subscription.state === "price_changed" && <Badge tone="warning">Price changed</Badge>}
                    {/* SUB-003 trial-ending transition — a calmer "brand" tone (matching the Trial badge
                        above), not "warning", since being charged the already-disclosed post-trial price on
                        schedule is expected, not a surprise increase. */}
                    {s.subscription.state === "trial_ended" && <Badge tone="brand">Trial ended</Badge>}
                    {s.subscription.state === "trial" && <Badge tone="brand">Trial</Badge>}
                    {/* §40.3 Subscription state machine — renewal_upcoming/cancellation_pending/paused
                        previously had no badge anywhere on mobile (only price_changed/trial_ended/trial did),
                        so a subscription in any of these real states looked identical to an ordinary active
                        one on this list. */}
                    {s.subscription.state === "renewal_upcoming" && <Badge tone="brand">Renewal upcoming</Badge>}
                    {s.subscription.state === "cancellation_pending" && <Badge tone="warning">Canceling</Badge>}
                    {s.subscription.state === "paused" && <Badge tone="neutral">Paused</Badge>}
                  </View>
                </Pressable>
              );
            })}
          </Card>
        )}
      </View>
      )}

      {showMoney && (
      <View style={{ gap: 8 }}>
        <SectionHeading title="Bills" />
        {!bills && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />}
        {bills?.length === 0 && (
          <EmptyState title="No bills detected yet" description="Bills discovered from email or connected accounts will appear here with due dates." />
        )}
        {bills && bills.length > 0 && (
          <Card style={{ padding: 0 }}>
            {bills.map((b, i) => {
              const due = formatTemporal(b.bill.dueDate);
              const amount = formatMoneyMinorUnits(b.bill.amountDueMinorUnits, b.bill.amountDueCurrency);
              return (
                <Pressable accessibilityRole="button"
                  key={b.bill.id}
                  onPress={() => router.push(`/bill/${b.bill.id}`)}
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "center",
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: theme.colors.borderSubtle,
                  }}
                >
                  <View>
                    <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{b.bill.billerLabel}</Text>
                    {due && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Due {due}</Text>}
                  </View>
                  <View style={{ alignItems: "flex-end", gap: 4 }}>
                    {amount && <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{amount}</Text>}
                    {/* BILL-002 — "likely handled" vs "due" at a glance, without opening the detail screen. */}
                    {b.bill.paymentObservedTransactionId && <Badge tone="positive">Paid</Badge>}
                  </View>
                </Pressable>
              );
            })}
          </Card>
        )}
      </View>
      )}

      {showMoney && (
      <View style={{ gap: 8 }}>
        <SectionHeading title="Warranties" />
        {!warranties && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />}
        {warranties?.length === 0 && (
          <EmptyState title="No warranties tracked yet" description="Warranties found in email will show up here with their expiration date." />
        )}
        {warranties && warranties.length > 0 && (
          <Card style={{ padding: 0 }}>
            {warranties.map((w, i) => {
              const days = daysUntil(w.expirationDate);
              const expires = formatTemporal(w.expirationDate);
              return (
                <Pressable accessibilityRole="button"
                  key={w.id}
                  onPress={() => router.push(`/warranty/${w.id}`)}
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "center",
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: theme.colors.borderSubtle,
                  }}
                >
                  <View>
                    <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{w.productLabel}</Text>
                    {expires && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Expires {expires}</Text>}
                  </View>
                  {days != null && <Badge tone={days <= 30 ? "warning" : "neutral"}>{days > 0 ? `${days}d left` : "Expired"}</Badge>}
                </Pressable>
              );
            })}
          </Card>
        )}
      </View>
      )}

      {showHomeVehicles && (
      <View style={{ gap: 8 }}>
        <SectionHeading title="Home" />
        {!properties && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />}
        {properties?.length === 0 && <EmptyState title="No properties added yet" description="Add a home or rental to track its warranties and service history." />}
        {properties && properties.length > 0 && (
          <Card style={{ padding: 0 }}>
            {properties.map((p, i) => (
              <Pressable accessibilityRole="button"
                key={p.id}
                onPress={() => router.push(`/property/${p.id}`)}
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  alignItems: "center",
                  paddingHorizontal: 16,
                  paddingVertical: 12,
                  borderTopWidth: i === 0 ? 0 : 1,
                  borderTopColor: theme.colors.borderSubtle,
                }}
              >
                <View>
                  <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{p.label}</Text>
                  {p.address && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{p.address}</Text>}
                </View>
              </Pressable>
            ))}
          </Card>
        )}
        <AddPropertyRow onAdded={load} />
        <Pressable onPress={() => router.push("/property/merge")} accessibilityRole="button">
          <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }}>
            Review possible duplicates{propertyMergeCandidateCount > 0 ? ` (${propertyMergeCandidateCount})` : ""}
          </Text>
        </Pressable>
      </View>
      )}

      {showHomeVehicles && (
      <View style={{ gap: 8 }}>
        <SectionHeading title="Vehicles" />
        {!vehicles && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />}
        {vehicles?.length === 0 && <EmptyState title="No vehicles added yet" description="Add a vehicle to track its warranties and maintenance history." />}
        {vehicles && vehicles.length > 0 && (
          <Card style={{ padding: 0 }}>
            {vehicles.map((v, i) => (
              <Pressable accessibilityRole="button"
                key={v.id}
                onPress={() => router.push(`/vehicle/${v.id}`)}
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  alignItems: "center",
                  paddingHorizontal: 16,
                  paddingVertical: 12,
                  borderTopWidth: i === 0 ? 0 : 1,
                  borderTopColor: theme.colors.borderSubtle,
                }}
              >
                <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{v.label}</Text>
                {(v.make || v.model || v.year) && (
                  <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{[v.year, v.make, v.model].filter(Boolean).join(" ")}</Text>
                )}
              </Pressable>
            ))}
          </Card>
        )}
        <AddVehicleRow onAdded={load} />
        <Pressable onPress={() => router.push("/vehicle/merge")} accessibilityRole="button">
          <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }}>
            Review possible duplicates{vehicleMergeCandidateCount > 0 ? ` (${vehicleMergeCandidateCount})` : ""}
          </Text>
        </Pressable>
      </View>
      )}

      {showFamily && <SchoolSection />}

      {showFamily && <PeopleSection />}

      {showFamily && <PetsSection />}

      {showHealth && <HealthSection />}

      {showMoney && (
      <View style={{ gap: 8 }}>
        <SectionHeading title="Purchases" />
        {!purchases && <View style={{ height: 64, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />}
        {purchases?.length === 0 && (
          <EmptyState title="No purchases yet" description="Connect email or scan a receipt and Veynlo will organize your purchases automatically." />
        )}
        {purchases && purchases.length > 0 && (
          <Card style={{ padding: 0 }}>
            {purchases.map((p, i) => {
              const date = formatTemporal(p.purchaseDate);
              const total = formatMoneyMinorUnits(p.totalMinorUnits, p.totalCurrency);
              return (
                <Pressable accessibilityRole="button"
                  key={p.id}
                  onPress={() => router.push(`/purchase/${p.id}`)}
                  style={{
                    flexDirection: "row",
                    justifyContent: "space-between",
                    alignItems: "center",
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: theme.colors.borderSubtle,
                  }}
                >
                  <View>
                    <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Order {p.orderNumber ?? "—"}</Text>
                    {date && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{date}</Text>}
                  </View>
                  {total && <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{total}</Text>}
                </Pressable>
              );
            })}
          </Card>
        )}
      </View>
      )}

      {/* Unlike web's inline IdentityRecordsSection, this app has always sent Identity & legal documents
          to its own standalone screen (the "Identity" button in the nav row above, pushing to
          /identity-records) rather than an inline list on this one — no change to that here. This card
          just gives the "Documents" tab real content of its own instead of landing on an empty section
          when that tab's selected, since the actual list still lives one tap away. */}
      {showDocuments && (
      <View style={{ gap: 8 }}>
        <SectionHeading title="Identity & legal documents" />
        <Pressable accessibilityRole="button" onPress={() => router.push("/identity-records")}>
          <Card style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary, flex: 1 }}>
              Passports, licenses, registrations &amp; permits — private by default
            </Text>
            <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.brandDefault }}>Open →</Text>
          </Card>
        </Pressable>
      </View>
      )}
    </Screen>
  );
}
