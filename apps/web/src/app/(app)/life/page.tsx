"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import type { RecurrenceRule } from "@veynlo/core";
import { api, swrFetcher, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { FetchError } from "@/components/ui/fetch-error";
import { RecurrencePicker } from "@/components/recurrence-picker";
import { formatTemporal, daysUntil, type TemporalValueLike } from "@/lib/format";
import { useSession } from "@/hooks/use-session";
import { useMaskedMoney } from "@/lib/financial-privacy-context";
import { ShareResourcePanel } from "@/components/sharing/share-resource-panel";
import { PERSON_RELATIONSHIP_SUGGESTIONS, relationshipLabelText } from "@/lib/people";
import { HouseholdSelectField, useHouseholdSelection, useMyHouseholds } from "@/components/ui/household-picker";
import { SectionTabs } from "@/components/ui/section-tabs";
import { useSectionTabs } from "@/hooks/use-section-tabs";

// This page used to stack all 16 of its sections vertically with no way to jump between them — the exact
// "endless scroll" complaint that led to every section below getting grouped behind a `SectionTabs` strip.
// "All" (the default, and the only tab that carries no `?tab=` param) renders every section in exactly the
// order they've always been in; each other tab just conditionally hides the sections outside its group —
// nothing about a section's own data fetching, empty states, or add-forms changes based on which tab is
// selected, since every section's hook still runs regardless of visibility.
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

/** TASK-003 — a short, human summary of a recurrence rule for list rows ("Repeats weekly", "Repeats every 3 days"). */
function describeRecurrence(rule: RecurrenceRule): string {
  switch (rule.kind) {
    case "daily":
      return rule.interval === 1 ? "Repeats daily" : `Repeats every ${rule.interval} days`;
    case "weekly":
      return rule.interval === 1 ? "Repeats weekly" : `Repeats every ${rule.interval} weeks`;
    case "monthly":
      return rule.interval === 1 ? "Repeats monthly" : `Repeats every ${rule.interval} months`;
    case "yearly":
      return rule.interval === 1 ? "Repeats yearly" : `Repeats every ${rule.interval} years`;
    case "nth_weekday":
      return "Repeats monthly";
    case "business_day":
      return "Repeats on business days";
    case "days_before":
      return "Repeats relative to another date";
    case "mileage":
      // VEH-007 — mileage-based tasks aren't shown on this generic list row today (RecurrencePicker
      // deliberately doesn't offer this kind here — see its own comment), but the switch still needs to be
      // exhaustive for a rule loaded from elsewhere (e.g. a vehicle detail page task) to render sanely
      // rather than crashing this page.
      return `Repeats every ${rule.intervalMiles.toLocaleString()} miles`;
    case "mileage_or_calendar":
      // VEH-003 — same exhaustiveness reasoning as "mileage" above; RecurrencePicker DOES offer this kind
      // (opt-in via its `vehicles` prop), so this is reachable for a real task, not just a defensive stub.
      return `Repeats every ${rule.intervalMonths} month(s) or ${rule.intervalMiles.toLocaleString()} miles, whichever comes first`;
  }
}

/** CAL-003 — the shared conflict banner shown on the Life page. Conflict rows only carry event ids
 * (`involvedEventIds`); titles are looked up against whatever's already in the loaded events list, falling
 * back to a generic label for an event outside that list (e.g. already in the past) rather than an extra
 * fetch per conflict — this is a lightweight banner, not a full conflict-resolution UI. */
function ConflictBanner({
  conflicts,
  events,
  onResolved,
}: {
  conflicts: ScheduleConflict[];
  events: EventRow[] | undefined;
  onResolved: () => void;
}) {
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
    <div className="space-y-2 rounded-xl border border-warning-subtle bg-warning-subtle px-4 py-3">
      <p className="text-sm font-semibold text-warning-subtle-text">
        {conflicts.length === 1 ? "1 scheduling conflict" : `${conflicts.length} scheduling conflicts`}
      </p>
      <ul className="space-y-1.5">
        {conflicts.map((c) => {
          // CAL-003 "double-booked shared assets" — same generic titleFor lookup, just a wording that
          // actually describes a vehicle conflict rather than reusing "overlaps with" (a time-overlap
          // phrase that doesn't fit "these two events both need the same car").
          const joiner = c.kind === "vehicle_double_booked" ? " needs the same vehicle as " : " overlaps with ";
          const dateSuffix = c.occurrenceDate ? ` (on ${c.occurrenceDate})` : "";
          return (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 text-sm text-warning-subtle-text">
              <span>
                {c.involvedEventIds.map((id) => titleFor(id)).join(joiner)}
                {dateSuffix}
              </span>
              <Button size="sm" variant="secondary" loading={resolvingId === c.id} onClick={() => resolve(c.id)}>
                Dismiss
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface Purchase {
  id: string;
  orderNumber: string | null;
  purchaseDate: TemporalValueLike;
  totalMinorUnits: number | null;
  totalCurrency: string | null;
  state: string;
}

interface ReturnRow {
  returnCase: {
    id: string;
    deadline: TemporalValueLike;
    valueAtStakeMinorUnits: number | null;
    valueAtStakeCurrency: string | null;
    state: string;
  };
  purchase: { id: string; orderNumber: string | null };
}

interface ShipmentRow {
  shipment: { id: string; carrier: string; trackingNumber: string; status: string; estimatedDelivery: TemporalValueLike | null };
  purchase: { id: string; orderNumber: string | null } | null;
}

interface SubscriptionRow {
  subscription: { id: string; state: string; trialEndsAt: TemporalValueLike | null };
  stream: { serviceLabel: string; typicalAmountMinorUnits: number | null; typicalAmountCurrency: string | null; cadence: string };
}

// Same mapping the shipment detail page uses — kept in sync so this list view doesn't collapse
// "exception" / "lost" / "returned_to_sender" (states that need attention) into the same neutral tone
// as an ordinary in-transit package, the way a plain delivered/not-delivered check would.
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
// → refund expected → refunded/exchanged/disputed/closed) — previously this list showed only a deadline
// countdown badge with no indication a return had actually been started/shipped/refunded; a return case
// still sitting at "eligible" (nothing done yet) looked identical to one already in transit. "resolved" is
// the legacy generic terminal state (still written automatically by PlaidAdapter's refund-matching path)
// kept alongside the newer named terminal states below.
const RETURN_STATE_TONE: Record<string, "positive" | "warning" | "neutral" | "info" | "critical"> = {
  eligible: "neutral",
  initiated: "info",
  label_ready: "info",
  in_transit: "info",
  merchant_received: "warning",
  refund_expected: "warning",
  refunded: "positive",
  exchanged: "positive",
  disputed: "critical",
  closed: "neutral",
  resolved: "positive",
};
// Terminal outcomes a return case can end in — used to filter a resolved/refunded/exchanged/disputed/
// closed return out of the still-open returns list below (see its own comment for why "resolved" alone
// used to be the only state checked here).
const RETURN_TERMINAL_STATES = new Set(["resolved", "refunded", "exchanged", "disputed", "closed"]);

// Subscription state machine (candidate → trial/active → renewal_upcoming/price_changed/paused/
// cancellation_pending → canceled/expired). Previously only "price_changed" got a badge at all, so a
// paused, canceled, or expired subscription looked identical to an active one in this list.
const SUBSCRIPTION_STATE_TONE: Record<string, "positive" | "warning" | "neutral" | "info" | "critical"> = {
  candidate: "neutral",
  trial: "info",
  active: "positive",
  renewal_upcoming: "info",
  price_changed: "warning",
  // SUB-003 trial-ending transition — an expected move out of a tracked trial/promo, deliberately a
  // calmer "info" tone (matching "trial" above) rather than "price_changed"'s "warning" tone, since this
  // isn't a surprise increase (see ingestion.service.ts's extractSubscription doc comment).
  trial_ended: "info",
  paused: "neutral",
  cancellation_pending: "warning",
  canceled: "neutral",
  expired: "neutral",
};

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

// CAL-001 "duplicate copies visually collapse while preserving original records" — a cross-source-linked
// member's own minimal fields (see ScheduleService.upcomingEvents' lean list projection — no per-member
// evidence/provider-name lookup here, that's resolved lazily on the member's own detail page instead).
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

interface ScheduleConflict {
  id: string;
  kind: string;
  involvedEventIds: string[];
  occurrenceDate: string | null;
}

interface Warranty {
  id: string;
  productLabel: string;
  expirationDate: TemporalValueLike;
  registrationConfirmed: boolean | null;
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

// §27 "Health Logistics (Non-Diagnostic)" — logistics-only fields, deliberately no symptom/diagnosis/dose
// field exists anywhere in this shape (see HealthLogisticsService's own doc comment for the backend side).
interface HealthAppointment {
  id: string;
  providerName: string | null;
  appointmentType: string | null;
  dateTime: TemporalValueLike;
  location: string | null;
  prepInstructions: string | null;
  visibility: "private" | "household" | "selected_people" | "shared_link";
  householdId: string | null;
}

interface RefillReminder {
  id: string;
  medicationName: string;
  nextRefillDate: TemporalValueLike;
  pharmacy: string | null;
  pickedUpAt: string | null;
}

/** Phase 2 §52.2 "safe-spend awareness" — an editable monthly cap, compared against the normalized
 * total CommerceService.monthlySpendSummary computes from every still-active subscription. */
function SafeSpendCard({ summary, onCapSaved }: { summary: MonthlySpendSummary; onCapSaved: () => void }) {
  const maskedMoney = useMaskedMoney();
  const [editing, setEditing] = useState(false);
  const [capInput, setCapInput] = useState(summary.capMinorUnits != null ? (summary.capMinorUnits / 100).toFixed(2) : "");
  const [saving, setSaving] = useState(false);

  async function saveCap() {
    setSaving(true);
    try {
      const parsed = capInput.trim() === "" ? null : Math.round(Number(capInput) * 100);
      await api.put("/v1/notification-preferences", { monthlySpendCapMinorUnits: parsed });
      setEditing(false);
      onCapSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardBody className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs text-tertiary">Monthly subscription spend</p>
          <p className="text-lg font-semibold text-primary">{maskedMoney(summary.totalMinorUnits, "USD")}</p>
          {summary.capMinorUnits != null && (
            <p className={`text-xs ${summary.overCap ? "text-critical" : "text-tertiary"}`}>
              {summary.overCap ? "Over" : "Under"} your {maskedMoney(summary.capMinorUnits, "USD")} cap
            </p>
          )}
        </div>
        {editing ? (
          <div className="flex items-center gap-2">
            <input
              type="number"
              step="0.01"
              placeholder="No cap"
              value={capInput}
              onChange={(e) => setCapInput(e.target.value)}
              aria-label="Monthly spend cap"
              className="h-9 w-28 rounded-lg border border-border-default bg-surface px-2 text-sm text-primary"
            />
            <Button size="sm" loading={saving} onClick={saveCap}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
            {summary.capMinorUnits != null ? "Edit cap" : "Set a cap"}
          </Button>
        )}
      </CardBody>
    </Card>
  );
}

function AddStoreCreditForm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [merchantName, setMerchantName] = useState("");
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-sm font-medium text-brand hover:underline">
        + Add a store credit
      </button>
    );
  }

  async function submit() {
    if (!merchantName.trim() || !amount) return;
    setSubmitting(true);
    try {
      await api.post("/v1/store-credits", { merchantName, amountMinorUnits: Math.round(Number(amount) * 100) });
      setMerchantName("");
      setAmount("");
      setOpen(false);
      onAdded();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardBody className="flex flex-wrap items-end gap-2">
        <Input value={merchantName} onChange={(e) => setMerchantName(e.target.value)} placeholder="Merchant" className="min-w-[160px] flex-1" />
        <Input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount (USD)" inputMode="decimal" className="w-32" />
        <Button onClick={submit} loading={submitting} disabled={!merchantName.trim() || !amount}>
          Add
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </CardBody>
    </Card>
  );
}

/**
 * CAP-010 "Manual Structured Add — fallback forms for ... deadline ..." — the Reminders section (backed
 * by POST /v1/tasks, which already existed and is used for accept/decline/complete) had no way to create
 * a task/deadline manually at all, only to act on ones synced in from elsewhere. Mirrors AddStoreCreditForm's
 * identical collapsed-link -> inline-card pattern used by every other manual-add form on this page.
 */
function AddTaskForm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [recurrenceRule, setRecurrenceRule] = useState<RecurrenceRule | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // VEH-003 — fetched here (rather than threaded down from LifePage, which also fetches this same list)
  // purely so this self-contained form doesn't need a new prop just for its recurrence picker; SWR dedupes
  // the request against LifePage's own `/v1/vehicles` call, so this isn't a second real network round trip.
  const { data: vehicles } = useSWR<{ id: string; label: string }[]>("/v1/vehicles", swrFetcher);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-sm font-medium text-brand hover:underline">
        + Add a reminder
      </button>
    );
  }

  async function submit() {
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      await api.post("/v1/tasks", { title, dueIso: dueDate ? new Date(dueDate).toISOString() : null, recurrenceRule });
      setTitle("");
      setDueDate("");
      setRecurrenceRule(null);
      setOpen(false);
      onAdded();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What do you need to do?" className="min-w-[200px] flex-1" maxLength={300} />
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="w-40" />
        </div>
        <RecurrencePicker value={recurrenceRule} onChange={setRecurrenceRule} vehicles={vehicles} />
        <div className="flex gap-2">
          <Button onClick={submit} loading={submitting} disabled={!title.trim()}>
            Add
          </Button>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

/**
 * TASK-003 — there was previously no way to create a calendar event from the UI at all (every existing
 * event came from AI discovery or a provider sync); this is the manual-add form that hangs off
 * `POST /v1/events` (see ScheduleService.createEvent's own doc comment). Also the first place a user can
 * see CAL-003's conflict check fire in real time — a newly created event that collides with an existing
 * one shows the conflict inline immediately, not just via the page-level banner on next reload.
 */
function AddEventForm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [start, setStart] = useState("");
  const [isAllDay, setIsAllDay] = useState(false);
  const [location, setLocation] = useState("");
  const [recurrenceRule, setRecurrenceRule] = useState<RecurrenceRule | null>(null);
  const [vehicleProfileId, setVehicleProfileId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [justCreatedConflict, setJustCreatedConflict] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // CAL-003 "double-booked shared assets" — fetched here (same SWR-dedupe reasoning as AddTaskForm's
  // identical `/v1/vehicles` fetch just above) so a user can tag "using this vehicle" right from event
  // creation, rather than needing a separate edit step afterward.
  const { data: vehicles } = useSWR<VehicleProfile[]>("/v1/vehicles", swrFetcher);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-sm font-medium text-brand hover:underline">
        + Add an event
      </button>
    );
  }

  async function submit() {
    if (!title.trim() || !start) return;
    setSubmitting(true);
    setError(null);
    setJustCreatedConflict(null);
    try {
      const result = await api.post<{ id: string; conflicts: { id: string; kind: string }[] }>("/v1/events", {
        title,
        startIso: isAllDay ? start : new Date(start).toISOString(),
        isAllDay,
        location: location || undefined,
        recurrenceRule,
        vehicleProfileId: vehicleProfileId || null,
      });
      setTitle("");
      setStart("");
      setLocation("");
      setRecurrenceRule(null);
      setVehicleProfileId("");
      onAdded();
      if (result.conflicts.some((c) => c.kind === "vehicle_double_booked")) {
        setJustCreatedConflict("That vehicle is already booked for an overlapping event — see the conflict above.");
      } else if (result.conflicts.length > 0) {
        setJustCreatedConflict("This overlaps with another event on your calendar — see the conflict above.");
      } else {
        setOpen(false);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that event.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Event title" className="min-w-[200px] flex-1" maxLength={300} />
          <Input
            type={isAllDay ? "date" : "datetime-local"}
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="w-56"
          />
          <label className="flex items-center gap-1.5 text-sm text-secondary">
            <input type="checkbox" checked={isAllDay} onChange={(e) => setIsAllDay(e.target.checked)} />
            All day
          </label>
        </div>
        <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Location (optional)" className="max-w-sm" />
        {vehicles && vehicles.length > 0 && (
          <select
            value={vehicleProfileId}
            onChange={(e) => setVehicleProfileId(e.target.value)}
            aria-label="Vehicle"
            className="h-9 rounded-lg border border-border-default bg-surface px-2 text-sm text-secondary"
          >
            <option value="">No vehicle</option>
            {vehicles.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        )}
        <RecurrencePicker value={recurrenceRule} onChange={setRecurrenceRule} />
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={submit} loading={submitting} disabled={!title.trim() || !start}>
            Add
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setOpen(false);
              setError(null);
              setJustCreatedConflict(null);
            }}
          >
            {justCreatedConflict ? "Done" : "Cancel"}
          </Button>
        </div>
        {justCreatedConflict && <p className="text-sm text-warning-subtle-text">{justCreatedConflict}</p>}
        {error && <p className="text-sm text-critical">{error}</p>}
      </CardBody>
    </Card>
  );
}

function AddPropertyForm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { data: households } = useMyHouseholds();
  const { householdId, setHouseholdId, reset: resetHousehold } = useHouseholdSelection(households);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-sm font-medium text-brand hover:underline">
        + Add a property
      </button>
    );
  }

  async function submit() {
    if (!label.trim()) return;
    setSubmitting(true);
    try {
      await api.post("/v1/properties", { label, address: address || undefined, householdId: householdId || null });
      setLabel("");
      setAddress("");
      resetHousehold();
      setOpen(false);
      onAdded();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardBody className="flex flex-wrap items-end gap-2">
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name (e.g. Home)" className="min-w-[160px] flex-1" />
        <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Address (optional)" className="min-w-[200px] flex-1" />
        <HouseholdSelectField households={households} value={householdId} onChange={setHouseholdId} />
        <Button onClick={submit} loading={submitting} disabled={!label.trim()}>
          Add
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </CardBody>
    </Card>
  );
}

function AddVehicleForm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [year, setYear] = useState("");
  const [vin, setVin] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // VEH-001 "VIN, year/make/model/trim" — the backend (CreateVehicleProfileDtoSchema) and the vehicle
  // detail page both already accept/display year and VIN, but this form only exposed make/model, so
  // there was no way to actually set them from the UI. Same fix applied to apps/mobile's AddVehicleRow.
  const [error, setError] = useState<string | null>(null);
  // VEH-001 "VIN decode may prefill public vehicle attributes; user confirms" — decodes before create, so
  // the user reviews/edits the suggestion in these same fields rather than it silently applying anywhere.
  const [decoding, setDecoding] = useState(false);
  const [decodeNote, setDecodeNote] = useState<string | null>(null);
  const { data: households } = useMyHouseholds();
  const { householdId, setHouseholdId, reset: resetHousehold } = useHouseholdSelection(households);

  async function decodeVin() {
    if (!vin.trim()) return;
    setDecoding(true);
    setDecodeNote(null);
    try {
      const result = await api.post<{ success: boolean; errorText: string | null; make: string | null; model: string | null; modelYear: number | null }>("/v1/vehicles/vin-decode", { vin: vin.trim() });
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
      <button onClick={() => setOpen(true)} className="text-sm font-medium text-brand hover:underline">
        + Add a vehicle
      </button>
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
        householdId: householdId || null,
      });
      setLabel("");
      setMake("");
      setModel("");
      setYear("");
      setVin("");
      resetHousehold();
      setOpen(false);
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that vehicle.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardBody className="flex flex-wrap items-end gap-2">
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name (e.g. My car)" className="min-w-[140px] flex-1" />
        <Input value={make} onChange={(e) => setMake(e.target.value)} placeholder="Make" className="min-w-[120px]" />
        <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Model" className="min-w-[120px]" />
        <div className="w-24 shrink-0">
          <Input value={year} onChange={(e) => setYear(e.target.value)} placeholder="Year" inputMode="numeric" />
        </div>
        <div className="w-40 shrink-0">
          <Input value={vin} onChange={(e) => setVin(e.target.value)} placeholder="VIN (optional)" />
        </div>
        <HouseholdSelectField households={households} value={householdId} onChange={setHouseholdId} />
        <Button variant="ghost" onClick={decodeVin} loading={decoding} disabled={!vin.trim()}>
          Decode VIN
        </Button>
        <Button onClick={submit} loading={submitting} disabled={!label.trim()}>
          Add
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        {decodeNote && <p className="w-full text-sm text-secondary">{decodeNote}</p>}
        {error && <p className="w-full text-sm text-critical">{error}</p>}
      </CardBody>
    </Card>
  );
}

interface SchoolEventRow {
  id: string;
  title: string;
  kind: string;
  start: TemporalValueLike;
  isAllDay: boolean;
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
  dependentId: string | null;
}

interface SchoolHouseholdDependent {
  id: string;
  displayName: string;
}

interface MyHouseholdRow {
  household: { id: string; name: string };
}

interface SchoolTransportConflict {
  id: string;
  kind: string;
  involvedEventIds: string[];
  // Adult-availability heuristic (ConflictService.schoolTransportConflicts) — "elevated" means at least one
  // of the two events has NO free adult household member at all, per unavailableEventIds below; "standard"
  // means someone's realistically available for each, so it's flagged less urgently.
  severity: "standard" | "elevated";
  unavailableEventIds: string[];
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

/** SCH-001 "assign child" picker — shown inline on an unassigned event only when the household actually has 2+ dependents (§25.1 "avoids guessing child identity when multiple candidates exist" is exactly why this is a picker, not an auto-guess). */
function AssignChildPicker({ eventId, dependents, onAssigned }: { eventId: string; dependents: SchoolHouseholdDependent[]; onAssigned: () => void }) {
  const [assigning, setAssigning] = useState(false);
  async function assign(dependentId: string) {
    if (!dependentId) return;
    setAssigning(true);
    try {
      await api.put(`/v1/school/events/${eventId}/assign-child`, { dependentId });
      onAssigned();
    } finally {
      setAssigning(false);
    }
  }
  return (
    <select
      defaultValue=""
      disabled={assigning}
      onChange={(e) => assign(e.target.value)}
      aria-label="Assign to child"
      className="h-8 rounded-lg border border-border-default bg-surface px-2 text-xs text-secondary"
    >
      <option value="" disabled>
        Assign to…
      </option>
      {dependents.map((d) => (
        <option key={d.id} value={d.id}>
          {d.displayName}
        </option>
      ))}
    </select>
  );
}

function AddSchoolSourceForm({ householdId, onAdded }: { householdId: string; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [icsUrl, setIcsUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-sm font-medium text-brand hover:underline">
        + Subscribe to a school/team calendar feed
      </button>
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
      setError(err instanceof ApiError ? err.message : "Couldn't subscribe to that feed — check the URL and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardBody className="flex flex-wrap items-end gap-2">
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name (e.g. Travel soccer team)" className="min-w-[180px] flex-1" />
        <Input value={icsUrl} onChange={(e) => setIcsUrl(e.target.value)} placeholder="ICS feed URL" className="min-w-[220px] flex-[2]" />
        <Button onClick={submit} loading={submitting} disabled={!label.trim() || !icsUrl.trim()}>
          Subscribe
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        {error && <p className="w-full text-sm text-critical">{error}</p>}
      </CardBody>
    </Card>
  );
}

/**
 * §25 "School, Children & Activities" — SCH-001/002/005/006/007. A self-contained section (its own
 * fetches, like the rest of this page's sections but grouped behind one component since this domain needs
 * several endpoints together — events, forms, transport conflicts, household + dependents for the assign
 * picker) rather than a separate top-level `/school` route, matching this page's existing per-domain
 * section pattern. SCH-007: an AI-generic "suggested" checklist is computed here, client-side only, from a
 * small kind-specific template — never fetched or persisted as a fact, and always visibly labeled
 * "Suggested" (see FIRST_SUGGESTED_ITEMS below and school.service.ts's identical doc comment on why).
 */
const SUGGESTED_PREP_ITEMS: Record<string, string[]> = {
  game: ["Water bottle", "Team jersey"],
  practice: ["Water bottle", "Practice gear"],
  field_trip: ["Comfortable shoes"],
  picture_day: ["Picture-day outfit"],
};

function SchoolSection() {
  const { data: events, isLoading: loadingEvents, mutate: mutateEvents } = useSWR<SchoolEventRow[]>("/v1/school/events", swrFetcher);
  const { data: forms, isLoading: loadingForms, mutate: mutateForms } = useSWR<PermissionFormRow[]>("/v1/school/forms", swrFetcher);
  const { data: transportConflicts, mutate: mutateConflicts } = useSWR<SchoolTransportConflict[]>("/v1/school/conflicts", swrFetcher);
  const { data: households } = useSWR<MyHouseholdRow[]>("/v1/households", swrFetcher);
  const primaryHouseholdId = households?.[0]?.household.id ?? null;
  const { data: dependents } = useSWR<SchoolHouseholdDependent[]>(
    primaryHouseholdId ? `/v1/households/${primaryHouseholdId}/dependents` : null,
    swrFetcher,
  );
  const dependentsById = new Map((dependents ?? []).map((d) => [d.id, d.displayName]));
  const [advancingId, setAdvancingId] = useState<string | null>(null);
  const [resolvingConflictId, setResolvingConflictId] = useState<string | null>(null);

  async function advanceForm(id: string, state: string) {
    setAdvancingId(id);
    try {
      await api.put(`/v1/school/forms/${id}/state`, { state });
      mutateForms();
    } finally {
      setAdvancingId(null);
    }
  }

  async function resolveTransportConflict(id: string) {
    setResolvingConflictId(id);
    try {
      await api.post(`/v1/schedule-conflicts/${id}/resolve`);
      mutateConflicts();
    } finally {
      setResolvingConflictId(null);
    }
  }

  const eventsById = new Map((events ?? []).map((e) => [e.id, e]));

  return (
    <Section title="School & activities">
      {transportConflicts && transportConflicts.length > 0 && (
        <div className="mb-3 space-y-2 rounded-xl border border-warning-subtle bg-warning-subtle px-4 py-3">
          <p className="text-sm font-semibold text-warning-subtle-text">
            {transportConflicts.length === 1 ? "1 drop-off/pickup conflict" : `${transportConflicts.length} drop-off/pickup conflicts`}
          </p>
          <ul className="space-y-1.5">
            {transportConflicts.map((c) => {
              const names = c.involvedEventIds.map((id) => eventsById.get(id)?.title ?? "another event");
              const elevated = c.severity === "elevated";
              const unavailableNames = c.unavailableEventIds.map((id) => eventsById.get(id)?.title ?? "an event");
              // Best-effort heuristic against each adult's own calendar (see ConflictService's own doc
              // comment) — never a guarantee a driver actually shows up, just a real signal worth surfacing.
              const message = elevated
                ? unavailableNames.length > 0
                  ? `No available adult for ${unavailableNames.join(" or ")} — everyone in the household looks busy then.`
                  : "Both kids need a ride and nobody in the household looks free — check who can cover this."
                : `${names.join(" and ")} need drop-off/pickup around the same time, but someone's available for each.`;
              return (
                <li
                  key={c.id}
                  className={`flex flex-wrap items-center justify-between gap-2 text-sm ${elevated ? "font-medium text-critical" : "text-warning-subtle-text"}`}
                >
                  <span>{message}</span>
                  <Button size="sm" variant="secondary" loading={resolvingConflictId === c.id} onClick={() => resolveTransportConflict(c.id)}>
                    Dismiss
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {loadingEvents && <div className="h-16 animate-pulse rounded-xl bg-subtle" />}
      {!loadingEvents && (!events || events.length === 0) && (
        <EmptyState title="Nothing from school yet" description="No-school days, picture day, field trips, games, and permission slips found in email or a subscribed calendar feed will show up here." />
      )}
      {events && events.length > 0 && (
        <div className="divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface">
          {events.map((e) => {
            const when = formatTemporal(e.start);
            const dependentName = e.dependentId ? dependentsById.get(e.dependentId) : null;
            const suggested = SUGGESTED_PREP_ITEMS[e.kind];
            return (
              <div key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge tone="neutral">{SCHOOL_KIND_LABELS[e.kind] ?? e.kind}</Badge>
                    <p className="break-words text-sm font-medium text-primary">{e.title}</p>
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-tertiary">
                    {when && <span>{when}</span>}
                    {e.location && <span>{e.location}</span>}
                    {dependentName && <span>For {dependentName}</span>}
                    {(e.requiresDropoff || e.requiresPickup) && <span>Needs drop-off/pickup</span>}
                  </div>
                  {suggested && (
                    <p className="mt-1 text-xs text-tertiary">
                      <span className="font-medium">Suggested</span> (not confirmed): {suggested.join(", ")}
                    </p>
                  )}
                </div>
                {!e.dependentId && dependents && dependents.length > 1 && (
                  <AssignChildPicker eventId={e.id} dependents={dependents} onAssigned={() => mutateEvents()} />
                )}
              </div>
            );
          })}
        </div>
      )}

      {loadingForms && <div className="mt-3 h-12 animate-pulse rounded-xl bg-subtle" />}
      {forms && forms.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-tertiary">Permission slips &amp; forms</p>
          <div className="divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface">
            {forms.map((f) => {
              const due = f.dueDate ? formatTemporal(f.dueDate) : null;
              const next = nextFormState(f.state);
              // Found live via manual QA: this row never showed which child a permission slip was for,
              // even though `dependentId` is set — the school EVENTS list just above already resolves
              // this via the same `dependentsById` map (see its "For {dependentName}" span); this block
              // just never did.
              const dependentName = f.dependentId ? dependentsById.get(f.dependentId) : null;
              return (
                <div key={f.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium text-primary">{f.title}</p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-tertiary">
                      {due && <span>Due {due}</span>}
                      {dependentName && <span>For {dependentName}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={f.state === "confirmed" ? "positive" : f.state === "discovered" ? "warning" : "info"}>{FORM_STATE_LABELS[f.state]}</Badge>
                    {next && (
                      <Button size="sm" variant="secondary" loading={advancingId === f.id} onClick={() => advanceForm(f.id, next)}>
                        Mark {FORM_STATE_LABELS[next].toLowerCase()}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {primaryHouseholdId && (
        <div className="mt-3">
          <AddSchoolSourceForm householdId={primaryHouseholdId} onAdded={() => mutateEvents()} />
        </div>
      )}
    </Section>
  );
}

interface PetProfile {
  id: string;
  label: string;
  species: string | null;
  breed: string | null;
  lifecycleStatus: string;
}

/** PET-001 manual add — mirrors AddVehicleForm's identical collapsed-link -> inline-card shape. */
function AddPetForm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [species, setSpecies] = useState("");
  const [breed, setBreed] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: households } = useMyHouseholds();
  const { householdId, setHouseholdId, reset: resetHousehold } = useHouseholdSelection(households);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-sm font-medium text-brand hover:underline">
        + Add a pet
      </button>
    );
  }

  async function submit() {
    if (!label.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post("/v1/pets", { label, species: species || undefined, breed: breed || undefined, householdId: householdId || null });
      setLabel("");
      setSpecies("");
      setBreed("");
      resetHousehold();
      setOpen(false);
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that pet.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardBody className="flex flex-wrap items-end gap-2">
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Name (e.g. Rex)" className="min-w-[140px] flex-1" />
        <Input value={species} onChange={(e) => setSpecies(e.target.value)} placeholder="Species (e.g. Dog)" className="min-w-[120px]" />
        <Input value={breed} onChange={(e) => setBreed(e.target.value)} placeholder="Breed (optional)" className="min-w-[120px]" />
        <HouseholdSelectField households={households} value={householdId} onChange={setHouseholdId} />
        <Button onClick={submit} loading={submitting} disabled={!label.trim()}>
          Add
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        {error && <p className="w-full text-sm text-critical">{error}</p>}
      </CardBody>
    </Card>
  );
}

/**
 * Chapter 28 "Pets" (PET-001..005) — self-contained section mirroring SchoolSection's shape: its own SWR
 * fetch and manual-add form, rendered as a single `<PetsSection />` in the page body rather than threading
 * pets state through LifePage's already-large hook list (same reasoning SchoolSection's own isolation
 * gives). The Home/Vehicles sections above are inline in LifePage instead only because they predate this
 * pattern — see life/pets/[id]/page.tsx for the full profile (vaccinations, refill reminders, vet-visit
 * history, sharing).
 */
function PetsSection() {
  const { data: pets, isLoading: loadingPets, mutate: mutatePets } = useSWR<PetProfile[]>("/v1/pets", swrFetcher);
  // §40.1/40.2 "Entity Resolution" — same "Review possible duplicates" link pattern as PeopleSection's own.
  const { data: mergeCandidates } = useSWR<{ petIds: string[] }[]>("/v1/pets/merge-candidates", swrFetcher);
  const activePets = pets?.filter((p) => p.lifecycleStatus === "active");

  return (
    <Section title="Pets">
      {loadingPets && <div className="h-16 animate-pulse rounded-xl bg-subtle" />}
      {!loadingPets && (!activePets || activePets.length === 0) && (
        <EmptyState title="No pets added yet" description="Add a pet to track vet/grooming appointments, vaccinations, medications, and insurance in one place." />
      )}
      {activePets && activePets.length > 0 && (
        <div className="divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface">
          {activePets.map((p) => (
            <Link key={p.id} href={`/life/pets/${p.id}`} className="flex items-center justify-between px-4 py-3 hover:bg-subtle">
              <p className="min-w-0 break-words text-sm font-medium text-primary">{p.label}</p>
              {(p.species || p.breed) && <span className="shrink-0 text-xs text-tertiary">{[p.species, p.breed].filter(Boolean).join(" · ")}</span>}
            </Link>
          ))}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <AddPetForm onAdded={() => mutatePets()} />
        <Link href="/life/pets/merge" className="text-sm font-medium text-brand hover:underline">
          Review possible duplicates{mergeCandidates && mergeCandidates.length > 0 ? ` (${mergeCandidates.length})` : ""}
        </Link>
      </div>
    </Section>
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
  householdId: string | null;
  relatedEntityIds: string[];
}

interface OrganizationRow {
  id: string;
  name: string;
  organizationType: string | null;
}

/** PEO-001 manual "Add person" — `displayName` is the only required field; relationship label offers
 * PERSON_RELATIONSHIP_SUGGESTIONS as quick-select chips but stays free text (see people.ts's own schema
 * doc comment), and organization/email(s)/phone(s) are all optional. Mirrors AddPetForm's open/closed
 * toggle shape. */
function AddPersonForm({ organizations, onAdded }: { organizations: OrganizationRow[] | undefined; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [relationshipLabel, setRelationshipLabel] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [emails, setEmails] = useState("");
  const [phones, setPhones] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-sm font-medium text-brand hover:underline">
        + Add a person
      </button>
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
        organizationId: organizationId || undefined,
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
      setOrganizationId("");
      setEmails("");
      setPhones("");
      setOpen(false);
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that person.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Name (e.g. Dr. Chen)" className="min-w-[160px] flex-1" maxLength={200} />
          <select
            value={organizationId}
            onChange={(e) => setOrganizationId(e.target.value)}
            aria-label="Organization"
            className="h-10 rounded-lg border border-border-default bg-surface px-2 text-sm text-primary"
          >
            <option value="">No organization</option>
            {organizations?.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Input
            value={relationshipLabel}
            onChange={(e) => setRelationshipLabel(e.target.value)}
            placeholder="Relationship (e.g. dentist, sister) — optional"
            maxLength={60}
          />
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {PERSON_RELATIONSHIP_SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setRelationshipLabel(s)}
                className="rounded-full border border-border-default px-2.5 py-1 text-xs text-secondary hover:bg-subtle"
              >
                {relationshipLabelText(s)}
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Input value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="Email(s), comma-separated — optional" />
          <Input value={phones} onChange={(e) => setPhones(e.target.value)} placeholder="Phone(s), comma-separated — optional" />
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={submit} loading={submitting} disabled={!displayName.trim()}>
            Add
          </Button>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
        {error && <p className="text-sm text-critical">{error}</p>}
      </CardBody>
    </Card>
  );
}

/**
 * §14 "Contacts, People & Relationships" (PEO-001..005) — self-contained section mirroring PetsSection's
 * shape: its own SWR fetches and manual-add form, with a link out to a full detail page
 * (life/people/[id]) for aliases/notes/important dates/relationships/linked history/sharing. PEO-003's
 * "suggested" relationship labels get a visibly distinct badge plus a one-click confirm right in the list —
 * the same "never authoritative until confirmed" discipline PeopleService's own doc comment describes.
 * PEO-002's "possible duplicate" review lives on its own /life/people/merge page, linked from here.
 */
function PeopleSection() {
  const { data: people, isLoading: loadingPeople, mutate: mutatePeople } = useSWR<PersonRow[]>("/v1/people", swrFetcher);
  const { data: organizations, mutate: mutateOrganizations } = useSWR<OrganizationRow[]>("/v1/organizations", swrFetcher);
  const { data: mergeCandidates } = useSWR<{ personIds: string[] }[]>("/v1/people/merge-candidates", swrFetcher);
  const organizationsById = new Map((organizations ?? []).map((o) => [o.id, o.name]));
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  async function confirmSuggestion(personId: string) {
    setConfirmingId(personId);
    try {
      await api.post(`/v1/people/${personId}/relationship-label/confirm`);
      mutatePeople();
    } finally {
      setConfirmingId(null);
    }
  }

  return (
    <Section title="People">
      {loadingPeople && <div className="h-16 animate-pulse rounded-xl bg-subtle" />}
      {!loadingPeople && (!people || people.length === 0) && (
        <EmptyState
          title="No people added yet"
          description="Add family, providers, contractors, or anyone else worth keeping track of — private by default."
        />
      )}
      {people && people.length > 0 && (
        <div className="divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface">
          {people.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <Link href={`/life/people/${p.id}`} className="min-w-0 flex-1 hover:text-brand">
                <p className="truncate text-sm font-medium text-primary">{p.displayName}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {p.organizationId && organizationsById.get(p.organizationId) && (
                    <span className="text-xs text-tertiary">{organizationsById.get(p.organizationId)}</span>
                  )}
                  {p.relationshipLabel && (
                    <Badge tone={p.relationshipLabelSource === "suggested" ? "warning" : "neutral"}>
                      {relationshipLabelText(p.relationshipLabel)}
                      {p.relationshipLabelSource === "suggested" ? " · suggested" : ""}
                    </Badge>
                  )}
                </div>
              </Link>
              <div className="flex shrink-0 items-center gap-2">
                {p.isImportant && <Badge tone="brand">★ Important</Badge>}
                {p.relationshipLabelSource === "suggested" && (
                  <Button size="sm" variant="secondary" loading={confirmingId === p.id} onClick={() => confirmSuggestion(p.id)}>
                    Confirm
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <AddPersonForm
          organizations={organizations}
          onAdded={() => {
            mutatePeople();
            mutateOrganizations();
          }}
        />
        <Link href="/life/people/merge" className="text-sm font-medium text-brand hover:underline">
          Review possible duplicates{mergeCandidates && mergeCandidates.length > 0 ? ` (${mergeCandidates.length})` : ""}
        </Link>
      </div>
    </Section>
  );
}

interface IdentityRecordRow {
  id: string;
  recordType: "passport" | "drivers_license" | "vehicle_registration" | "professional_license" | "property_obligation";
  label: string;
  expirationDate: TemporalValueLike | null;
  status: "active" | "expired" | "renewed";
}

const IDENTITY_RECORD_TYPE_LABELS: Record<IdentityRecordRow["recordType"], string> = {
  passport: "Passport",
  drivers_license: "Driver's license",
  vehicle_registration: "Vehicle registration",
  professional_license: "Professional/recreational license",
  property_obligation: "Property/government obligation",
};

/**
 * "Identity & Legal Continuity" (ID-001..005: passport, driver's license/state ID, vehicle registration,
 * professional/recreational licenses, property/government obligations) — a dedicated, private-by-default
 * domain (see IdentityRecordsService's own doc comment) closing the gap TRIP-006 alone didn't cover. Mirrors
 * PetsSection's minimal "list + link out to a full detail page" shape rather than an inline add form here:
 * this domain's sensitive fields (a document number behind a step-up reveal, renewal/versioning, a
 * jurisdiction renewal-link picker) genuinely need the dedicated `/life/identity` pages' room, the same
 * reasoning that already sent Health/Pets detail work to their own standalone routes.
 */
function IdentityRecordsSection() {
  const { data: records, isLoading } = useSWR<IdentityRecordRow[]>("/v1/identity-records", swrFetcher);
  const active = records?.filter((r) => r.status !== "renewed");

  return (
    <Section title="Identity & legal documents">
      <p className="-mt-1 mb-3 text-xs text-tertiary">
        Private by default — passports, licenses, registrations, and permits, each with its own expiration reminder. Never visible to a household member unless you explicitly share it.
      </p>
      {isLoading && <div className="h-16 animate-pulse rounded-xl bg-subtle" />}
      {!isLoading && (!active || active.length === 0) && (
        <EmptyState title="No identity records yet" description="Add a passport, driver's license, vehicle registration, professional license, or property obligation to track its expiration." />
      )}
      {active && active.length > 0 && (
        <div className="divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface">
          {active.map((r) => {
            const expires = r.expirationDate ? formatTemporal(r.expirationDate) : null;
            return (
              <Link key={r.id} href={`/life/identity/${r.id}`} className="flex items-center justify-between gap-2 px-4 py-3 hover:bg-subtle">
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium text-primary">{r.label}</p>
                  <p className="text-xs text-tertiary">{IDENTITY_RECORD_TYPE_LABELS[r.recordType]}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {expires && <span className="text-xs text-tertiary">Expires {expires}</span>}
                  <Badge tone={r.status === "expired" ? "critical" : "neutral"}>{r.status === "expired" ? "Expired" : "Active"}</Badge>
                </div>
              </Link>
            );
          })}
        </div>
      )}
      <div className="mt-3">
        <Link href="/life/identity" className="text-sm font-medium text-brand hover:underline">
          + Add or manage identity records
        </Link>
      </div>
    </Section>
  );
}

/**
 * §27 "Health Logistics" (HLTH-001) manual add — mirrors AddEventForm's shape. `prepInstructions` here is
 * the user's own note (never AI-inferred), so there's no "only when sourced" constraint on this form the
 * way there is on the AI-extraction path.
 */
function AddHealthAppointmentForm({ onAdded }: { onAdded: () => void }) {
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
      <button onClick={() => setOpen(true)} className="text-sm font-medium text-brand hover:underline">
        + Add an appointment
      </button>
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
      setError(err instanceof ApiError ? err.message : "Couldn't add that appointment.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex flex-wrap items-end gap-2">
          <Input value={providerName} onChange={(e) => setProviderName(e.target.value)} placeholder="Provider (e.g. Dr. Chen)" className="min-w-[180px] flex-1" maxLength={200} />
          <Input value={appointmentType} onChange={(e) => setAppointmentType(e.target.value)} placeholder="Type (e.g. dental)" className="w-40" maxLength={120} />
          <Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className="w-56" />
        </div>
        <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Location (optional)" className="max-w-sm" />
        <textarea
          value={prepInstructions}
          onChange={(e) => setPrepInstructions(e.target.value)}
          placeholder="Prep notes, e.g. 'bring insurance card' (optional)"
          maxLength={2000}
          rows={2}
          className="w-full rounded-lg border border-border-default bg-surface px-3 py-2 text-sm text-primary"
        />
        <p className="text-xs text-tertiary">Private by default — only you can see this unless you share it below.</p>
        <div className="flex gap-2">
          <Button onClick={submit} loading={submitting} disabled={!start}>
            Add
          </Button>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
        {error && <p className="text-sm text-critical">{error}</p>}
      </CardBody>
    </Card>
  );
}

/** HLTH-003 "medication refill reminder" — deliberately thin: no dose/frequency field exists to fill in. */
function AddRefillReminderForm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [medicationName, setMedicationName] = useState("");
  const [nextRefillDate, setNextRefillDate] = useState("");
  const [pharmacy, setPharmacy] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-sm font-medium text-brand hover:underline">
        + Add a refill reminder
      </button>
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
      setError(err instanceof ApiError ? err.message : "Couldn't add that reminder.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardBody className="flex flex-wrap items-end gap-2">
        <Input value={medicationName} onChange={(e) => setMedicationName(e.target.value)} placeholder="Medication name" className="min-w-[160px] flex-1" maxLength={200} />
        <Input type="date" value={nextRefillDate} onChange={(e) => setNextRefillDate(e.target.value)} className="w-40" />
        <Input value={pharmacy} onChange={(e) => setPharmacy(e.target.value)} placeholder="Pharmacy (optional)" className="min-w-[160px]" maxLength={200} />
        <Button onClick={submit} loading={submitting} disabled={!medicationName.trim() || !nextRefillDate}>
          Add
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        {error && <p className="w-full text-sm text-critical">{error}</p>}
      </CardBody>
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">{title}</h2>
      {children}
    </section>
  );
}

export default function LifePage() {
  const { user } = useSession();
  const maskedMoney = useMaskedMoney();
  const { data: events, error: eventsError, isLoading: loadingEvents, mutate: mutateEvents } = useSWR<EventRow[]>("/v1/events", swrFetcher);
  const { data: allTasks, error: tasksError, isLoading: loadingTasks, mutate: mutateTasks } = useSWR<TaskRow[]>("/v1/tasks", swrFetcher);
  // CAL-003 — unresolved conflicts for this page's conflict banner.
  const { data: conflicts, mutate: mutateConflicts } = useSWR<ScheduleConflict[]>("/v1/schedule-conflicts", swrFetcher);
  // GET /v1/tasks returns every task regardless of state (no completed/dismissed filter server-side) —
  // same client-side filter apps/mobile's own Life screen already applies for the identical reason.
  const tasks = allTasks?.filter((t) => t.state !== "completed" && t.state !== "dismissed");
  const [completingTaskId, setCompletingTaskId] = useState<string | null>(null);
  // This page's task/return/store-credit actions previously had no try/catch at all — a failed request
  // (stale row, dropped connection) silently did nothing but revert on the next revalidation, with no
  // indication anything went wrong. One banner for the whole page, same styling every other page's
  // top-level error uses.
  const [actionError, setActionError] = useState<string | null>(null);

  async function respondToAssignment(id: string, decision: "accept" | "decline") {
    setActionError(null);
    try {
      await api.post(`/v1/tasks/${id}/${decision}`);
      mutateTasks();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't record that response.");
    }
  }

  async function completeTask(id: string) {
    setCompletingTaskId(id);
    setActionError(null);
    try {
      await api.post(`/v1/tasks/${id}/complete`);
      mutateTasks();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't complete that task.");
    } finally {
      setCompletingTaskId(null);
    }
  }
  const { data: purchases, error: purchasesError, isLoading: loadingPurchases, mutate: mutatePurchases } = useSWR<Purchase[]>("/v1/purchases", swrFetcher);
  const { data: allReturns, error: returnsError, isLoading: loadingReturns, mutate: mutateReturns } = useSWR<ReturnRow[]>("/v1/returns", swrFetcher);
  // GET /v1/returns returns every return case regardless of state (no "still open" filter server-side,
  // same shape as /v1/tasks above) — without this, a case marked "resolved" (or, now that §40.3's real
  // return state machine exists, "refunded"/"exchanged"/"disputed"/"closed") would keep sitting in this
  // "No open returns"-titled section forever, deadline badge and "Mark refunded" button included.
  const returns = allReturns?.filter((r) => !RETURN_TERMINAL_STATES.has(r.returnCase.state));
  const { data: shipments, error: shipmentsError, isLoading: loadingShipments, mutate: mutateShipments } = useSWR<ShipmentRow[]>("/v1/shipments", swrFetcher);
  const { data: subscriptions, error: subsError, isLoading: loadingSubs, mutate: mutateSubs } = useSWR<SubscriptionRow[]>("/v1/subscriptions", swrFetcher);
  const { data: bills, error: billsError, isLoading: loadingBills, mutate: mutateBills } = useSWR<BillRow[]>("/v1/bills", swrFetcher);
  const { data: warranties, error: warrantiesError, isLoading: loadingWarranties, mutate: mutateWarranties } = useSWR<Warranty[]>("/v1/warranties", swrFetcher);
  const { data: properties, isLoading: loadingProperties, mutate: mutateProperties } = useSWR<PropertyProfile[]>("/v1/properties", swrFetcher);
  const { data: vehicles, isLoading: loadingVehicles, mutate: mutateVehicles } = useSWR<VehicleProfile[]>("/v1/vehicles", swrFetcher);
  // §40.1/40.2 "Entity Resolution" — same "Review possible duplicates" link pattern as PeopleSection's own
  // /v1/people/merge-candidates hook.
  const { data: propertyMergeCandidates } = useSWR<{ propertyIds: string[] }[]>("/v1/properties/merge-candidates", swrFetcher);
  const { data: vehicleMergeCandidates } = useSWR<{ vehicleIds: string[] }[]>("/v1/vehicles/merge-candidates", swrFetcher);
  const { data: storeCredits, isLoading: loadingStoreCredits, mutate: mutateStoreCredits } = useSWR<StoreCredit[]>("/v1/store-credits", swrFetcher);
  const { data: savings, mutate: mutateSavings } = useSWR<SavingsSummary>("/v1/savings-summary", swrFetcher);
  const { data: monthlySpend, mutate: mutateMonthlySpend } = useSWR<MonthlySpendSummary>("/v1/monthly-spend-summary", swrFetcher);
  const { data: healthAppointments, error: healthAppointmentsError, isLoading: loadingHealthAppointments, mutate: mutateHealthAppointments } = useSWR<HealthAppointment[]>("/v1/health/appointments", swrFetcher);
  const { data: refillReminders, error: refillRemindersError, isLoading: loadingRefillReminders, mutate: mutateRefillReminders } = useSWR<RefillReminder[]>("/v1/health/refill-reminders", swrFetcher);
  const openRefillReminders = refillReminders?.filter((r) => !r.pickedUpAt);
  const [sharingAppointmentId, setSharingAppointmentId] = useState<string | null>(null);
  // CAL-001 — which cross-source-linked appointment card (if any) currently has its "N sources" disclosure open.
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  // Which of this page's grouped section tabs is selected — "all" (the default) renders every section
  // below in their original order, matching this page's behavior before tabs existed.
  const [lifeTab, setLifeTab] = useSectionTabs(LIFE_TABS, "all");
  const showSchedule = lifeTab === "all" || lifeTab === "schedule";
  const showMoney = lifeTab === "all" || lifeTab === "money";
  const showHomeVehicles = lifeTab === "all" || lifeTab === "home_vehicles";
  const showFamily = lifeTab === "all" || lifeTab === "family";
  const showHealth = lifeTab === "all" || lifeTab === "health";
  const showDocuments = lifeTab === "all" || lifeTab === "documents";

  // A single page-level retry affordance for this page's many independent, section-scoped fetches —
  // previously a failed one of these just rendered that section's empty state (indistinguishable from a
  // genuinely empty account) with no way to tell "nothing here" from "the request failed."
  const anySectionError = Boolean(eventsError || tasksError || purchasesError || returnsError || shipmentsError || subsError || billsError || warrantiesError || healthAppointmentsError || refillRemindersError);
  function retryAllSections() {
    mutateEvents();
    mutateTasks();
    mutatePurchases();
    mutateReturns();
    mutateShipments();
    mutateSubs();
    mutateBills();
    mutateWarranties();
  }

  async function redeemStoreCredit(id: string) {
    setActionError(null);
    try {
      await api.post(`/v1/store-credits/${id}/redeem`);
      mutateStoreCredits();
      mutateSavings();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't mark that store credit redeemed.");
    }
  }

  async function resolveReturn(id: string) {
    setActionError(null);
    try {
      await api.post(`/v1/returns/${id}/resolve`);
      mutateReturns();
      mutateSavings();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't mark that return refunded.");
    }
  }

  async function markRefillPickedUp(id: string) {
    setActionError(null);
    try {
      await api.post(`/v1/health/refill-reminders/${id}/picked-up`);
      mutateRefillReminders();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Couldn't mark that refill picked up.");
    }
  }

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">Life</h1>
          <p className="mt-1 text-sm text-tertiary">Everything Veynlo knows you own, owe, and are due back.</p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/timeline"
            className="rounded-full border border-border-default px-3 py-1.5 text-sm font-medium text-secondary hover:bg-subtle"
          >
            Timeline →
          </Link>
          <Link
            href="/documents"
            className="rounded-full border border-border-default px-3 py-1.5 text-sm font-medium text-secondary hover:bg-subtle"
          >
            Documents →
          </Link>
          <Link
            href="/lists"
            className="rounded-full border border-border-default px-3 py-1.5 text-sm font-medium text-secondary hover:bg-subtle"
          >
            Lists →
          </Link>
          <Link
            href="/saved"
            className="rounded-full border border-border-default px-3 py-1.5 text-sm font-medium text-secondary hover:bg-subtle"
          >
            Saved →
          </Link>
          <Link
            href="/trips"
            className="rounded-full border border-border-default px-3 py-1.5 text-sm font-medium text-secondary hover:bg-subtle"
          >
            Trips →
          </Link>
        </div>
      </header>

      <SectionTabs aria-label="Life sections" value={lifeTab} onChange={setLifeTab} options={LIFE_TABS} />

      {actionError && (
        <p role="alert" className="rounded-lg bg-critical-subtle px-3 py-2 text-sm text-critical-subtle-text">
          {actionError}
        </p>
      )}

      {anySectionError && (
        <FetchError what="some sections of this page" message="One or more sections below may be incomplete." onRetry={retryAllSections} />
      )}

      {conflicts && conflicts.length > 0 && (
        <ConflictBanner conflicts={conflicts} events={events} onResolved={() => mutateConflicts()} />
      )}

      {savings && (savings.resolvedReturnsMinorUnits > 0 || savings.redeemedStoreCreditsMinorUnits > 0 || savings.outstandingStoreCreditsMinorUnits > 0) && (
        <Card>
          <CardBody className="flex flex-wrap gap-6">
            <div>
              <p className="text-xs text-tertiary">Money saved from returns</p>
              <p className="text-lg font-semibold text-primary">{maskedMoney(savings.resolvedReturnsMinorUnits, "USD")}</p>
            </div>
            <div>
              <p className="text-xs text-tertiary">Store credits redeemed</p>
              <p className="text-lg font-semibold text-primary">{maskedMoney(savings.redeemedStoreCreditsMinorUnits, "USD")}</p>
            </div>
            <div>
              <p className="text-xs text-tertiary">Store credits available</p>
              <p className="text-lg font-semibold text-primary">{maskedMoney(savings.outstandingStoreCreditsMinorUnits, "USD")}</p>
            </div>
          </CardBody>
        </Card>
      )}

      {monthlySpend && <SafeSpendCard summary={monthlySpend} onCapSaved={() => mutateMonthlySpend()} />}

      {showSchedule && (
      <Section title="Appointments">
        {loadingEvents && <div className="h-16 animate-pulse rounded-xl bg-subtle" />}
        {!loadingEvents && (!events || events.length === 0) && (
          <EmptyState title="No upcoming appointments" description="Appointments and events discovered from email or a connected calendar will show up here." />
        )}
        {events && events.length > 0 && (
          <div className="divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface">
            {events.map((e) => {
              const when = formatTemporal(e.start);
              // CAL-001 "duplicate copies visually collapse while preserving original records" — this card
              // itself plus any cross-source-linked duplicates collapse into ONE list row with a "N sources"
              // disclosure, rather than each independently-discovered copy of the same real-world
              // appointment showing up as its own separate row forever. Neither underlying record is ever
              // deleted or merged — expanding just lists both (or more), each still linking through to its
              // own independent detail page.
              const memberCount = 1 + e.linkedEvents.length;
              const expanded = expandedEventId === e.id;
              return (
                <div key={e.id}>
                  <div className="flex items-center justify-between gap-2 px-4 py-3 hover:bg-subtle">
                    <Link href={`/life/events/${e.id}`} className="min-w-0 flex-1">
                      <p className="break-words text-sm font-medium text-primary">{e.title}</p>
                      {e.location && <p className="text-xs text-tertiary">{e.location}</p>}
                      {e.recurrenceRule && (
                        <p className="text-xs text-tertiary">
                          {describeRecurrence(e.recurrenceRule)}
                          {e.nextOccurrences.length > 0 && ` — also ${e.nextOccurrences.slice(0, 3).join(", ")}`}
                        </p>
                      )}
                    </Link>
                    <div className="flex shrink-0 items-center gap-2">
                      {when && <p className="text-sm text-tertiary">{when}</p>}
                      {memberCount > 1 && (
                        <button
                          type="button"
                          onClick={() => setExpandedEventId(expanded ? null : e.id)}
                          className="rounded-full border border-border-subtle px-2 py-0.5 text-xs font-medium text-tertiary hover:bg-surface"
                        >
                          {memberCount} sources
                        </button>
                      )}
                    </div>
                  </div>
                  {memberCount > 1 && expanded && (
                    <div className="space-y-1 bg-subtle px-4 py-2">
                      {[{ id: e.id, title: e.title, providerEventId: e.providerEventId }, ...e.linkedEvents].map((member) => (
                        <Link key={member.id} href={`/life/events/${member.id}`} className="flex items-center justify-between gap-2 rounded-md px-2 py-1 text-xs hover:bg-surface">
                          <span className="shrink-0 text-tertiary">{member.providerEventId ? "Synced calendar" : "Discovered from email"}</span>
                          <span className="min-w-0 truncate text-right text-primary">{member.title}</span>
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div className="mt-3">
          <AddEventForm onAdded={() => mutateEvents()} />
        </div>
      </Section>
      )}

      {showSchedule && (
      <Section title="Reminders">
        {loadingTasks && <div className="h-16 animate-pulse rounded-xl bg-subtle" />}
        {!loadingTasks && (!tasks || tasks.length === 0) && (
          <EmptyState title="No open reminders" description="Sync a Reminders app from Connections, or tasks discovered elsewhere will show up here." />
        )}
        {tasks && tasks.length > 0 && (
          <div className="divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface">
            {tasks.map((t) => {
              const when = t.dueCondition ? formatTemporal(t.dueCondition) : null;
              const awaitingMyDecision = t.assignmentStatus === "pending" && t.assignedToUserId === user?.id;
              return (
                <div key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium text-primary">{t.title}</p>
                    <div className="mt-0.5 flex items-center gap-2">
                      {when && <p className="text-xs text-tertiary">{when}</p>}
                      {t.assignmentStatus === "declined" && t.ownerUserId === user?.id && <Badge tone="critical">Declined</Badge>}
                    </div>
                    {t.recurrenceRule && <p className="text-xs text-tertiary">{describeRecurrence(t.recurrenceRule)}</p>}
                  </div>
                  {awaitingMyDecision ? (
                    <div className="flex shrink-0 gap-2">
                      <Button size="sm" onClick={() => respondToAssignment(t.id, "accept")}>
                        Accept
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => respondToAssignment(t.id, "decline")}>
                        Decline
                      </Button>
                    </div>
                  ) : (
                    <Button size="sm" variant="secondary" loading={completingTaskId === t.id} onClick={() => completeTask(t.id)}>
                      Done
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div className="mt-3">
          <AddTaskForm onAdded={() => mutateTasks()} />
        </div>
      </Section>
      )}

      {showMoney && (
      <Section title="Returns">
        {loadingReturns && <div className="h-16 animate-pulse rounded-xl bg-subtle" />}
        {!loadingReturns && (!returns || returns.length === 0) && (
          <EmptyState title="No open returns" description="When a return window is closing, it'll show up here with the deadline and value at stake." />
        )}
        {returns && returns.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2">
            {returns.map((r) => {
              const days = daysUntil(r.returnCase.deadline);
              const value = maskedMoney(r.returnCase.valueAtStakeMinorUnits, r.returnCase.valueAtStakeCurrency);
              return (
                <Card key={r.returnCase.id} className="transition-colors hover:bg-subtle">
                  <CardBody className="space-y-1.5">
                    <Link href={`/life/returns/${r.returnCase.id}`} className="block space-y-1.5">
                      <div className="flex items-center justify-between">
                        <p className="min-w-0 break-words text-sm font-medium text-primary">Order {r.purchase.orderNumber ?? "—"}</p>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {/* §40.3 Return state machine — only shown once a return has actually moved past the
                              default "eligible" (still-within-window, nothing done yet) state, so the common
                              case isn't cluttered with a redundant "Eligible" badge next to the deadline one. */}
                          {r.returnCase.state !== "eligible" && (
                            <Badge tone={RETURN_STATE_TONE[r.returnCase.state] ?? "neutral"}>{r.returnCase.state.replace(/_/g, " ")}</Badge>
                          )}
                          {days != null && (
                            <Badge tone={days <= 3 ? "critical" : "warning"}>{days > 0 ? `${days}d left` : "Due today"}</Badge>
                          )}
                        </div>
                      </div>
                      {value && <p className="text-lg font-semibold text-primary">{value}</p>}
                    </Link>
                    <Button size="sm" variant="secondary" onClick={() => resolveReturn(r.returnCase.id)}>
                      Mark refunded
                    </Button>
                  </CardBody>
                </Card>
              );
            })}
          </div>
        )}
      </Section>
      )}

      {showSchedule && (
      <Section title="Shipments">
        {loadingShipments && <div className="h-16 animate-pulse rounded-xl bg-subtle" />}
        {!loadingShipments && (!shipments || shipments.length === 0) && (
          <EmptyState title="No shipments tracked yet" description="Order confirmations and tracking updates will show up here automatically." />
        )}
        {shipments && shipments.length > 0 && (
          <div className="divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface">
            {shipments.map((s) => {
              const estimated = s.shipment.estimatedDelivery ? formatTemporal(s.shipment.estimatedDelivery) : null;
              return (
                <Link
                  key={s.shipment.id}
                  href={`/life/shipments/${s.shipment.id}`}
                  className="flex items-center justify-between px-4 py-3 hover:bg-subtle"
                >
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium text-primary">{s.shipment.carrier}</p>
                    <p className="break-words font-mono text-xs text-tertiary">{s.shipment.trackingNumber}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <Badge tone={SHIPMENT_STATUS_TONE[s.shipment.status] ?? "neutral"}>{s.shipment.status.replace(/_/g, " ")}</Badge>
                    {estimated && <p className="mt-1 text-xs text-tertiary">Est. {estimated}</p>}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </Section>
      )}

      {showMoney && (
      <Section title="Store credits">
        {loadingStoreCredits && <div className="h-16 animate-pulse rounded-xl bg-subtle" />}
        {!loadingStoreCredits && (!storeCredits || storeCredits.length === 0) && (
          <EmptyState title="No store credits tracked yet" description="Store credits found in email, or added manually, will show up here with their expiration date." />
        )}
        {storeCredits && storeCredits.length > 0 && (
          <div className="divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface">
            {storeCredits.map((c) => {
              const expires = formatTemporal(c.expirationDate);
              const amount = maskedMoney(c.amountMinorUnits, c.currency);
              return (
                <div key={c.id} className="flex items-center justify-between px-4 py-3">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium text-primary">{c.merchantName ?? "Unknown merchant"}</p>
                    {expires && <p className="text-xs text-tertiary">Expires {expires}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <p className="break-words text-sm font-medium text-primary">{amount}</p>
                    {c.redeemed ? (
                      <Badge tone="neutral">Redeemed</Badge>
                    ) : (
                      <Button size="sm" variant="secondary" onClick={() => redeemStoreCredit(c.id)}>
                        Mark redeemed
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div className="mt-3">
          <AddStoreCreditForm onAdded={() => mutateStoreCredits()} />
        </div>
      </Section>
      )}

      {showMoney && (
      <Section title="Subscriptions">
        {loadingSubs && <div className="h-16 animate-pulse rounded-xl bg-subtle" />}
        {!loadingSubs && (!subscriptions || subscriptions.length === 0) && (
          <EmptyState title="No subscriptions detected yet" description="Connect email or a financial account and Veynlo will find recurring charges automatically." />
        )}
        {subscriptions && subscriptions.length > 0 && (
          <div className="divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface">
            {subscriptions.map((s) => {
              const amount = maskedMoney(s.stream.typicalAmountMinorUnits, s.stream.typicalAmountCurrency);
              // SUB-002 — a trial previously looked identical to any other subscription in this list
              // beyond the badge color alone; surfacing the actual end date is the difference between
              // "informational" and "something to decide on."
              const trialEnds = s.subscription.state === "trial" ? formatTemporal(s.subscription.trialEndsAt) : null;
              return (
                <Link
                  key={s.subscription.id}
                  href={`/life/subscriptions/${s.subscription.id}`}
                  className="flex items-center justify-between px-4 py-3 hover:bg-subtle"
                >
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium text-primary">{s.stream.serviceLabel}</p>
                    <p className="text-xs text-tertiary capitalize">{s.stream.cadence}</p>
                    {trialEnds && <p className="text-xs text-tertiary">Trial ends {trialEnds}</p>}
                  </div>
                  <div className="shrink-0 text-right">
                    {amount && <p className="break-words text-sm font-medium text-primary">{amount}</p>}
                    <Badge tone={SUBSCRIPTION_STATE_TONE[s.subscription.state] ?? "neutral"}>
                      {s.subscription.state.replace(/_/g, " ")}
                    </Badge>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </Section>
      )}

      {showMoney && (
      <Section title="Bills">
        {loadingBills && <div className="h-16 animate-pulse rounded-xl bg-subtle" />}
        {!loadingBills && (!bills || bills.length === 0) && (
          <EmptyState title="No bills detected yet" description="Bills discovered from email or connected accounts will appear here with due dates." />
        )}
        {bills && bills.length > 0 && (
          <div className="divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface">
            {bills.map((b) => {
              const due = formatTemporal(b.bill.dueDate);
              const amount = maskedMoney(b.bill.amountDueMinorUnits, b.bill.amountDueCurrency);
              return (
                <Link key={b.bill.id} href={`/life/bills/${b.bill.id}`} className="flex items-center justify-between px-4 py-3 hover:bg-subtle">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium text-primary">{b.bill.billerLabel}</p>
                    {due && <p className="text-xs text-tertiary">Due {due}</p>}
                  </div>
                  <div className="shrink-0 text-right">
                    {amount && <p className="break-words text-sm font-medium text-primary">{amount}</p>}
                    {/* BILL-002 — "likely handled" vs "due" at a glance, without opening the detail page. */}
                    {b.bill.paymentObservedTransactionId && (
                      <Badge tone="positive">Paid</Badge>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </Section>
      )}

      {showMoney && (
      <Section title="Warranties">
        {loadingWarranties && <div className="h-16 animate-pulse rounded-xl bg-subtle" />}
        {!loadingWarranties && (!warranties || warranties.length === 0) && (
          <EmptyState title="No warranties tracked yet" description="Warranties found in email will show up here with their expiration date." />
        )}
        {warranties && warranties.length > 0 && (
          <div className="divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface">
            {warranties.map((w) => {
              const days = daysUntil(w.expirationDate);
              const expires = formatTemporal(w.expirationDate);
              return (
                <Link key={w.id} href={`/life/warranties/${w.id}`} className="flex items-center justify-between px-4 py-3 hover:bg-subtle">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium text-primary">{w.productLabel}</p>
                    {expires && <p className="text-xs text-tertiary">Expires {expires}</p>}
                  </div>
                  {days != null && (
                    <Badge tone={days <= 30 ? "warning" : "neutral"}>{days > 0 ? `${days}d left` : "Expired"}</Badge>
                  )}
                </Link>
              );
            })}
          </div>
        )}
      </Section>
      )}

      {showHomeVehicles && (
      <Section title="Home">
        {loadingProperties && <div className="h-16 animate-pulse rounded-xl bg-subtle" />}
        {!loadingProperties && (!properties || properties.length === 0) && (
          <EmptyState title="No properties added yet" description="Add a home or rental to track its warranties and service history in one place." />
        )}
        {properties && properties.length > 0 && (
          <div className="divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface">
            {properties.map((p) => (
              <Link key={p.id} href={`/life/properties/${p.id}`} className="flex items-center justify-between px-4 py-3 hover:bg-subtle">
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium text-primary">{p.label}</p>
                  {p.address && <p className="break-words text-xs text-tertiary">{p.address}</p>}
                </div>
                <span className="shrink-0 text-xs capitalize text-tertiary">{p.propertyType}</span>
              </Link>
            ))}
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <AddPropertyForm onAdded={() => mutateProperties()} />
          <Link href="/life/properties/merge" className="text-sm font-medium text-brand hover:underline">
            Review possible duplicates{propertyMergeCandidates && propertyMergeCandidates.length > 0 ? ` (${propertyMergeCandidates.length})` : ""}
          </Link>
        </div>
      </Section>
      )}

      {showHomeVehicles && (
      <Section title="Vehicles">
        {loadingVehicles && <div className="h-16 animate-pulse rounded-xl bg-subtle" />}
        {!loadingVehicles && (!vehicles || vehicles.length === 0) && (
          <EmptyState title="No vehicles added yet" description="Add a vehicle to track its warranties and maintenance history in one place." />
        )}
        {vehicles && vehicles.length > 0 && (
          <div className="divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface">
            {vehicles.map((v) => (
              <Link key={v.id} href={`/life/vehicles/${v.id}`} className="flex items-center justify-between px-4 py-3 hover:bg-subtle">
                <p className="min-w-0 break-words text-sm font-medium text-primary">{v.label}</p>
                {(v.make || v.model || v.year) && (
                  <span className="shrink-0 text-xs text-tertiary">{[v.year, v.make, v.model].filter(Boolean).join(" ")}</span>
                )}
              </Link>
            ))}
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <AddVehicleForm onAdded={() => mutateVehicles()} />
          <Link href="/life/vehicles/merge" className="text-sm font-medium text-brand hover:underline">
            Review possible duplicates{vehicleMergeCandidates && vehicleMergeCandidates.length > 0 ? ` (${vehicleMergeCandidates.length})` : ""}
          </Link>
        </div>
      </Section>
      )}

      {showFamily && <SchoolSection />}

      {showFamily && <PetsSection />}

      {showFamily && <PeopleSection />}

      {showMoney && (
      <Section title="Purchases">
        {loadingPurchases && <div className="h-16 animate-pulse rounded-xl bg-subtle" />}
        {!loadingPurchases && (!purchases || purchases.length === 0) && (
          <EmptyState title="No purchases yet" description="Connect email or scan a receipt and Veynlo will organize your purchases automatically." />
        )}
        {purchases && purchases.length > 0 && (
          <div className="divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface">
            {purchases.map((p) => {
              const date = formatTemporal(p.purchaseDate);
              const total = maskedMoney(p.totalMinorUnits, p.totalCurrency);
              return (
                <Link key={p.id} href={`/life/purchases/${p.id}`} className="flex items-center justify-between px-4 py-3 hover:bg-subtle">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium text-primary">Order {p.orderNumber ?? "—"}</p>
                    {date && <p className="text-xs text-tertiary">{date}</p>}
                  </div>
                  {total && <p className="shrink-0 text-sm font-medium text-primary">{total}</p>}
                </Link>
              );
            })}
          </div>
        )}
      </Section>
      )}

      {showHealth && (
      <Section title="Health">
        {/* §27 "Health Logistics (Non-Diagnostic)" — logistics only: provider/when/where/prep-instructions-
            when-sourced. Never a symptom, diagnosis, or medication dose — see HealthLogisticsService's own
            doc comment for the private-by-default access model behind this section. */}
        <p className="-mt-1 mb-3 text-xs text-tertiary">
          Private by default — a household member can&apos;t see these unless you share them individually below.
        </p>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-tertiary">Appointments</p>
        {loadingHealthAppointments && <div className="h-16 animate-pulse rounded-xl bg-subtle" />}
        {!loadingHealthAppointments && (!healthAppointments || healthAppointments.length === 0) && (
          <EmptyState title="No upcoming health appointments" description="Appointments discovered from email, or added manually, will show up here — provider, date, and location only." />
        )}
        {healthAppointments && healthAppointments.length > 0 && (
          <div className="divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface">
            {healthAppointments.map((a) => {
              const when = formatTemporal(a.dateTime);
              return (
                <div key={a.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="break-words text-sm font-medium text-primary">{a.providerName ?? a.appointmentType ?? "Appointment"}</p>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2">
                        {a.appointmentType && a.providerName && <span className="text-xs capitalize text-tertiary">{a.appointmentType}</span>}
                        {a.location && <span className="break-words text-xs text-tertiary">{a.location}</span>}
                      </div>
                      {a.prepInstructions && <p className="mt-1 break-words text-xs text-secondary">Prep: {a.prepInstructions}</p>}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {when && <p className="text-sm text-tertiary">{when}</p>}
                      <Badge tone={a.visibility === "private" ? "neutral" : "info"}>{a.visibility === "private" ? "Private" : "Household"}</Badge>
                      {/* HLTH-001 — links/tasks/bills/document-attach and "export this appointment's packet"
                          all live on the standalone detail page, not crammed into this inline card. */}
                      <Link href={`/life/health-appointments/${a.id}`} className="text-sm text-brand hover:underline">
                        Details
                      </Link>
                      <Button size="sm" variant="ghost" onClick={() => setSharingAppointmentId(sharingAppointmentId === a.id ? null : a.id)}>
                        Share
                      </Button>
                    </div>
                  </div>
                  {sharingAppointmentId === a.id && (
                    <div className="mt-2">
                      <ShareResourcePanel resourceId={a.id} collectionPath="/v1/health/appointments" resourceLabel="appointment" />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div className="mt-3">
          <AddHealthAppointmentForm onAdded={() => mutateHealthAppointments()} />
        </div>

        <p className="mb-2 mt-6 text-xs font-medium uppercase tracking-wide text-tertiary">Refill reminders</p>
        {loadingRefillReminders && <div className="h-16 animate-pulse rounded-xl bg-subtle" />}
        {!loadingRefillReminders && (!openRefillReminders || openRefillReminders.length === 0) && (
          <EmptyState title="No refill reminders" description="Add a medication refill or pickup reminder — just a name, a date, and an optional pharmacy." />
        )}
        {openRefillReminders && openRefillReminders.length > 0 && (
          <div className="divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface">
            {openRefillReminders.map((r) => {
              const when = formatTemporal(r.nextRefillDate);
              return (
                <div key={r.id} className="flex items-center justify-between px-4 py-3">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium text-primary">{r.medicationName}</p>
                    <div className="mt-0.5 flex items-center gap-2">
                      {when && <p className="text-xs text-tertiary">Refill by {when}</p>}
                      {r.pharmacy && <p className="text-xs text-tertiary">{r.pharmacy}</p>}
                    </div>
                  </div>
                  <Button size="sm" variant="secondary" className="shrink-0" onClick={() => markRefillPickedUp(r.id)}>
                    Mark picked up
                  </Button>
                </div>
              );
            })}
          </div>
        )}
        <div className="mt-3">
          <AddRefillReminderForm onAdded={() => mutateRefillReminders()} />
        </div>
      </Section>
      )}

      {showDocuments && <IdentityRecordsSection />}
    </div>
  );
}
