"use client";

import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { api, swrFetcher, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FetchError } from "@/components/ui/fetch-error";

interface PetRow {
  id: string;
  label: string;
  species: string | null;
  breed: string | null;
}

interface MergeCandidateGroup {
  reason: "matching_name_household_and_species";
  petIds: string[];
  pets: PetRow[];
}

interface MergeLineageRow {
  pet_merge_lineage: {
    id: string;
    survivingPetId: string;
    mergedPetId: string;
    mergedPetSnapshot: Record<string, unknown>;
    mergedAt: string;
    unmergedAt: string | null;
  };
  pet_profiles: PetRow;
}

function petSummary(p: PetRow): string {
  const details = [p.species, p.breed].filter(Boolean).join(" · ");
  return details ? `${p.label} (${details})` : p.label;
}

/**
 * §40.2 "Entity Resolution" — pets have no spec-named merge key (§40.1's table doesn't list pets), so this
 * offers a candidate only on an exact name + household + species match (see PetsService.petMergeKey's own
 * doc comment for the reasoning). Mirrors life/people/merge/page.tsx exactly. Never auto-merges: a radio
 * picks the surviving pet, then "Merge into selected" confirms it.
 */
function MergeCandidateCard({ group, onMerged }: { group: MergeCandidateGroup; onMerged: () => void }) {
  const [survivorId, setSurvivorId] = useState(group.petIds[0]);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function merge() {
    setMerging(true);
    setError(null);
    try {
      for (const petId of group.petIds) {
        if (petId === survivorId) continue;
        await api.post("/v1/pets/merge", { survivingPetId: survivorId, mergedPetId: petId });
      }
      onMerged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't merge these pets.");
    } finally {
      setMerging(false);
    }
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <Badge tone="info">Matching name, household, and species</Badge>
        <div className="space-y-1.5">
          {group.pets.map((p) => (
            <label key={p.id} className="flex items-center gap-2 text-sm text-primary">
              <input type="radio" name={`survivor-${group.petIds.join("-")}`} checked={survivorId === p.id} onChange={() => setSurvivorId(p.id)} />
              {petSummary(p)}
              {survivorId === p.id && <span className="text-xs text-tertiary">(keep this one)</span>}
            </label>
          ))}
        </div>
        <Button size="sm" onClick={merge} loading={merging}>
          Merge into selected
        </Button>
        {error && <p className="text-sm text-critical">{error}</p>}
      </CardBody>
    </Card>
  );
}

function MergeLineageRowItem({ row, onUndone }: { row: MergeLineageRow; onUndone: () => void }) {
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mergedLabel = typeof row.pet_merge_lineage.mergedPetSnapshot.label === "string" ? (row.pet_merge_lineage.mergedPetSnapshot.label as string) : "Unknown pet";

  async function undo() {
    setUndoing(true);
    setError(null);
    try {
      await api.post(`/v1/pets/merge-lineage/${row.pet_merge_lineage.id}/unmerge`);
      onUndone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't undo that merge.");
    } finally {
      setUndoing(false);
    }
  }

  return (
    <div className="flex items-center justify-between border-t border-border-subtle py-3 text-sm first:border-t-0">
      <div>
        <p className="text-primary">
          <span className="font-medium">{mergedLabel}</span> merged into <span className="font-medium">{row.pet_profiles.label}</span>
        </p>
        <p className="text-xs text-tertiary">
          {new Date(row.pet_merge_lineage.mergedAt).toLocaleDateString()}
          {row.pet_merge_lineage.unmergedAt && " · undone"}
        </p>
        {error && <p className="mt-1 text-xs text-critical">{error}</p>}
      </div>
      {!row.pet_merge_lineage.unmergedAt && (
        <Button size="sm" variant="secondary" onClick={undo} loading={undoing}>
          Undo merge
        </Button>
      )}
    </div>
  );
}

export default function PetsMergePage() {
  const {
    data: candidates,
    error: candidatesError,
    isLoading: loadingCandidates,
    mutate: mutateCandidates,
  } = useSWR<MergeCandidateGroup[]>("/v1/pets/merge-candidates", swrFetcher);
  const { data: lineage, isLoading: loadingLineage, mutate: mutateLineage } = useSWR<MergeLineageRow[]>("/v1/pets/merge-lineage", swrFetcher);

  function refreshAll() {
    mutateCandidates();
    mutateLineage();
  }

  return (
    <div className="space-y-6">
      <Link href="/life" className="text-sm text-tertiary hover:text-primary">
        ← Back to Life
      </Link>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">Possible duplicate pets</h1>
        <p className="mt-1 text-sm text-tertiary">Veynlo only offers a match on an exact name, household, and species — review each group below and choose which record to keep.</p>
      </header>

      {loadingCandidates && <div className="h-16 animate-pulse rounded-xl bg-subtle" />}
      {!loadingCandidates && candidatesError && !candidates && (
        <FetchError what="possible duplicates" message={candidatesError instanceof ApiError ? candidatesError.message : undefined} onRetry={() => mutateCandidates()} />
      )}
      {!loadingCandidates && candidates && candidates.length === 0 && (
        <EmptyState title="No duplicates found" description="Veynlo checks for an exact name, household, and species match across your pets." />
      )}
      {candidates && candidates.length > 0 && (
        <div className="space-y-3">
          {candidates.map((group, i) => (
            <MergeCandidateCard key={`${group.reason}-${group.petIds.join("-")}-${i}`} group={group} onMerged={refreshAll} />
          ))}
        </div>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">Merge history</h2>
        {loadingLineage && <div className="h-16 animate-pulse rounded-xl bg-subtle" />}
        {!loadingLineage && (!lineage || lineage.length === 0) && <p className="text-sm text-tertiary">No merges yet.</p>}
        {lineage && lineage.length > 0 && (
          <Card>
            <CardBody>
              {lineage.map((row) => (
                <MergeLineageRowItem key={row.pet_merge_lineage.id} row={row} onUndone={refreshAll} />
              ))}
            </CardBody>
          </Card>
        )}
      </section>
    </div>
  );
}
