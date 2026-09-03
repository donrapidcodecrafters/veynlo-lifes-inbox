"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { api, swrFetcher, ApiError } from "@/lib/api-client";
import { SegmentedControl } from "@/components/ui/segmented-control";

export interface MyHousehold {
  household: { id: string; name: string };
}

/** Shared `/v1/households` fetch behind both variants below — SWR dedupes this against any other
 * `useSWR("/v1/households", swrFetcher)` call already on the same page (e.g. the Lists page's own). */
export function useMyHouseholds() {
  return useSWR<MyHousehold[]>("/v1/households", swrFetcher);
}

/** Default-selection rule for a CREATE form only: exactly one household -> default to it (still
 * overridable); zero or 2+ households -> default to private, since there's no safe guess to make. */
export function defaultHouseholdId(households: MyHousehold[] | undefined): string {
  if (households && households.length === 1) return households[0]!.household.id;
  return "";
}

/**
 * Owns a create-form's household selection state: starts private, then auto-applies
 * `defaultHouseholdId` exactly once, the moment `/v1/households` finishes loading (never re-applies
 * after that, so it doesn't clobber a manual choice). `reset()` re-applies the same computed default —
 * call it after a successful submit, alongside the form's other field resets.
 */
export function useHouseholdSelection(households: MyHousehold[] | undefined) {
  const [householdId, setHouseholdId] = useState("");
  const appliedDefaultRef = useRef(false);

  useEffect(() => {
    if (appliedDefaultRef.current || households === undefined) return;
    appliedDefaultRef.current = true;
    setHouseholdId(defaultHouseholdId(households));
  }, [households]);

  function reset() {
    setHouseholdId(defaultHouseholdId(households));
  }

  return { householdId, setHouseholdId, reset };
}

/**
 * Create-time picker — a plain select feeding local form state, submitted with the rest of the create
 * form (send `householdId: value || null`). Mirrors the Lists page's own "Just me (private)" select
 * exactly (lists/page.tsx). Renders nothing if the user has no households at all.
 */
export function HouseholdSelectField({
  households,
  value,
  onChange,
  id,
}: {
  households: MyHousehold[] | undefined;
  value: string;
  onChange: (householdId: string) => void;
  id?: string;
}) {
  if (!households || households.length === 0) return null;
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Household"
      className="h-10 rounded-lg border border-border-default bg-surface px-2 text-sm text-primary"
    >
      <option value="">Just me (private)</option>
      {households.map((h) => (
        <option key={h.household.id} value={h.household.id}>
          {h.household.name}
        </option>
      ))}
    </select>
  );
}

/**
 * Edit-time control — an immediate-save picker mirroring `VisibilityToggle`'s shape
 * (life/people/[id]/page.tsx): the caller passes the resource's current `householdId` plus an
 * `onChange` that performs the actual save (each resource type has its own endpoint/method — PUT for
 * vehicles/properties, PATCH for pets), and this component owns its own saving/error state around that
 * call. Passing `null` to `onChange` means "make private again"; a household id means "share with this
 * household." Renders a short explanation instead of a control when the user belongs to no household yet.
 */
export function HouseholdAssignmentControl({
  householdId,
  onChange,
}: {
  householdId: string | null;
  onChange: (householdId: string | null) => Promise<void>;
}) {
  const { data: households } = useMyHouseholds();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleChange(next: string) {
    setSaving(true);
    setError(null);
    try {
      await onChange(next || null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update household.");
    } finally {
      setSaving(false);
    }
  }

  if (!households || households.length === 0) {
    return <p className="text-xs text-tertiary">Join or create a household in Settings to share this with your household.</p>;
  }

  const currentValue = householdId ?? "";

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-tertiary">Household</p>
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl<string>
          value={currentValue}
          onChange={handleChange}
          aria-label="Household"
          options={[{ value: "", label: "Private" }, ...households.map((h) => ({ value: h.household.id, label: h.household.name }))]}
        />
        {saving && <span className="text-xs text-tertiary">Saving…</span>}
      </div>
      {error && <p className="text-sm text-critical">{error}</p>}
    </div>
  );
}
