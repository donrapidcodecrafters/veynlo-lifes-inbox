"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import useSWR from "swr";
import { api, swrFetcher, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { EmptyState } from "@/components/ui/empty-state";
import { FetchError } from "@/components/ui/fetch-error";
import { ShareResourcePanel } from "@/components/sharing/share-resource-panel";
import { SharedNoteBanner } from "@/components/sharing/shared-note-banner";
import { formatTemporal, daysUntil, type TemporalValueLike } from "@/lib/format";
import { useSession } from "@/hooks/use-session";
import { PERSON_RELATIONSHIP_SUGGESTIONS, relationshipLabelText } from "@/lib/people";

interface PersonListRow {
  id: string;
  displayName: string;
}

interface OrganizationRow {
  id: string;
  name: string;
}

interface AliasRow {
  id: string;
  kind: "email" | "phone" | "name_variant";
  value: string;
}

interface ContactSourceRow {
  id: string;
  provider: string;
  syncedAt: string | null;
}

interface PersonNoteRow {
  id: string;
  authorUserId: string;
  body: string;
  createdAt: string;
}

interface ImportantDateRow {
  id: string;
  label: string;
  date: TemporalValueLike;
  isSensitive: boolean;
  reminderDaysBefore: number;
}

interface PersonRelationshipRow {
  id: string;
  fromPersonId: string;
  toPersonId: string | null;
  toDependentProfileId: string | null;
  label: string;
}

interface HouseholdDependentRow {
  id: string;
  displayName: string;
}

interface MyHouseholdRow {
  household: { id: string; name: string };
}

interface PersonDetail {
  person: {
    id: string;
    ownerUserId: string;
    householdId: string | null;
    displayName: string;
    organizationId: string | null;
    relationshipLabel: string | null;
    relationshipLabelSource: "user_set" | "suggested";
    isImportant: boolean;
    lastContactAt: string | null;
    visibility: "private" | "household" | "selected_people" | "shared_link";
    relatedEntityIds: string[];
  };
  organization: { id: string; name: string } | null;
  aliases: AliasRow[];
  contactSources: ContactSourceRow[];
  notes: PersonNoteRow[];
  importantDates: ImportantDateRow[];
  relationships: { from: PersonRelationshipRow[]; to: PersonRelationshipRow[] };
  linkedHistory: {
    bill: { id: string; billerLabel: string; dueDate: TemporalValueLike }[];
    document: { id: string; title: string; documentType: string }[];
    maintenanceRecord: { id: string; description: string; serviceDate: TemporalValueLike }[];
    calendarEvent: { id: string; title: string; start: TemporalValueLike }[];
    task: { id: string; title: string }[];
    warranty: { id: string; productLabel: string; expirationDate: TemporalValueLike }[];
    vehicle: { id: string; label: string }[];
    property: { id: string; label: string }[];
  };
  sharedNote: string | null;
}

/** PEO-001 "edit details" — displayName + organization + isImportant, mirroring EditPetDetailsForm's shape. */
function EditPersonForm({
  person,
  organizations,
  onSaved,
}: {
  person: PersonDetail["person"];
  organizations: OrganizationRow[] | undefined;
  onSaved: () => void;
}) {
  const [displayName, setDisplayName] = useState(person.displayName);
  const [organizationId, setOrganizationId] = useState(person.organizationId ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!displayName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/v1/people/${person.id}`, { displayName, organizationId: organizationId || null });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save these details.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Name" maxLength={200} />
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
      <div className="flex items-center gap-2 sm:col-span-2">
        <Button size="sm" onClick={save} loading={saving} disabled={!displayName.trim()}>
          Save details
        </Button>
        {error && <p className="text-sm text-critical">{error}</p>}
      </div>
    </div>
  );
}

/** PEO-003 relationship-label editor — quick-select chips over PERSON_RELATIONSHIP_SUGGESTIONS plus free
 * text (the label stays free text server-side — see people.ts's own schema doc comment), and a distinct
 * "Confirm" affordance when the current label is only "suggested" (PeopleService.confirmSuggestedRelationshipLabel
 * — never retypes the label, just flips its source to user_set). */
function RelationshipLabelEditor({ person, onSaved }: { person: PersonDetail["person"]; onSaved: () => void }) {
  const [value, setValue] = useState(person.relationshipLabel ?? "");
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!value.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/v1/people/${person.id}/relationship-label`, { relationshipLabel: value.trim() });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save that label.");
    } finally {
      setSaving(false);
    }
  }

  async function confirmSuggested() {
    setConfirming(true);
    setError(null);
    try {
      await api.post(`/v1/people/${person.id}/relationship-label/confirm`);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't confirm that suggestion.");
    } finally {
      setConfirming(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-tertiary">Relationship</p>
        {person.relationshipLabelSource === "suggested" && <Badge tone="warning">Suggested — not yet confirmed</Badge>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. dentist, sister" className="max-w-[240px]" maxLength={60} />
        <Button size="sm" variant="secondary" onClick={save} loading={saving} disabled={!value.trim() || value.trim() === person.relationshipLabel}>
          Save
        </Button>
        {person.relationshipLabelSource === "suggested" && person.relationshipLabel && (
          <Button size="sm" onClick={confirmSuggested} loading={confirming}>
            Confirm &quot;{relationshipLabelText(person.relationshipLabel)}&quot;
          </Button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {PERSON_RELATIONSHIP_SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setValue(s)}
            className="rounded-full border border-border-default px-2.5 py-1 text-xs text-secondary hover:bg-subtle"
          >
            {relationshipLabelText(s)}
          </button>
        ))}
      </div>
      {error && <p className="text-sm text-critical">{error}</p>}
    </div>
  );
}

/** PEO-001 "share contact" visibility toggle — "household" is only offered once the person actually
 * belongs to a household (PeopleService.setVisibility rejects it otherwise with HOUSEHOLD_REQUIRED). */
function VisibilityToggle({ person, onSaved }: { person: PersonDetail["person"]; onSaved: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function setVisibility(visibility: "private" | "household") {
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/v1/people/${person.id}/visibility`, { visibility });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't change visibility.");
    } finally {
      setSaving(false);
    }
  }

  const currentValue = person.visibility === "household" ? "household" : "private";

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-tertiary">Visibility</p>
      <div className="flex items-center gap-2">
        <SegmentedControl<"private" | "household">
          value={currentValue}
          onChange={setVisibility}
          aria-label="Visibility"
          options={
            person.householdId
              ? [
                  { value: "private", label: "Private" },
                  { value: "household", label: "Household" },
                ]
              : [{ value: "private", label: "Private" }]
          }
        />
        {saving && <span className="text-xs text-tertiary">Saving…</span>}
      </div>
      {!person.householdId && <p className="text-xs text-tertiary">Add this person to a household to share it household-wide.</p>}
      {error && <p className="text-sm text-critical">{error}</p>}
    </div>
  );
}

function AliasesSection({ personId, aliases, onChanged }: { personId: string; aliases: AliasRow[]; onChanged: () => void }) {
  const [kind, setKind] = useState<AliasRow["kind"]>("email");
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!value.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/v1/people/${personId}/aliases`, { kind, value: value.trim() });
      setValue("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that.");
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(aliasId: string) {
    await api.delete(`/v1/people/aliases/${aliasId}`);
    onChanged();
  }

  return (
    <Card>
      <CardBody className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-tertiary">Emails &amp; phone numbers</p>
        {aliases.length === 0 && <p className="text-sm text-tertiary">None recorded yet.</p>}
        {aliases.map((a) => (
          <div key={a.id} className="flex items-center justify-between border-t border-border-subtle py-2 text-sm first:border-t-0">
            <div className="flex items-center gap-2">
              <Badge tone="neutral">{a.kind === "name_variant" ? "name" : a.kind}</Badge>
              <span className="text-primary">{a.value}</span>
            </div>
            <button onClick={() => remove(a.id)} className="text-xs text-critical hover:underline">
              Remove
            </button>
          </div>
        ))}
        <div className="flex flex-wrap items-end gap-2 border-t border-border-subtle pt-3">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as AliasRow["kind"])}
            aria-label="Kind"
            className="h-10 rounded-lg border border-border-default bg-surface px-2 text-sm text-primary"
          >
            <option value="email">Email</option>
            <option value="phone">Phone</option>
            <option value="name_variant">Name variant</option>
          </select>
          <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Value" className="min-w-[180px] flex-1" maxLength={200} />
          <Button size="sm" onClick={add} loading={submitting} disabled={!value.trim()}>
            Add
          </Button>
        </div>
        {error && <p className="text-sm text-critical">{error}</p>}
      </CardBody>
    </Card>
  );
}

function NotesSection({ personId, notes, onChanged }: { personId: string; notes: PersonNoteRow[]; onChanged: () => void }) {
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!body.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/v1/people/${personId}/notes`, { body: body.trim() });
      setBody("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that note.");
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(noteId: string) {
    await api.delete(`/v1/people/notes/${noteId}`);
    onChanged();
  }

  return (
    <Card>
      <CardBody className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-tertiary">Notes</p>
        {notes.length === 0 && <p className="text-sm text-tertiary">No notes yet.</p>}
        {notes.map((n) => (
          <div key={n.id} className="border-t border-border-subtle py-2 text-sm first:border-t-0">
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 whitespace-pre-wrap text-primary">{n.body}</p>
              <button onClick={() => remove(n.id)} className="shrink-0 text-xs text-critical hover:underline">
                Remove
              </button>
            </div>
            <p className="mt-1 text-xs text-tertiary">{new Date(n.createdAt).toLocaleDateString()}</p>
          </div>
        ))}
        <div className="space-y-2 border-t border-border-subtle pt-3">
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add a note" rows={2} maxLength={5000} />
          <Button size="sm" onClick={add} loading={submitting} disabled={!body.trim()}>
            Add note
          </Button>
        </div>
        {error && <p className="text-sm text-critical">{error}</p>}
      </CardBody>
    </Card>
  );
}

/** PEO-005 "important dates" — `isSensitive` rows are already filtered out server-side for anyone but the
 * owner (PeopleService.detail), so a non-owner viewer simply never receives them; the note below just makes
 * that explicit rather than leaving a shorter list unexplained. The owner sees a "Private" badge on any
 * date marked sensitive so they know it's hidden from anyone else this person is shared with. */
function ImportantDatesSection({
  personId,
  dates,
  isOwner,
  onChanged,
}: {
  personId: string;
  dates: ImportantDateRow[];
  isOwner: boolean;
  onChanged: () => void;
}) {
  const [label, setLabel] = useState("");
  const [dateIso, setDateIso] = useState("");
  const [isSensitive, setIsSensitive] = useState(false);
  const [reminderDaysBefore, setReminderDaysBefore] = useState("14");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!label.trim() || !dateIso) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/v1/people/${personId}/important-dates`, {
        label: label.trim(),
        dateIso,
        isSensitive,
        reminderDaysBefore: reminderDaysBefore ? Number(reminderDaysBefore) : undefined,
      });
      setLabel("");
      setDateIso("");
      setIsSensitive(false);
      setReminderDaysBefore("14");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that date.");
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(dateId: string) {
    await api.delete(`/v1/people/important-dates/${dateId}`);
    onChanged();
  }

  return (
    <Card>
      <CardBody className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-tertiary">Important dates</p>
        {!isOwner && <p className="text-xs text-tertiary">Some entries may be hidden — private dates are visible only to the owner.</p>}
        {dates.length === 0 && <p className="text-sm text-tertiary">None recorded yet.</p>}
        {dates.map((d) => {
          const when = formatTemporal(d.date);
          const days = daysUntil(d.date);
          return (
            <div key={d.id} className="flex items-center justify-between border-t border-border-subtle py-2 text-sm first:border-t-0">
              <div>
                <p className="text-primary">
                  {d.label}
                  {isOwner && d.isSensitive && (
                    <Badge tone="neutral">
                      <span className="ml-1">Private</span>
                    </Badge>
                  )}
                </p>
                {when && (
                  <p className="text-xs text-tertiary">
                    {when}
                    {days != null && days >= 0 && days <= d.reminderDaysBefore ? ` · reminder window` : ""}
                  </p>
                )}
              </div>
              <button onClick={() => remove(d.id)} className="text-xs text-critical hover:underline">
                Remove
              </button>
            </div>
          );
        })}
        <div className="flex flex-wrap items-end gap-2 border-t border-border-subtle pt-3">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Birthday" className="min-w-[140px] flex-1" maxLength={80} />
          <div className="w-40 shrink-0">
            <Input type="date" value={dateIso} onChange={(e) => setDateIso(e.target.value)} />
          </div>
          <div className="w-32 shrink-0">
            <Input
              type="number"
              min={0}
              max={90}
              value={reminderDaysBefore}
              onChange={(e) => setReminderDaysBefore(e.target.value)}
              placeholder="Remind (days)"
            />
          </div>
          <label className="flex items-center gap-1.5 text-xs text-secondary">
            <input type="checkbox" checked={isSensitive} onChange={(e) => setIsSensitive(e.target.checked)} />
            Keep private
          </label>
          <Button size="sm" onClick={add} loading={submitting} disabled={!label.trim() || !dateIso}>
            Add
          </Button>
        </div>
        {error && <p className="w-full text-sm text-critical">{error}</p>}
      </CardBody>
    </Card>
  );
}

/** PEO-003/PEO-004 relationships — either person-to-person or person-to-household-member. Names for
 * `toPersonId`/`fromPersonId` targets are resolved against this owner's own `/v1/people` list, and a
 * household-member target against that household's `/v1/households/:id/dependents` list, since the detail
 * response itself only carries raw ids (PeopleService.detail never denormalizes the other side). */
function RelationshipsSection({
  personId,
  relationships,
  peopleById,
  dependentsById,
  people,
  dependents,
  onChanged,
}: {
  personId: string;
  relationships: { from: PersonRelationshipRow[]; to: PersonRelationshipRow[] };
  peopleById: Map<string, string>;
  dependentsById: Map<string, string>;
  people: PersonListRow[];
  dependents: HouseholdDependentRow[];
  onChanged: () => void;
}) {
  const [targetKind, setTargetKind] = useState<"person" | "dependent">("person");
  const [targetId, setTargetId] = useState("");
  const [label, setLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!targetId || !label.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/v1/people/${personId}/relationships`, {
        toPersonId: targetKind === "person" ? targetId : undefined,
        toDependentProfileId: targetKind === "dependent" ? targetId : undefined,
        label: label.trim(),
      });
      setTargetId("");
      setLabel("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that relationship.");
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(relationshipId: string) {
    await api.delete(`/v1/people/relationships/${relationshipId}`);
    onChanged();
  }

  function describeOther(r: PersonRelationshipRow, otherIsFromSide: boolean): string {
    if (otherIsFromSide) {
      return peopleById.get(r.fromPersonId) ?? "Someone";
    }
    if (r.toPersonId) return peopleById.get(r.toPersonId) ?? "Someone";
    if (r.toDependentProfileId) return dependentsById.get(r.toDependentProfileId) ?? "Household member";
    return "Someone";
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <p className="text-xs font-medium uppercase tracking-wide text-tertiary">Relationships</p>
        {relationships.from.length === 0 && relationships.to.length === 0 && <p className="text-sm text-tertiary">None recorded yet.</p>}
        {relationships.from.map((r) => (
          <div key={r.id} className="flex items-center justify-between border-t border-border-subtle py-2 text-sm first:border-t-0">
            <p className="text-primary">
              {relationshipLabelText(r.label)} of <span className="font-medium">{describeOther(r, false)}</span>
            </p>
            <button onClick={() => remove(r.id)} className="text-xs text-critical hover:underline">
              Remove
            </button>
          </div>
        ))}
        {relationships.to.map((r) => (
          <div key={r.id} className="flex items-center justify-between border-t border-border-subtle py-2 text-sm first:border-t-0">
            <p className="text-primary">
              <span className="font-medium">{describeOther(r, true)}</span>&apos;s {relationshipLabelText(r.label)}
            </p>
            <button onClick={() => remove(r.id)} className="text-xs text-critical hover:underline">
              Remove
            </button>
          </div>
        ))}
        <div className="space-y-2 border-t border-border-subtle pt-3">
          <div className="flex flex-wrap items-end gap-2">
            <select
              value={targetKind}
              onChange={(e) => {
                setTargetKind(e.target.value as "person" | "dependent");
                setTargetId("");
              }}
              aria-label="Relationship target type"
              className="h-10 rounded-lg border border-border-default bg-surface px-2 text-sm text-primary"
            >
              <option value="person">Another person</option>
              <option value="dependent" disabled={dependents.length === 0}>
                Household member
              </option>
            </select>
            <select
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              aria-label="Relationship target"
              className="h-10 min-w-[160px] flex-1 rounded-lg border border-border-default bg-surface px-2 text-sm text-primary"
            >
              <option value="">Choose…</option>
              {targetKind === "person" &&
                people
                  .filter((p) => p.id !== personId)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName}
                    </option>
                  ))}
              {targetKind === "dependent" &&
                dependents.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.displayName}
                  </option>
                ))}
            </select>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (e.g. sister, dentist)" className="min-w-[160px] flex-1" maxLength={80} />
            <Button size="sm" onClick={add} loading={submitting} disabled={!targetId || !label.trim()}>
              Add
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {PERSON_RELATIONSHIP_SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setLabel(s)}
                className="rounded-full border border-border-default px-2.5 py-1 text-xs text-secondary hover:bg-subtle"
              >
                {relationshipLabelText(s)}
              </button>
            ))}
          </div>
        </div>
        {error && <p className="text-sm text-critical">{error}</p>}
      </CardBody>
    </Card>
  );
}

/** PEO-004 generic linking — grouped by kind, each item linking to that item's own existing detail page
 * where one exists (bills/warranties/vehicles/properties/calendar events); documents/maintenance
 * records/tasks have no per-id detail route anywhere in this app yet, so those render as plain text. */
function LinkedHistorySection({ personId, linkedHistory, onChanged }: { personId: string; linkedHistory: PersonDetail["linkedHistory"]; onChanged: () => void }) {
  const [entityId, setEntityId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function link() {
    if (!entityId.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/v1/people/${personId}/linked-entities`, { entityId: entityId.trim() });
      setEntityId("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't link that item.");
    } finally {
      setSubmitting(false);
    }
  }

  async function unlink(id: string) {
    await api.delete(`/v1/people/${personId}/linked-entities/${id}`);
    onChanged();
  }

  const groups: { title: string; items: { id: string; primary: string; secondary?: string | null; href?: string }[] }[] = [
    {
      title: "Bills",
      items: linkedHistory.bill.map((b) => ({ id: b.id, primary: b.billerLabel, secondary: formatTemporal(b.dueDate), href: `/life/bills/${b.id}` })),
    },
    { title: "Documents", items: linkedHistory.document.map((d) => ({ id: d.id, primary: d.title, secondary: d.documentType })) },
    {
      title: "Maintenance records",
      items: linkedHistory.maintenanceRecord.map((m) => ({ id: m.id, primary: m.description, secondary: formatTemporal(m.serviceDate) })),
    },
    {
      title: "Calendar events",
      items: linkedHistory.calendarEvent.map((c) => ({ id: c.id, primary: c.title, secondary: formatTemporal(c.start), href: `/life/events/${c.id}` })),
    },
    { title: "Tasks", items: linkedHistory.task.map((t) => ({ id: t.id, primary: t.title })) },
    {
      title: "Warranties",
      items: linkedHistory.warranty.map((w) => ({ id: w.id, primary: w.productLabel, secondary: formatTemporal(w.expirationDate), href: `/life/warranties/${w.id}` })),
    },
    { title: "Vehicles", items: linkedHistory.vehicle.map((v) => ({ id: v.id, primary: v.label, href: `/life/vehicles/${v.id}` })) },
    { title: "Properties", items: linkedHistory.property.map((p) => ({ id: p.id, primary: p.label, href: `/life/properties/${p.id}` })) },
  ].filter((g) => g.items.length > 0);

  return (
    <Card>
      <CardBody className="space-y-3">
        <p className="text-xs font-medium uppercase tracking-wide text-tertiary">Linked history</p>
        {groups.length === 0 && <p className="text-sm text-tertiary">Nothing linked yet — bills, documents, maintenance records, and more can be linked to this person.</p>}
        {groups.map((g) => (
          <div key={g.title} className="space-y-1 border-t border-border-subtle pt-2 first:border-t-0 first:pt-0">
            <p className="text-xs font-medium text-secondary">{g.title}</p>
            {g.items.map((item) => (
              <div key={item.id} className="flex items-center justify-between text-sm">
                {item.href ? (
                  <Link href={item.href} className="min-w-0 truncate text-primary hover:text-brand">
                    {item.primary}
                    {item.secondary && <span className="text-tertiary"> — {item.secondary}</span>}
                  </Link>
                ) : (
                  <span className="min-w-0 truncate text-primary">
                    {item.primary}
                    {item.secondary && <span className="text-tertiary"> — {item.secondary}</span>}
                  </span>
                )}
                <button onClick={() => unlink(item.id)} className="shrink-0 text-xs text-critical hover:underline">
                  Unlink
                </button>
              </div>
            ))}
          </div>
        ))}
        <div className="flex flex-wrap items-end gap-2 border-t border-border-subtle pt-3">
          <Input value={entityId} onChange={(e) => setEntityId(e.target.value)} placeholder="Paste an item's id to link it" className="min-w-[220px] flex-1" />
          <Button size="sm" variant="secondary" onClick={link} loading={submitting} disabled={!entityId.trim()}>
            Link
          </Button>
        </div>
        {error && <p className="text-sm text-critical">{error}</p>}
      </CardBody>
    </Card>
  );
}

export default function PersonDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useSession();
  const { data, error: fetchError, isLoading, mutate } = useSWR<PersonDetail | null>(`/v1/people/${id}`, swrFetcher);
  const { data: organizations } = useSWR<OrganizationRow[]>("/v1/organizations", swrFetcher);
  const { data: people } = useSWR<PersonListRow[]>("/v1/people", swrFetcher);
  const { data: households } = useSWR<MyHouseholdRow[]>("/v1/households", swrFetcher);
  const householdId = data?.person.householdId ?? null;
  const { data: dependents } = useSWR<HouseholdDependentRow[]>(householdId ? `/v1/households/${householdId}/dependents` : null, swrFetcher);

  const [editingDetails, setEditingDetails] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [savingImportant, setSavingImportant] = useState(false);

  if (isLoading) return <div className="h-40 animate-pulse rounded-xl bg-subtle" />;
  if (fetchError && !data) {
    return (
      <div className="space-y-6">
        <Link href="/life" className="text-sm text-tertiary hover:text-primary">
          ← Back to Life
        </Link>
        <FetchError what="this person" message={fetchError instanceof ApiError ? fetchError.message : undefined} onRetry={() => mutate()} />
      </div>
    );
  }
  if (!data) return <EmptyState title="Not found" description="This person doesn't exist or you don't have access to them." />;

  const { person, organization } = data;
  const isOwner = user?.id === person.ownerUserId;
  const peopleById = new Map((people ?? []).map((p) => [p.id, p.displayName]));
  const dependentsById = new Map((dependents ?? []).map((d) => [d.id, d.displayName]));

  async function toggleImportant(next: boolean) {
    setSavingImportant(true);
    try {
      await api.patch(`/v1/people/${id}`, { isImportant: next });
      mutate();
    } finally {
      setSavingImportant(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Remove "${person.displayName}"? Their notes, dates, and relationships go with them — this can't be undone.`)) return;
    setDeleting(true);
    try {
      await api.delete(`/v1/people/${id}`);
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
          <h1 className="text-2xl font-semibold tracking-tight text-primary">{person.displayName}</h1>
          {organization && <p className="mt-1 text-sm text-tertiary">{organization.name}</p>}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => setEditingDetails((s) => !s)}>
            Edit
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
            <EditPersonForm
              person={person}
              organizations={organizations}
              onSaved={() => {
                setEditingDetails(false);
                mutate();
              }}
            />
          </CardBody>
        </Card>
      )}

      {sharing && (
        <Card>
          <CardBody>
            <ShareResourcePanel resourceId={String(id)} collectionPath="/v1/people" resourceLabel="person" />
          </CardBody>
        </Card>
      )}

      <Card>
        <CardBody className="space-y-4">
          <RelationshipLabelEditor person={person} onSaved={() => mutate()} />
          <div className="border-t border-border-subtle pt-3">
            <VisibilityToggle person={person} onSaved={() => mutate()} />
          </div>
          <div className="border-t border-border-subtle pt-3">
            <Switch
              id="person-important"
              checked={person.isImportant}
              onCheckedChange={toggleImportant}
              disabled={savingImportant}
              label="Mark as important"
              description="Surfaces this person more prominently across Veynlo."
            />
          </div>
        </CardBody>
      </Card>

      <AliasesSection personId={String(id)} aliases={data.aliases} onChanged={() => mutate()} />

      <NotesSection personId={String(id)} notes={data.notes} onChanged={() => mutate()} />

      <ImportantDatesSection personId={String(id)} dates={data.importantDates} isOwner={isOwner} onChanged={() => mutate()} />

      <RelationshipsSection
        personId={String(id)}
        relationships={data.relationships}
        peopleById={peopleById}
        dependentsById={dependentsById}
        people={people ?? []}
        dependents={dependents ?? []}
        onChanged={() => mutate()}
      />

      <LinkedHistorySection personId={String(id)} linkedHistory={data.linkedHistory} onChanged={() => mutate()} />

      {households && households.length === 0 && (
        <p className="text-xs text-tertiary">Join or create a household in Settings to share this person or link them to a household member.</p>
      )}
    </div>
  );
}
