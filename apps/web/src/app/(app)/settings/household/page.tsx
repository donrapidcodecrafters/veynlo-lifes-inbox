"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import useSWR from "swr";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Textarea, Label, FieldError } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/ui/empty-state";
import { FetchError } from "@/components/ui/fetch-error";
import { useSession } from "@/hooks/use-session";

type PrincipalRole =
  | "individual_owner"
  | "household_owner"
  | "adult_member"
  | "dependent_profile"
  | "caregiver_delegate"
  | "emergency_contact"
  | "support_agent"
  | "service_principal";

interface Household {
  id: string;
  name: string;
  billingOwnerUserId: string;
  createdAt: string;
  updatedAt: string;
}

interface Membership {
  id: string;
  householdId: string;
  userId: string | null;
  role: PrincipalRole;
  relationshipLabel: string | null;
  status: "invited" | "active" | "left" | "removed";
  invitedEmail: string | null;
  joinedAt: string | null;
  leftAt: string | null;
}

interface MyHousehold {
  household: Household;
  membership: Membership;
}

interface Dependent {
  id: string;
  householdId: string;
  displayName: string;
  birthDate: string | null;
  hasOwnAccount: boolean;
  linkedUserId: string | null;
  transitionInvitedEmail: string | null;
  transitionInviteTokenExpiresAt: string | null;
}

interface Delegation {
  id: string;
  householdId: string;
  delegateUserId: string;
  scopes: string[];
  expiresAt: string | null;
  grantedByUserId: string;
  grantedAt: string;
  revokedAt: string | null;
}

// Bug fix: this list previously omitted "health:read" — the backend's CAREGIVER_DELEGATION_SCOPES
// (services/api/src/modules/household/dto.ts) has covered it since Health Logistics (§27/HLTH-005)
// shipped, but nothing here offered it, so a caregiver could never be granted (or shown as having) that
// scope through this UI at all — confirmed by diffing this array against the backend's real enum.
//
// §28 Pets PET-001 "assign household manager" — "pets:manage" added alongside it (see dto.ts's own doc
// comment): unlike every scope above, this one grants an EDIT right (update/remove on the household's
// pets), not read visibility, so it gets its own label wording ("Edit pets") rather than a bare domain name
// to make that distinction visible to whoever's granting it.
const DELEGATION_SCOPES = [
  { key: "schedule:read", label: "Schedule" },
  { key: "documents:read", label: "Documents" },
  { key: "commerce:read", label: "Purchases & bills" },
  { key: "household:read", label: "Household" },
  { key: "lists:read", label: "Lists" },
  { key: "health:read", label: "Health logistics" },
  { key: "pets:manage", label: "Edit pets" },
] as const;

const ROLE_LABEL: Record<PrincipalRole, string> = {
  individual_owner: "Owner",
  household_owner: "Owner",
  adult_member: "Adult member",
  dependent_profile: "Dependent",
  caregiver_delegate: "Caregiver",
  emergency_contact: "Emergency contact",
  support_agent: "Support agent",
  service_principal: "Service",
};

const STATUS_TONE: Record<Membership["status"], "positive" | "warning" | "neutral"> = {
  active: "positive",
  invited: "warning",
  left: "neutral",
  removed: "neutral",
};

/**
 * Formats a plain "YYYY-MM-DD" date-only string (as stored/returned for `Dependent.birthDate`) for
 * display. Deliberately NOT `new Date(dateOnlyString).toLocaleDateString()` — a bare date-only string is
 * parsed by `Date` as UTC midnight, so in any negative-UTC-offset timezone (all of the Americas)
 * `toLocaleDateString()` on it silently rolls the displayed date back by one day (e.g. a 2018-04-02
 * birth date shows as "4/1/2018"). Parsing the y/m/d components into a local-time `Date` avoids that.
 */
function formatDateOnly(dateOnly: string): string {
  const [year, month, day] = dateOnly.split("-").map(Number);
  if (!year || !month || !day) return dateOnly;
  return new Date(year, month - 1, day).toLocaleDateString();
}

/**
 * Bug fix: every form on this page caught errors as `err instanceof ApiError ? err.message : "..."`,
 * which for any Zod validation failure (household name over 120 chars, invalid invite email, etc.) is
 * always the same unhelpful literal "Request body failed validation." — see ZodValidationPipe
 * (services/api/src/common/zod-validation.pipe.ts), which puts the actually useful per-field message in
 * `fieldErrors` instead. Confirmed live: submitting a >120-char household name rendered exactly that
 * generic sentence with no indication of what was actually wrong or how to fix it. Every catch block below
 * now goes through this helper so a real field-level message (when the server sent one) wins over the
 * generic one.
 */
function apiErrorMessage(err: unknown, fallback = "Something went wrong. Please try again."): string {
  if (err instanceof ApiError) {
    const firstFieldError = err.fieldErrors && Object.values(err.fieldErrors).flat()[0];
    return firstFieldError || err.message;
  }
  return fallback;
}

export default function HouseholdSettingsPage() {
  const { user } = useSession();
  const { data: myHouseholds, error: myHouseholdsError, mutate: mutateMine } = useSWR<MyHousehold[]>("/v1/households", swrFetcher);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = myHouseholds?.find((h) => h.household.id === selectedId) ?? myHouseholds?.[0] ?? null;

  return (
    <div className="space-y-6">
      <header>
        <Link href="/settings" className="text-sm text-tertiary hover:text-primary">
          ← Settings
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-primary">Household</h1>
        <p className="mt-1 text-sm text-tertiary">Share Veynlo with the people in your household, and control what caregivers can see.</p>
      </header>

      {myHouseholds && myHouseholds.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {myHouseholds.map(({ household }) => (
            <button
              key={household.id}
              onClick={() => setSelectedId(household.id)}
              className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
                (selected?.household.id ?? myHouseholds[0]?.household.id) === household.id
                  ? "bg-brand text-on-brand"
                  : "bg-subtle text-secondary hover:bg-border-subtle"
              }`}
            >
              {household.name}
            </button>
          ))}
        </div>
      )}

      {myHouseholdsError && !myHouseholds && (
        <FetchError
          what="your household"
          message={myHouseholdsError instanceof ApiError ? myHouseholdsError.message : undefined}
          onRetry={() => mutateMine()}
        />
      )}

      {!myHouseholdsError && myHouseholds && myHouseholds.length === 0 && (
        <EmptyState
          title="No household yet"
          description="Create one to share purchases, bills, calendars, and more with the people you live with."
        />
      )}

      {!myHouseholdsError && <CreateHouseholdCard onCreated={() => mutateMine()} />}

      {selected && (
        <HouseholdDetail
          key={selected.household.id}
          household={selected.household}
          myMembership={selected.membership}
          myUserId={user?.id ?? null}
          onLeftHousehold={() => mutateMine()}
        />
      )}
    </div>
  );
}

function CreateHouseholdCard({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api.post("/v1/households", { name });
      setName("");
      setOpen(false);
      onCreated();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        + New household
      </Button>
    );
  }

  return (
    <Card>
      <CardBody>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div>
            <Label htmlFor="household-name">Household name</Label>
            <Input id="household-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="The Riveras" required />
          </div>
          {error && <FieldError>{error}</FieldError>}
          <div className="flex gap-3">
            <Button type="submit" loading={loading}>
              Create
            </Button>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

function HouseholdDetail({
  household,
  myMembership,
  myUserId,
  onLeftHousehold,
}: {
  household: Household;
  myMembership: Membership;
  myUserId: string | null;
  onLeftHousehold: () => void;
}) {
  const { data: members, mutate: mutateMembers } = useSWR<Membership[]>(`/v1/households/${household.id}/members`, swrFetcher);
  const canManage = myMembership.role === "household_owner" || myMembership.role === "adult_member";
  const isOwner = myMembership.role === "household_owner";

  return (
    <div className="space-y-6">
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-tertiary">Household</h2>
          {isOwner && <RenameHouseholdControl householdId={household.id} currentName={household.name} />}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">Members</h2>
        <Card>
          <CardBody className="space-y-3">
            {!members && <p className="text-sm text-tertiary">Loading…</p>}
            {members?.map((m) => {
              const isMe = m.id === myMembership.id;
              const displayLabel = isMe
                ? "You"
                : m.status === "invited"
                  ? m.invitedEmail
                  : m.relationshipLabel?.toLowerCase() === "self"
                    ? ROLE_LABEL[m.role]
                    : m.relationshipLabel || ROLE_LABEL[m.role];
              return (
                <div key={m.id} className="flex items-center justify-between gap-3 border-b border-border-subtle pb-3 last:border-0 last:pb-0">
                  <div className="min-w-0">
                    {/* Bug fix: the household creator's own membership row is seeded server-side with the
                        literal placeholder relationshipLabel "self" (see household.service.ts's household
                        creation, `relationshipLabel: "self"`), which — before this fix — rendered verbatim
                        as the lowercase word "self" in the member list, looking like a data bug rather than
                        a real name. It's not only wrong on the owner's own view either: verified live from a
                        second member's account, the owner's row shows the literal text "self" to THEM too,
                        which reads as outright nonsensical ("self" relative to whom?) rather than merely
                        unpolished. Comparing against `myMembership.id` (not just `m.userId === myUserId`,
                        since a dependent profile without its own account can't be compared by userId) lets
                        us show the normal "You" convention on the viewer's own row, and the second condition
                        below catches the same placeholder leaking into anyone else's view of that row by
                        falling back to the role label instead of trusting it as a real relationship label. */}
                    <p className="truncate text-[0.9375rem] font-medium text-primary">{displayLabel}</p>
                    <p className="text-sm text-tertiary">{ROLE_LABEL[m.role]}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={STATUS_TONE[m.status]}>{m.status}</Badge>
                    {canManage && m.status === "invited" && (
                      <InvitedMemberActions householdId={household.id} membership={m} onChanged={() => mutateMembers()} />
                    )}
                    {canManage && m.status === "active" && !isMe && m.role !== "household_owner" && (
                      <RemoveMemberButton householdId={household.id} membership={m} onRemoved={() => mutateMembers()} />
                    )}
                    {isOwner && m.status === "active" && !isMe && m.role === "adult_member" && (
                      <TransferOwnershipButton householdId={household.id} membership={m} onTransferred={() => mutateMembers()} />
                    )}
                  </div>
                </div>
              );
            })}
          </CardBody>
        </Card>

        {myMembership.status === "active" && (
          <div className="mt-3">
            {/* Bug fix: this used to call mutateMembers() on success, re-fetching
                `/v1/households/${household.id}/members` for the household the button just made you leave.
                Verified live (request/response logging + polling the DOM for several seconds): the leave
                POST succeeds (201) and IS followed by that refetch, but the refetch itself 403s — the
                backend correctly requires active membership to read a household's member list, and leaving
                just ended that membership. SWR's default behavior on a failed revalidation is to keep
                showing the last-good cached data, so the page was stuck displaying "You / active" with the
                Leave button still live, indefinitely — the user has actually left, but nothing on screen
                ever says so short of a manual reload. The correct refetch after leaving isn't this
                household's members, it's the top-level household list (`onLeftHousehold`, threaded down
                from HouseholdSettingsPage's `mutateMine`): that call succeeds (the user can always list
                their OWN households), drops this household from the list, and `HouseholdDetail` unmounts
                (or remounts against another household) instead of trying to keep reading one it just lost
                access to.

                Owners now see this too (previously hidden entirely — `role !== "household_owner"` — which
                was correct in effect, since leave() 400s with OWNER_MUST_TRANSFER for an owner, but gave no
                UI path to resolve that: transferOwnership() didn't exist yet. Now that it does (see the
                per-row "Make owner" action above), an owner can transfer first, then leave like anyone
                else — so the Leave button stays visible for owners too, and the OWNER_MUST_TRANSFER error
                surfaces inline if they try to leave first. */}
            <LeaveButton householdId={household.id} onLeft={onLeftHousehold} />
          </div>
        )}
      </section>

      {canManage && (
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">Invite someone</h2>
          <InviteForm householdId={household.id} onInvited={() => mutateMembers()} />
        </section>
      )}

      <DependentsSection householdId={household.id} canManage={canManage} />

      <EmergencyBinderSection householdId={household.id} canManage={canManage} />

      {canManage && (
        <DelegationsSection
          householdId={household.id}
          members={members ?? []}
          myUserId={myUserId}
        />
      )}
    </div>
  );
}

interface EmergencyBinderDocument {
  id: string;
  title: string;
  documentType: string;
}

interface EmergencyBinderSettings {
  medicationsNotes: string | null;
  emergencyInstructions: string | null;
}

/**
 * Phase 2 §52.2 "emergency binder". This section now covers two things:
 *  1. The flagged-document list (as before — visible to any active household member).
 *  2. The two new household-level free-text fields (medications, emergency instructions) — editable by
 *     any adult member, deliberately NOT step-up gated (see EmergencyBinderService.getSettings's own doc
 *     comment: this is one household setting among several, same tier as the household name above; only
 *     the full cross-domain aggregate at /emergency-binder is behind the password/biometric gate).
 * The full aggregated packet (roster, vehicles, property, these fields, and the documents below, all in
 * one place) lives at its own gated page — see apps/web/src/app/(app)/emergency-binder/page.tsx.
 */
function EmergencyBinderSection({ householdId, canManage }: { householdId: string; canManage: boolean }) {
  const { data } = useSWR<EmergencyBinderDocument[]>(`/v1/documents/emergency-binder/${householdId}`, swrFetcher);

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-tertiary">Emergency binder</h2>
        <Link href={`/emergency-binder?householdId=${householdId}`} className="text-sm font-medium text-brand hover:underline">
          View full binder →
        </Link>
      </div>

      <EmergencyBinderSettingsForm householdId={householdId} canManage={canManage} />

      <p className="mb-3 mt-4 text-sm text-tertiary">
        Documents anyone in this household can find in an emergency. Share a document from the{" "}
        <Link href="/documents" className="text-brand hover:underline">
          Documents
        </Link>{" "}
        page and add it here.
      </p>
      {data && data.length === 0 && <EmptyState title="Nothing in the binder yet" description="Shared, critical documents (IDs, insurance, medical info) will show up here once added." />}
      {data && data.length > 0 && (
        <Card>
          <CardBody className="space-y-2">
            {data.map((doc) => (
              <div key={doc.id} className="flex items-center justify-between border-b border-border-subtle pb-2 last:border-0 last:pb-0">
                <p className="text-sm font-medium text-primary">{doc.title}</p>
                <span className="text-xs capitalize text-tertiary">{doc.documentType.replace(/_/g, " ")}</span>
              </div>
            ))}
          </CardBody>
        </Card>
      )}
    </section>
  );
}

function EmergencyBinderSettingsForm({ householdId, canManage }: { householdId: string; canManage: boolean }) {
  const { data, mutate } = useSWR<EmergencyBinderSettings>(`/v1/emergency-binder/${householdId}/settings`, swrFetcher);
  const [editing, setEditing] = useState(false);
  const [medicationsNotes, setMedicationsNotes] = useState("");
  const [emergencyInstructions, setEmergencyInstructions] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function startEditing() {
    setMedicationsNotes(data?.medicationsNotes ?? "");
    setEmergencyInstructions(data?.emergencyInstructions ?? "");
    setEditing(true);
  }

  async function onSave() {
    setLoading(true);
    setError(null);
    try {
      await api.patch(`/v1/emergency-binder/${householdId}/settings`, {
        medicationsNotes: medicationsNotes || null,
        emergencyInstructions: emergencyInstructions || null,
      });
      setEditing(false);
      mutate();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  if (!editing) {
    const hasContent = Boolean(data?.medicationsNotes || data?.emergencyInstructions);
    return (
      <Card>
        <CardBody className="space-y-3">
          {!hasContent && <p className="text-sm text-tertiary">No medications or emergency instructions on file yet.</p>}
          {data?.medicationsNotes && (
            <div>
              <p className="text-sm font-medium text-primary">Medications</p>
              <p className="whitespace-pre-wrap text-sm text-secondary">{data.medicationsNotes}</p>
            </div>
          )}
          {data?.emergencyInstructions && (
            <div>
              <p className="text-sm font-medium text-primary">Emergency instructions</p>
              <p className="whitespace-pre-wrap text-sm text-secondary">{data.emergencyInstructions}</p>
            </div>
          )}
          {canManage && (
            <Button variant="secondary" size="sm" onClick={startEditing}>
              Edit
            </Button>
          )}
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardBody className="space-y-4">
        <div>
          <Label htmlFor="binder-medications">Medications (names, dosages, allergies — whatever a first responder would need)</Label>
          <Textarea id="binder-medications" rows={3} value={medicationsNotes} onChange={(e) => setMedicationsNotes(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="binder-instructions">Emergency instructions (utility shutoffs, evacuation plan, meeting point)</Label>
          <Textarea id="binder-instructions" rows={3} value={emergencyInstructions} onChange={(e) => setEmergencyInstructions(e.target.value)} />
        </div>
        {error && <FieldError>{error}</FieldError>}
        <div className="flex gap-3">
          <Button size="sm" loading={loading} onClick={onSave}>
            Save
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

function LeaveButton({ householdId, onLeft }: { householdId: string; onLeft: () => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onLeave() {
    if (!window.confirm("Leave this household? You'll lose access to shared purchases, bills, and calendars.")) return;
    setLoading(true);
    setError(null);
    try {
      await api.post(`/v1/households/${householdId}/leave`);
      onLeft();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button variant="critical" size="sm" loading={loading} onClick={onLeave}>
        Leave household
      </Button>
      {error && <FieldError>{error}</FieldError>}
    </div>
  );
}

function RenameHouseholdControl({ householdId, currentName }: { householdId: string; currentName: string }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(currentName);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api.patch(`/v1/households/${householdId}`, { name });
      setEditing(false);
      // The name shown by the parent comes from `/v1/households` (via mutateMine), which this component
      // doesn't own a mutate() handle to — a full page reload after a rename is simplest here since it's a
      // rare, deliberate action, not something that needs optimistic/SWR-cache wiring.
      window.location.reload();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  if (!editing) {
    return (
      <button onClick={() => setEditing(true)} className="text-sm font-medium text-brand hover:underline">
        Rename
      </button>
    );
  }

  return (
    // Bug fix: every other form in this file passes `noValidate` and relies on its own styled
    // <FieldError>, so a required field left blank shows a consistent inline message. This form was the
    // only one missing it — confirmed live, submitting it empty popped the browser's native "Please fill
    // out this field." tooltip instead, which looked out of place next to the Save/Cancel buttons and
    // didn't match the rest of the app's validation styling.
    <form onSubmit={onSave} className="flex items-center gap-2" noValidate>
      <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 w-40 text-sm" aria-label="Household name" required />
      <Button type="submit" size="sm" loading={loading}>
        Save
      </Button>
      <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(false)}>
        Cancel
      </Button>
      {error && <FieldError>{error}</FieldError>}
    </form>
  );
}

function InvitedMemberActions({
  householdId,
  membership,
  onChanged,
}: {
  householdId: string;
  membership: Membership;
  onChanged: () => void;
}) {
  const [resending, setResending] = useState(false);
  const [revoking, setRevoking] = useState(false);

  async function onResend() {
    setResending(true);
    try {
      await api.post(`/v1/households/${householdId}/members/${membership.id}/resend-invite`);
      onChanged();
    } finally {
      setResending(false);
    }
  }

  async function onRevoke() {
    if (!window.confirm(`Revoke the invite sent to ${membership.invitedEmail}?`)) return;
    setRevoking(true);
    try {
      await api.post(`/v1/households/${householdId}/members/${membership.id}/revoke-invite`);
      onChanged();
    } finally {
      setRevoking(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button variant="ghost" size="sm" loading={resending} onClick={onResend}>
        Resend
      </Button>
      <Button variant="ghost" size="sm" loading={revoking} onClick={onRevoke}>
        Revoke
      </Button>
    </div>
  );
}

function RemoveMemberButton({ householdId, membership, onRemoved }: { householdId: string; membership: Membership; onRemoved: () => void }) {
  const [loading, setLoading] = useState(false);

  async function onRemove() {
    if (!window.confirm(`Remove ${membership.relationshipLabel || "this member"} from the household? They'll immediately lose access to shared data.`)) return;
    setLoading(true);
    try {
      await api.post(`/v1/households/${householdId}/members/${membership.id}/remove`);
      onRemoved();
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button variant="ghost" size="sm" loading={loading} onClick={onRemove}>
      Remove
    </Button>
  );
}

function TransferOwnershipButton({
  householdId,
  membership,
  onTransferred,
}: {
  householdId: string;
  membership: Membership;
  onTransferred: () => void;
}) {
  const [loading, setLoading] = useState(false);

  async function onTransfer() {
    if (!membership.userId) return;
    if (!window.confirm(`Make ${membership.relationshipLabel || "this member"} the household owner? You'll become an adult member.`)) return;
    setLoading(true);
    try {
      await api.post(`/v1/households/${householdId}/transfer-ownership`, { targetUserId: membership.userId });
      onTransferred();
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button variant="ghost" size="sm" loading={loading} onClick={onTransfer}>
      Make owner
    </Button>
  );
}

function InviteForm({ householdId, onInvited }: { householdId: string; onInvited: () => void }) {
  const [email, setEmail] = useState("");
  const [relationshipLabel, setRelationshipLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(false);
    try {
      await api.post(`/v1/households/${householdId}/invite`, { email, relationshipLabel: relationshipLabel || null });
      setEmail("");
      setRelationshipLabel("");
      setSuccess(true);
      onInvited();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardBody>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div>
            <Label htmlFor="invite-email">Email</Label>
            <Input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div>
            <Label htmlFor="invite-relationship">Relationship (optional)</Label>
            <Input
              id="invite-relationship"
              value={relationshipLabel}
              onChange={(e) => setRelationshipLabel(e.target.value)}
              placeholder="Partner, roommate, parent…"
            />
          </div>
          {error && <FieldError>{error}</FieldError>}
          {success && <p className="text-sm text-positive">Invite sent — they'll get an email with a link to join.</p>}
          <Button type="submit" loading={loading}>
            Send invite
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

function DependentsSection({ householdId, canManage }: { householdId: string; canManage: boolean }) {
  const { data: dependents, mutate } = useSWR<Dependent[]>(`/v1/households/${householdId}/dependents`, swrFetcher);
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api.post(`/v1/households/${householdId}/dependents`, { displayName, birthDate: birthDate || null });
      setDisplayName("");
      setBirthDate("");
      setOpen(false);
      mutate();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">Dependents</h2>
      <Card>
        <CardBody className="space-y-3">
          {dependents?.length === 0 && !open && <p className="text-sm text-tertiary">No dependent profiles yet — for kids or anyone else without their own account.</p>}
          {dependents?.map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-3 border-b border-border-subtle pb-3 last:border-0 last:pb-0">
              <div className="min-w-0">
                <p className="text-[0.9375rem] font-medium text-primary">{d.displayName}</p>
                {d.birthDate && <p className="text-sm text-tertiary">{formatDateOnly(d.birthDate)}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {d.hasOwnAccount ? (
                  <Badge tone="positive">Has own account</Badge>
                ) : (
                  canManage && (
                    <DependentTransitionAction householdId={householdId} dependent={d} onChanged={() => mutate()} />
                  )
                )}
              </div>
            </div>
          ))}
        </CardBody>
      </Card>
      {canManage && (
        <div className="mt-3">
          {!open ? (
            <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
              + Add dependent
            </Button>
          ) : (
            <Card>
              <CardBody>
                <form onSubmit={onSubmit} className="space-y-4" noValidate>
                  <div>
                    <Label htmlFor="dep-name">Name</Label>
                    <Input id="dep-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
                  </div>
                  <div>
                    <Label htmlFor="dep-birthdate">Birth date (optional)</Label>
                    <Input id="dep-birthdate" type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
                  </div>
                  {error && <FieldError>{error}</FieldError>}
                  <div className="flex gap-3">
                    <Button type="submit" size="sm" loading={loading}>
                      Add
                    </Button>
                    <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(false)}>
                      Cancel
                    </Button>
                  </div>
                </form>
              </CardBody>
            </Card>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * FAM-001 "later invite/transition path when appropriate" — lets a guardian/adult household member invite
 * a dependent profile to link its own account. Admin-initiated only (mirrors InviteForm above), since a
 * dependent profile has no session/login of its own to start this from.
 */
function DependentTransitionAction({
  householdId,
  dependent,
  onChanged,
}: {
  householdId: string;
  dependent: Dependent;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [revoking, setRevoking] = useState(false);

  const isPending = Boolean(dependent.transitionInviteTokenExpiresAt) && new Date(dependent.transitionInviteTokenExpiresAt as string) > new Date();

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api.post(`/v1/households/${householdId}/dependents/${dependent.id}/invite-transition`, { email });
      setEmail("");
      setOpen(false);
      onChanged();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function onRevoke() {
    if (!window.confirm(`Cancel the account-transition invite sent to ${dependent.transitionInvitedEmail}?`)) return;
    setRevoking(true);
    try {
      await api.post(`/v1/households/${householdId}/dependents/${dependent.id}/revoke-transition`);
      onChanged();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setRevoking(false);
    }
  }

  if (isPending) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="flex items-center gap-2">
          <Badge tone="warning">Invite sent to {dependent.transitionInvitedEmail}</Badge>
          <Button variant="ghost" size="sm" loading={revoking} onClick={onRevoke}>
            Cancel
          </Button>
        </div>
        {error && <FieldError>{error}</FieldError>}
      </div>
    );
  }

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Transition to their own account
      </Button>
    );
  }

  return (
    <Card>
      <CardBody>
        <form onSubmit={onSubmit} className="space-y-3" noValidate>
          <div>
            <Label htmlFor={`transition-email-${dependent.id}`}>{dependent.displayName}&apos;s email</Label>
            <Input
              id={`transition-email-${dependent.id}`}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="their-email@example.com"
              required
            />
            <p className="mt-1 text-xs text-tertiary">
              They&apos;ll get an emailed link to sign in or create an account. Everything already on their profile
              stays visible to them and the rest of the household — this only adds independent sign-in access.
            </p>
          </div>
          {error && <FieldError>{error}</FieldError>}
          <div className="flex gap-3">
            <Button type="submit" size="sm" loading={loading}>
              Send invite
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

function DelegationsSection({ householdId, members, myUserId }: { householdId: string; members: Membership[]; myUserId: string | null }) {
  const { data: delegations, mutate } = useSWR<Delegation[]>(`/v1/households/${householdId}/delegations`, swrFetcher);
  const [open, setOpen] = useState(false);
  const [delegateUserId, setDelegateUserId] = useState("");
  const [scopes, setScopes] = useState<Set<string>>(new Set());
  const [expiresOn, setExpiresOn] = useState(""); // empty = "until revoked"
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const activeDelegations = delegations?.filter((d) => !d.revokedAt) ?? [];
  // Bug fix: the backend has no dedup/merge logic for grantDelegation (confirmed against
  // household.service.ts — a caller can grant the same delegateUserId a delegation an unbounded number of
  // times, each stored as its own independently-revocable row). Nothing in the UI previously reflected
  // that: the "Household member" dropdown kept offering a member who already had an active grant, so
  // repeatedly opening this form and granting again silently produced multiple overlapping "Sibling" rows
  // in the list above with no way to tell they're the same relationship or to edit one in place — verified
  // live, this reached 4 duplicate rows for one delegate after a handful of grants. Since there's no
  // "edit an existing grant's scopes" flow, the fix is to require revoking the existing grant before
  // re-granting to the same person, by excluding already-delegated members from the dropdown below.
  const alreadyDelegatedUserIds = new Set(activeDelegations.map((d) => d.delegateUserId));
  const eligibleDelegates = members.filter(
    (m) => m.status === "active" && m.userId && m.userId !== myUserId && !alreadyDelegatedUserIds.has(m.userId),
  );
  const hasIneligibleActiveMembers =
    eligibleDelegates.length === 0 && members.some((m) => m.status === "active" && m.userId && m.userId !== myUserId);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!delegateUserId || scopes.size === 0) return;
    setLoading(true);
    setError(null);
    try {
      await api.post(`/v1/households/${householdId}/delegations`, {
        delegateUserId,
        scopes: Array.from(scopes),
        expiresAt: expiresOn ? new Date(`${expiresOn}T23:59:59.999Z`).toISOString() : null,
      });
      setDelegateUserId("");
      setScopes(new Set());
      setExpiresOn("");
      setOpen(false);
      mutate();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function onRevoke(delegationId: string, delegateLabel: string) {
    if (!window.confirm(`Revoke ${delegateLabel}'s caregiver access? They immediately lose the visibility this delegation granted.`)) return;
    setRevokingId(delegationId);
    try {
      await api.post(`/v1/households/${householdId}/delegations/${delegationId}/revoke`);
      mutate();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">Caregiver access</h2>
      <p className="mb-3 text-sm text-tertiary">Give a household member time-bound, scoped visibility into specific parts of your data — never blanket access.</p>
      <Card>
        <CardBody className="space-y-3">
          {activeDelegations.length === 0 && <p className="text-sm text-tertiary">No active delegations.</p>}
          {activeDelegations.map((d) => {
            const delegate = members.find((m) => m.userId === d.delegateUserId);
            return (
              <div key={d.id} className="flex items-center justify-between gap-3 border-b border-border-subtle pb-3 last:border-0 last:pb-0">
                <div className="min-w-0">
                  <p className="text-[0.9375rem] font-medium text-primary">{delegate?.relationshipLabel || "Household member"}</p>
                  <p className="text-sm text-tertiary">{d.scopes.map((s) => DELEGATION_SCOPES.find((sc) => sc.key === s)?.label ?? s).join(", ")}</p>
                  <p className="text-xs text-tertiary">{d.expiresAt ? `Expires ${new Date(d.expiresAt).toLocaleDateString()}` : "Until revoked"}</p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={revokingId === d.id}
                  onClick={() => onRevoke(d.id, delegate?.relationshipLabel || "this household member")}
                >
                  Revoke
                </Button>
              </div>
            );
          })}
        </CardBody>
      </Card>
      <div className="mt-3">
        {!open ? (
          <>
            <Button variant="secondary" size="sm" onClick={() => setOpen(true)} disabled={eligibleDelegates.length === 0}>
              + Grant access
            </Button>
            {hasIneligibleActiveMembers && (
              <p className="mt-2 text-xs text-tertiary">Everyone eligible already has active access above — revoke a grant to change their scopes.</p>
            )}
          </>
        ) : (
          <Card>
            <CardBody>
              <form onSubmit={onSubmit} className="space-y-4" noValidate>
                <div>
                  <Label htmlFor="delegate-select">Household member</Label>
                  <select
                    id="delegate-select"
                    value={delegateUserId}
                    onChange={(e) => setDelegateUserId(e.target.value)}
                    className="h-10 w-full rounded-lg border border-border-default bg-surface px-3.5 text-[0.9375rem] text-primary focus:border-border-focus focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
                    required
                  >
                    <option value="">Choose someone…</option>
                    {eligibleDelegates.map((m) => (
                      <option key={m.userId} value={m.userId ?? ""}>
                        {m.relationshipLabel || ROLE_LABEL[m.role]}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  {DELEGATION_SCOPES.map((s) => (
                    <Switch
                      key={s.key}
                      id={`scope-${s.key}`}
                      label={s.label}
                      checked={scopes.has(s.key)}
                      onCheckedChange={(checked) =>
                        setScopes((prev) => {
                          const next = new Set(prev);
                          if (checked) next.add(s.key);
                          else next.delete(s.key);
                          return next;
                        })
                      }
                    />
                  ))}
                </div>
                <div>
                  <Label htmlFor="expires-on">Expires (optional)</Label>
                  <Input id="expires-on" type="date" value={expiresOn} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setExpiresOn(e.target.value)} />
                  <p className="mt-1 text-xs text-tertiary">Leave blank for access that lasts until you revoke it.</p>
                </div>
                {error && <FieldError>{error}</FieldError>}
                <div className="flex gap-3">
                  <Button type="submit" size="sm" loading={loading} disabled={!delegateUserId || scopes.size === 0}>
                    Grant
                  </Button>
                  <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                </div>
              </form>
            </CardBody>
          </Card>
        )}
      </div>
    </section>
  );
}
