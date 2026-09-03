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

interface VehicleRow {
  id: string;
  label: string;
  make: string | null;
  model: string | null;
  year: number | null;
}

interface MergeCandidateGroup {
  reason: "matching_vin";
  vehicleIds: string[];
  vehicles: VehicleRow[];
}

interface MergeLineageRow {
  vehicle_merge_lineage: {
    id: string;
    survivingVehicleId: string;
    mergedVehicleId: string;
    mergedVehicleSnapshot: Record<string, unknown>;
    mergedAt: string;
    unmergedAt: string | null;
  };
  vehicle_profiles: VehicleRow;
}

function vehicleSummary(v: VehicleRow): string {
  const details = [v.year, v.make, v.model].filter(Boolean).join(" ");
  return details ? `${v.label} (${details})` : v.label;
}

/**
 * §40.1 "Vehicle: VIN [is the] auto-merge standard ... otherwise user confirmation for potentially distinct
 * vehicles" — mirrors life/people/merge/page.tsx exactly, adapted to vehicles' single exact-VIN-match
 * reason. Never auto-merges: a radio picks the surviving vehicle, then "Merge into selected" confirms it.
 */
function MergeCandidateCard({ group, onMerged }: { group: MergeCandidateGroup; onMerged: () => void }) {
  const [survivorId, setSurvivorId] = useState(group.vehicleIds[0]);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function merge() {
    setMerging(true);
    setError(null);
    try {
      for (const vehicleId of group.vehicleIds) {
        if (vehicleId === survivorId) continue;
        await api.post("/v1/vehicles/merge", { survivingVehicleId: survivorId, mergedVehicleId: vehicleId });
      }
      onMerged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't merge these vehicles.");
    } finally {
      setMerging(false);
    }
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <Badge tone="info">Matching VIN</Badge>
        <div className="space-y-1.5">
          {group.vehicles.map((v) => (
            <label key={v.id} className="flex items-center gap-2 text-sm text-primary">
              <input type="radio" name={`survivor-${group.vehicleIds.join("-")}`} checked={survivorId === v.id} onChange={() => setSurvivorId(v.id)} />
              {vehicleSummary(v)}
              {survivorId === v.id && <span className="text-xs text-tertiary">(keep this one)</span>}
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
  const mergedLabel = typeof row.vehicle_merge_lineage.mergedVehicleSnapshot.label === "string" ? (row.vehicle_merge_lineage.mergedVehicleSnapshot.label as string) : "Unknown vehicle";

  async function undo() {
    setUndoing(true);
    setError(null);
    try {
      await api.post(`/v1/vehicles/merge-lineage/${row.vehicle_merge_lineage.id}/unmerge`);
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
          <span className="font-medium">{mergedLabel}</span> merged into <span className="font-medium">{row.vehicle_profiles.label}</span>
        </p>
        <p className="text-xs text-tertiary">
          {new Date(row.vehicle_merge_lineage.mergedAt).toLocaleDateString()}
          {row.vehicle_merge_lineage.unmergedAt && " · undone"}
        </p>
        {error && <p className="mt-1 text-xs text-critical">{error}</p>}
      </div>
      {!row.vehicle_merge_lineage.unmergedAt && (
        <Button size="sm" variant="secondary" onClick={undo} loading={undoing}>
          Undo merge
        </Button>
      )}
    </div>
  );
}

export default function VehiclesMergePage() {
  const {
    data: candidates,
    error: candidatesError,
    isLoading: loadingCandidates,
    mutate: mutateCandidates,
  } = useSWR<MergeCandidateGroup[]>("/v1/vehicles/merge-candidates", swrFetcher);
  const { data: lineage, isLoading: loadingLineage, mutate: mutateLineage } = useSWR<MergeLineageRow[]>("/v1/vehicles/merge-lineage", swrFetcher);

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
        <h1 className="text-2xl font-semibold tracking-tight text-primary">Possible duplicate vehicles</h1>
        <p className="mt-1 text-sm text-tertiary">Veynlo only offers a match on an exact VIN — review each group below and choose which record to keep.</p>
      </header>

      {loadingCandidates && <div className="h-16 animate-pulse rounded-xl bg-subtle" />}
      {!loadingCandidates && candidatesError && !candidates && (
        <FetchError what="possible duplicates" message={candidatesError instanceof ApiError ? candidatesError.message : undefined} onRetry={() => mutateCandidates()} />
      )}
      {!loadingCandidates && candidates && candidates.length === 0 && (
        <EmptyState title="No duplicates found" description="Veynlo checks for an exact VIN match across your vehicles." />
      )}
      {candidates && candidates.length > 0 && (
        <div className="space-y-3">
          {candidates.map((group, i) => (
            <MergeCandidateCard key={`${group.reason}-${group.vehicleIds.join("-")}-${i}`} group={group} onMerged={refreshAll} />
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
                <MergeLineageRowItem key={row.vehicle_merge_lineage.id} row={row} onUndone={refreshAll} />
              ))}
            </CardBody>
          </Card>
        )}
      </section>
    </div>
  );
}
