"use client";

import { useState, type FormEvent } from "react";
import useSWR from "swr";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";

interface HouseholdRow {
  household: { id: string; name: string };
  membership: { role: string };
}

interface Member {
  id: string;
  userId: string | null;
  role: string;
  relationshipLabel: string | null;
  status: string;
  invitedEmail: string | null;
  displayName: string | null;
}

interface Dependent {
  id: string;
  displayName: string;
  birthDate: string | null;
}

const DELEGATION_SCOPES = ["schedule:read", "documents:read", "commerce:read", "household:read"] as const;

interface Delegation {
  id: string;
  delegateUserId: string;
  delegateDisplayName: string | null;
  scopes: string[];
  expiresAt: string | null;
  revokedAt: string | null;
}

const ROLE_LABEL: Record<string, string> = {
  household_owner: "Owner",
  adult_member: "Adult member",
};

export default function HouseholdPage() {
  const { data: households, mutate: mutateHouseholds } = useSWR<HouseholdRow[]>("/v1/households", swrFetcher);
  const active = households?.[0];

  if (households && households.length === 0) {
    return <CreateHousehold onCreated={() => mutateHouseholds()} />;
  }

  if (!active) {
    return (
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">Household</h1>
        </header>
        <div className="h-24 animate-pulse rounded-xl bg-subtle" />
      </div>
    );
  }

  return <HouseholdDetail householdId={active.household.id} householdName={active.household.name} myRole={active.membership.role} />;
}

function CreateHousehold({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.post("/v1/households", { name });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">Household</h1>
        <p className="mt-1 text-sm text-tertiary">Share access with the people in your life — a partner, family, or caregiver.</p>
      </header>
      <Card>
        <CardBody>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <div>
              <Label htmlFor="household-name">Household name</Label>
              <Input id="household-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. The Riveras" required />
            </div>
            <FieldError>{error ?? undefined}</FieldError>
            <Button type="submit" loading={submitting} disabled={!name.trim()}>
              Create household
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}

function HouseholdDetail({ householdId, householdName, myRole }: { householdId: string; householdName: string; myRole: string }) {
  const { data: members, mutate: mutateMembers } = useSWR<Member[]>(`/v1/households/${householdId}/members`, swrFetcher);
  const { data: dependents, mutate: mutateDependents } = useSWR<Dependent[]>(`/v1/households/${householdId}/dependents`, swrFetcher);
  const { data: delegations, mutate: mutateDelegations } = useSWR<Delegation[]>(`/v1/households/${householdId}/delegations`, swrFetcher);

  const canManage = myRole === "household_owner" || myRole === "adult_member";
  const activeMembers = members?.filter((m) => m.status === "active") ?? [];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">{householdName}</h1>
        <p className="mt-1 text-sm text-tertiary">Share access with the people in your life — a partner, family, or caregiver.</p>
      </header>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">Members</h2>
        <Card>
          <CardBody className="space-y-3">
            {!members && <p className="text-sm text-tertiary">Loading…</p>}
            {members?.map((m) => (
              <div key={m.id} className="flex items-center justify-between text-sm">
                <div>
                  <p className="font-medium text-primary">{m.displayName ?? m.invitedEmail ?? "Unknown"}</p>
                  <p className="text-tertiary">{m.relationshipLabel ?? ROLE_LABEL[m.role] ?? m.role}</p>
                </div>
                <Badge tone={m.status === "active" ? "positive" : m.status === "invited" ? "warning" : "neutral"}>
                  {m.status === "active" ? ROLE_LABEL[m.role] ?? m.role : m.status}
                </Badge>
              </div>
            ))}
          </CardBody>
        </Card>
        {canManage && <InviteForm householdId={householdId} onInvited={() => mutateMembers()} />}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">Dependents</h2>
        <Card>
          <CardBody className="space-y-3">
            {!dependents && <p className="text-sm text-tertiary">Loading…</p>}
            {dependents?.length === 0 && <p className="text-sm text-tertiary">No dependents added yet.</p>}
            {dependents?.map((d) => (
              <div key={d.id} className="flex items-center justify-between text-sm">
                <p className="font-medium text-primary">{d.displayName}</p>
                {d.birthDate && <p className="text-tertiary">{new Date(d.birthDate).toLocaleDateString()}</p>}
              </div>
            ))}
          </CardBody>
        </Card>
        {canManage && <AddDependentForm householdId={householdId} onAdded={() => mutateDependents()} />}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">Caregiver delegations</h2>
        <Card>
          <CardBody className="space-y-3">
            {!delegations && <p className="text-sm text-tertiary">Loading…</p>}
            {delegations?.filter((d) => !d.revokedAt).length === 0 && (
              <p className="text-sm text-tertiary">No active delegations — grant one below to share scoped access with a member.</p>
            )}
            {delegations
              ?.filter((d) => !d.revokedAt)
              .map((d) => (
                <div key={d.id} className="flex items-center justify-between text-sm">
                  <div>
                    <p className="font-medium text-primary">{d.delegateDisplayName ?? d.delegateUserId}</p>
                    <p className="text-tertiary">
                      {d.scopes.join(", ")}
                      {d.expiresAt && ` · until ${new Date(d.expiresAt).toLocaleDateString()}`}
                    </p>
                  </div>
                  {canManage && (
                    <RevokeDelegationButton
                      householdId={householdId}
                      delegationId={d.id}
                      onRevoked={() => mutateDelegations()}
                    />
                  )}
                </div>
              ))}
          </CardBody>
        </Card>
        {canManage && (
          <GrantDelegationForm householdId={householdId} members={activeMembers} onGranted={() => mutateDelegations()} />
        )}
      </section>
    </div>
  );
}

function InviteForm({ householdId, onInvited }: { householdId: string; onInvited: () => void }) {
  const [email, setEmail] = useState("");
  const [relationshipLabel, setRelationshipLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/v1/households/${householdId}/invite`, { email, relationshipLabel: relationshipLabel || undefined });
      setEmail("");
      setRelationshipLabel("");
      onInvited();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't send that invite. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-3 flex flex-wrap items-end gap-2 rounded-lg bg-subtle p-3" noValidate>
      <div className="min-w-[200px] flex-1">
        <Label htmlFor="invite-email">Invite by email</Label>
        <Input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="partner@example.com" required />
      </div>
      <div className="min-w-[140px]">
        <Label htmlFor="invite-relationship">Relationship (optional)</Label>
        <Input id="invite-relationship" value={relationshipLabel} onChange={(e) => setRelationshipLabel(e.target.value)} placeholder="e.g. Spouse" />
      </div>
      <Button type="submit" loading={submitting} disabled={!email.trim()}>
        Invite
      </Button>
      {error && <FieldError>{error}</FieldError>}
    </form>
  );
}

function AddDependentForm({ householdId, onAdded }: { householdId: string; onAdded: () => void }) {
  const [displayName, setDisplayName] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/v1/households/${householdId}/dependents`, { displayName, birthDate: birthDate || undefined });
      setDisplayName("");
      setBirthDate("");
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that dependent. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-3 flex flex-wrap items-end gap-2 rounded-lg bg-subtle p-3" noValidate>
      <div className="min-w-[200px] flex-1">
        <Label htmlFor="dependent-name">Name</Label>
        <Input id="dependent-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="e.g. Sam" required />
      </div>
      <div>
        <Label htmlFor="dependent-birth">Birth date (optional)</Label>
        <Input id="dependent-birth" type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
      </div>
      <Button type="submit" loading={submitting} disabled={!displayName.trim()}>
        Add dependent
      </Button>
      {error && <FieldError>{error}</FieldError>}
    </form>
  );
}

function GrantDelegationForm({
  householdId,
  members,
  onGranted,
}: {
  householdId: string;
  members: Member[];
  onGranted: () => void;
}) {
  const [delegateUserId, setDelegateUserId] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function toggleScope(scope: string) {
    setScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/v1/households/${householdId}/delegations`, { delegateUserId, scopes });
      setDelegateUserId("");
      setScopes([]);
      onGranted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't grant that delegation. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (members.length <= 1) {
    return <p className="mt-3 text-sm text-tertiary">Invite another member first to grant them scoped access.</p>;
  }

  return (
    <form onSubmit={onSubmit} className="mt-3 space-y-3 rounded-lg bg-subtle p-3" noValidate>
      <div>
        <Label htmlFor="delegate-select">Grant access to</Label>
        <select
          id="delegate-select"
          value={delegateUserId}
          onChange={(e) => setDelegateUserId(e.target.value)}
          className="h-10 w-full rounded-lg border border-border-default bg-surface px-3 text-sm text-primary"
        >
          <option value="">Choose a member…</option>
          {members
            .filter((m) => m.userId)
            .map((m) => (
              <option key={m.userId} value={m.userId!}>
                {m.displayName ?? m.userId}
              </option>
            ))}
        </select>
      </div>
      <div className="flex flex-wrap gap-3">
        {DELEGATION_SCOPES.map((scope) => (
          <label key={scope} className="flex items-center gap-2 text-sm text-primary">
            <input type="checkbox" checked={scopes.includes(scope)} onChange={() => toggleScope(scope)} />
            {scope}
          </label>
        ))}
      </div>
      <FieldError>{error ?? undefined}</FieldError>
      <Button type="submit" loading={submitting} disabled={!delegateUserId || scopes.length === 0}>
        Grant access
      </Button>
    </form>
  );
}

function RevokeDelegationButton({
  householdId,
  delegationId,
  onRevoked,
}: {
  householdId: string;
  delegationId: string;
  onRevoked: () => void;
}) {
  const [revoking, setRevoking] = useState(false);
  async function revoke() {
    setRevoking(true);
    try {
      await api.post(`/v1/households/${householdId}/delegations/${delegationId}/revoke`);
      onRevoked();
    } finally {
      setRevoking(false);
    }
  }
  return (
    <Button variant="ghost" size="sm" onClick={revoke} disabled={revoking}>
      {revoking ? "Revoking…" : "Revoke"}
    </Button>
  );
}
