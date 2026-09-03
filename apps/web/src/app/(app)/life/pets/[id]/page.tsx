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
import { EvidenceCard, type Evidence } from "@/components/evidence-card";

interface PetDetail {
  pet: {
    id: string;
    label: string;
    species: string | null;
    breed: string | null;
    birthDate: TemporalValueLike | null;
    microchipNumber: string | null;
    vetProviderName: string | null;
    insuranceProviderName: string | null;
    insurancePolicyNumber: string | null;
    lifecycleStatus: "active" | "deceased" | "transferred";
    householdId: string | null;
  };
  vaccinations: Array<{ id: string; label: string; expirationDate: TemporalValueLike | null; source: "user_confirmed" | "evidence_sourced"; evidence: Evidence | null }>;
  maintenance: Array<{ id: string; description: string; serviceDate: TemporalValueLike; costMinorUnits: number | null; costCurrency: string | null }>;
  refillReminders: Array<{ id: string; medicationName: string; nextRefillDate: TemporalValueLike; pharmacy: string | null; pickedUpAt: string | null }>;
  bills: Array<{ id: string; billerLabel: string; amountDueMinorUnits: number | null; amountDueCurrency: string | null; dueDate: TemporalValueLike }>;
  sharedNote: string | null;
}

/** PET-004 — a manual vaccination/license add, mirroring the vehicle detail page's AddRecord shape. */
function AddVaccinationForm({ petId, onAdded }: { petId: string; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [expirationDate, setExpirationDate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-sm font-medium text-brand hover:underline">
        + Add a vaccination/license
      </button>
    );
  }

  async function submit() {
    if (!label.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/v1/pets/${petId}/vaccinations`, { label, expirationDateIso: expirationDate || undefined });
      setLabel("");
      setExpirationDate("");
      setOpen(false);
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that record.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2 border-t border-border-subtle pt-3">
      <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Rabies, City license" className="min-w-[180px] flex-1" />
      <div className="w-40 shrink-0">
        <Input type="date" value={expirationDate} onChange={(e) => setExpirationDate(e.target.value)} />
      </div>
      <Button onClick={submit} loading={submitting} disabled={!label.trim()}>
        Add
      </Button>
      <Button variant="secondary" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      {error && <p className="w-full text-sm text-critical">{error}</p>}
    </div>
  );
}

/** AI-001 "why am I seeing this?" — a discovered (evidence_sourced) vaccination can show its source
 * email; a manually-entered (user_confirmed) one has no evidence to show and gets no disclosure at all. */
function VaccinationRow({ vaccination }: { vaccination: PetDetail["vaccinations"][number] }) {
  const [showEvidence, setShowEvidence] = useState(false);
  const days = vaccination.expirationDate ? daysUntil(vaccination.expirationDate) : null;
  return (
    <div className="border-t border-border-subtle py-2 text-sm first:border-t-0">
      <div className="flex items-center justify-between">
        <div>
          <span className="text-primary">{vaccination.label}</span>
          {vaccination.source === "evidence_sourced" && <span className="ml-2 text-xs text-tertiary">(awaiting confirmation in Inbox)</span>}
          {vaccination.evidence && (
            <button onClick={() => setShowEvidence((v) => !v)} className="ml-2 text-xs font-medium text-brand hover:underline">
              {showEvidence ? "Hide why" : "Why am I seeing this?"}
            </button>
          )}
        </div>
        {days != null && <Badge tone={days <= 30 ? "warning" : "neutral"}>{days > 0 ? `${days}d left` : "Expired"}</Badge>}
      </div>
      {showEvidence && (
        <div className="mt-2">
          <EvidenceCard evidence={vaccination.evidence} />
        </div>
      )}
    </div>
  );
}

/** PET-003 — plain medication name + next refill date + pharmacy only, no dose/frequency field (see
 * refillReminders' own schema doc comment for the non-diagnostic boundary this reflects). */
function AddRefillReminderForm({ petId, onAdded }: { petId: string; onAdded: () => void }) {
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
      await api.post(`/v1/pets/${petId}/refill-reminders`, { medicationName, nextRefillDateIso: nextRefillDate, pharmacy: pharmacy || undefined });
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
    <div className="flex flex-wrap items-end gap-2 border-t border-border-subtle pt-3">
      <Input value={medicationName} onChange={(e) => setMedicationName(e.target.value)} placeholder="Medication name" className="min-w-[180px] flex-1" />
      <div className="w-40 shrink-0">
        <Input type="date" value={nextRefillDate} onChange={(e) => setNextRefillDate(e.target.value)} />
      </div>
      <Input value={pharmacy} onChange={(e) => setPharmacy(e.target.value)} placeholder="Pharmacy (optional)" className="min-w-[160px]" />
      <Button onClick={submit} loading={submitting} disabled={!medicationName.trim() || !nextRefillDate}>
        Add
      </Button>
      <Button variant="secondary" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      {error && <p className="w-full text-sm text-critical">{error}</p>}
    </div>
  );
}

/** PET-001 "attach records" — editable vet/insurance/microchip fields plus the "deceased pet archival,
 * transferred ownership" lifecycle status, none of which were settable anywhere but pet creation before. */
function EditPetDetailsForm({ pet, onSaved }: { pet: PetDetail["pet"]; onSaved: () => void }) {
  const [vetProviderName, setVetProviderName] = useState(pet.vetProviderName ?? "");
  const [insuranceProviderName, setInsuranceProviderName] = useState(pet.insuranceProviderName ?? "");
  const [insurancePolicyNumber, setInsurancePolicyNumber] = useState(pet.insurancePolicyNumber ?? "");
  const [microchipNumber, setMicrochipNumber] = useState(pet.microchipNumber ?? "");
  const [lifecycleStatus, setLifecycleStatus] = useState(pet.lifecycleStatus);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/v1/pets/${pet.id}`, {
        vetProviderName: vetProviderName || null,
        insuranceProviderName: insuranceProviderName || null,
        insurancePolicyNumber: insurancePolicyNumber || null,
        microchipNumber: microchipNumber || null,
        lifecycleStatus,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save these details.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Input value={vetProviderName} onChange={(e) => setVetProviderName(e.target.value)} placeholder="Vet provider" />
      <Input value={insuranceProviderName} onChange={(e) => setInsuranceProviderName(e.target.value)} placeholder="Insurance provider" />
      <Input value={insurancePolicyNumber} onChange={(e) => setInsurancePolicyNumber(e.target.value)} placeholder="Insurance policy number" />
      <Input value={microchipNumber} onChange={(e) => setMicrochipNumber(e.target.value)} placeholder="Microchip number" />
      <select
        value={lifecycleStatus}
        onChange={(e) => setLifecycleStatus(e.target.value as PetDetail["pet"]["lifecycleStatus"])}
        className="h-9 rounded-lg border border-border-default bg-surface px-2 text-sm text-primary"
      >
        <option value="active">Active</option>
        <option value="deceased">Deceased</option>
        <option value="transferred">Transferred</option>
      </select>
      <div className="flex items-center gap-2 sm:col-span-2">
        <Button size="sm" onClick={save} loading={saving}>
          Save details
        </Button>
        {error && <p className="text-sm text-critical">{error}</p>}
      </div>
    </div>
  );
}

export default function PetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data, error: fetchError, isLoading, mutate } = useSWR<PetDetail | null>(`/v1/pets/${id}`, swrFetcher);
  const [addingRecord, setAddingRecord] = useState(false);
  const [description, setDescription] = useState("");
  const [cost, setCost] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [editingDetails, setEditingDetails] = useState(false);

  if (isLoading) return <div className="h-40 animate-pulse rounded-xl bg-subtle" />;
  if (fetchError && !data) {
    return (
      <div className="space-y-6">
        <Link href="/life" className="text-sm text-tertiary hover:text-primary">
          ← Back to Life
        </Link>
        <FetchError what="this pet" message={fetchError instanceof ApiError ? fetchError.message : undefined} onRetry={() => mutate()} />
      </div>
    );
  }
  if (!data) return <EmptyState title="Not found" description="This pet doesn't exist or you don't have access to it." />;

  const { pet, vaccinations, maintenance, refillReminders, bills } = data;
  const subtitle = [pet.species, pet.breed].filter(Boolean).join(" · ");

  async function addRecord() {
    if (!description.trim()) return;
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
        petProfileId: id,
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

  async function markPickedUp(reminderId: string) {
    await api.post(`/v1/pet-refill-reminders/${reminderId}/mark-picked-up`);
    mutate();
  }

  async function remove() {
    if (!window.confirm(`Remove "${pet.label}"? Its vaccination, medication, and vet-visit history go with it — this can't be undone.`)) return;
    setDeleting(true);
    try {
      await api.delete(`/v1/pets/${id}`);
      router.push("/life");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      <Link href="/life" className="text-sm text-tertiary hover:text-primary">
        ← Back to Life
      </Link>
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">{pet.label}</h1>
          <p className="mt-1 text-sm text-tertiary">
            {subtitle}
            {pet.lifecycleStatus !== "active" && (
              <>
                {subtitle ? " — " : ""}
                <Badge tone="neutral">{pet.lifecycleStatus === "deceased" ? "Deceased" : "Transferred"}</Badge>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => setEditingDetails((s) => !s)}>
            Edit details
          </Button>
          <Button variant="ghost" onClick={() => setSharing((s) => !s)}>
            Share
          </Button>
          <Button variant="secondary" onClick={remove} loading={deleting}>
            Remove
          </Button>
        </div>
      </header>

      <SharedNoteBanner note={data.sharedNote} />

      {editingDetails && (
        <Card>
          <CardBody>
            <EditPetDetailsForm pet={pet} onSaved={() => { setEditingDetails(false); mutate(); }} />
          </CardBody>
        </Card>
      )}

      {!editingDetails && (pet.vetProviderName || pet.insuranceProviderName || pet.microchipNumber) && (
        <Card>
          <CardBody className="flex flex-wrap gap-6 text-sm">
            {pet.vetProviderName && (
              <div>
                <p className="text-xs text-tertiary">Vet</p>
                <p className="text-primary">{pet.vetProviderName}</p>
              </div>
            )}
            {pet.insuranceProviderName && (
              <div>
                <p className="text-xs text-tertiary">Insurance</p>
                <p className="text-primary">
                  {pet.insuranceProviderName}
                  {pet.insurancePolicyNumber && ` — ${pet.insurancePolicyNumber}`}
                </p>
              </div>
            )}
            {pet.microchipNumber && (
              <div>
                <p className="text-xs text-tertiary">Microchip</p>
                <p className="text-primary">{pet.microchipNumber}</p>
              </div>
            )}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardBody>
          <HouseholdAssignmentControl
            householdId={pet.householdId}
            onChange={async (next) => {
              await api.patch(`/v1/pets/${id}`, { householdId: next });
              await mutate();
            }}
          />
        </CardBody>
      </Card>

      {sharing && (
        <Card>
          <CardBody>
            <ShareResourcePanel resourceId={String(id)} collectionPath="/v1/pets" resourceLabel="pet" />
          </CardBody>
        </Card>
      )}

      <Card>
        <CardBody className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wide text-tertiary">Vaccinations &amp; licenses</p>
          </div>
          {vaccinations.length === 0 && <p className="text-sm text-tertiary">None recorded yet.</p>}
          {vaccinations.map((v) => (
            <VaccinationRow key={v.id} vaccination={v} />
          ))}
          <div className="pt-1">
            <AddVaccinationForm petId={String(id)} onAdded={() => mutate()} />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardBody className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-tertiary">Medication / refill reminders</p>
          {refillReminders.length === 0 && <p className="text-sm text-tertiary">None recorded yet.</p>}
          {refillReminders.map((r) => {
            const when = formatTemporal(r.nextRefillDate);
            return (
              <div key={r.id} className="flex items-center justify-between border-t border-border-subtle py-2 text-sm first:border-t-0">
                <div>
                  <p className="text-primary">
                    {r.medicationName}
                    {r.pharmacy && <span className="text-tertiary"> — {r.pharmacy}</span>}
                  </p>
                  {when && <p className="text-xs text-tertiary">Next refill {when}</p>}
                </div>
                {r.pickedUpAt ? (
                  <Badge tone="positive">Picked up</Badge>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => markPickedUp(r.id)}>
                    Mark picked up
                  </Button>
                )}
              </div>
            );
          })}
          <div className="pt-1">
            <AddRefillReminderForm petId={String(id)} onAdded={() => mutate()} />
          </div>
        </CardBody>
      </Card>

      {bills.length > 0 && (
        <Card>
          <CardBody className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-tertiary">Insurance &amp; vet bills</p>
            {bills.map((b) => {
              const due = formatTemporal(b.dueDate);
              const amount = formatMoneyMinorUnits(b.amountDueMinorUnits, b.amountDueCurrency);
              return (
                <Link key={b.id} href={`/life/bills/${b.id}`} className="flex items-center justify-between border-t border-border-subtle py-2 text-sm first:border-t-0 hover:text-brand">
                  <div>
                    <p className="text-primary">{b.billerLabel}</p>
                    {due && <p className="text-xs text-tertiary">Due {due}</p>}
                  </div>
                  {amount && <p className="text-primary">{amount}</p>}
                </Link>
              );
            })}
          </CardBody>
        </Card>
      )}

      <Card>
        <CardBody className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wide text-tertiary">Vet visits &amp; service history</p>
            {!addingRecord && (
              <button onClick={() => setAddingRecord(true)} className="text-sm font-medium text-brand hover:underline">
                + Add a record
              </button>
            )}
          </div>
          {maintenance.length === 0 && !addingRecord && <p className="text-sm text-tertiary">No visit history logged yet.</p>}
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
              <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Annual checkup" className="min-w-[180px] flex-1" />
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
