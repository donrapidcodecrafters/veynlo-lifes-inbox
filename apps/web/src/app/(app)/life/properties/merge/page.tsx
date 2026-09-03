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

interface PropertyRow {
  id: string;
  label: string;
  address: string | null;
  propertyType: string;
}

interface MergeCandidateGroup {
  reason: "matching_address";
  propertyIds: string[];
  properties: PropertyRow[];
}

interface MergeLineageRow {
  property_merge_lineage: {
    id: string;
    survivingPropertyId: string;
    mergedPropertyId: string;
    mergedPropertySnapshot: Record<string, unknown>;
    mergedAt: string;
    unmergedAt: string | null;
  };
  property_profiles: PropertyRow;
}

function propertySummary(p: PropertyRow): string {
  return p.address ? `${p.label} (${p.address})` : p.label;
}

/**
 * §40.1 "Property: normalized full address + user property identity ... User confirmation when unit/parcel
 * ambiguity exists" — mirrors life/people/merge/page.tsx exactly, adapted to properties' single
 * exact-normalized-address-match reason. Never auto-merges: a radio picks the surviving property, then
 * "Merge into selected" confirms it.
 */
function MergeCandidateCard({ group, onMerged }: { group: MergeCandidateGroup; onMerged: () => void }) {
  const [survivorId, setSurvivorId] = useState(group.propertyIds[0]);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function merge() {
    setMerging(true);
    setError(null);
    try {
      for (const propertyId of group.propertyIds) {
        if (propertyId === survivorId) continue;
        await api.post("/v1/properties/merge", { survivingPropertyId: survivorId, mergedPropertyId: propertyId });
      }
      onMerged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't merge these properties.");
    } finally {
      setMerging(false);
    }
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <Badge tone="info">Matching address</Badge>
        <div className="space-y-1.5">
          {group.properties.map((p) => (
            <label key={p.id} className="flex items-center gap-2 text-sm text-primary">
              <input type="radio" name={`survivor-${group.propertyIds.join("-")}`} checked={survivorId === p.id} onChange={() => setSurvivorId(p.id)} />
              {propertySummary(p)}
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
  const mergedLabel = typeof row.property_merge_lineage.mergedPropertySnapshot.label === "string" ? (row.property_merge_lineage.mergedPropertySnapshot.label as string) : "Unknown property";

  async function undo() {
    setUndoing(true);
    setError(null);
    try {
      await api.post(`/v1/properties/merge-lineage/${row.property_merge_lineage.id}/unmerge`);
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
          <span className="font-medium">{mergedLabel}</span> merged into <span className="font-medium">{row.property_profiles.label}</span>
        </p>
        <p className="text-xs text-tertiary">
          {new Date(row.property_merge_lineage.mergedAt).toLocaleDateString()}
          {row.property_merge_lineage.unmergedAt && " · undone"}
        </p>
        {error && <p className="mt-1 text-xs text-critical">{error}</p>}
      </div>
      {!row.property_merge_lineage.unmergedAt && (
        <Button size="sm" variant="secondary" onClick={undo} loading={undoing}>
          Undo merge
        </Button>
      )}
    </div>
  );
}

export default function PropertiesMergePage() {
  const {
    data: candidates,
    error: candidatesError,
    isLoading: loadingCandidates,
    mutate: mutateCandidates,
  } = useSWR<MergeCandidateGroup[]>("/v1/properties/merge-candidates", swrFetcher);
  const { data: lineage, isLoading: loadingLineage, mutate: mutateLineage } = useSWR<MergeLineageRow[]>("/v1/properties/merge-lineage", swrFetcher);

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
        <h1 className="text-2xl font-semibold tracking-tight text-primary">Possible duplicate properties</h1>
        <p className="mt-1 text-sm text-tertiary">Veynlo only offers a match on an exact normalized address — review each group below and choose which record to keep.</p>
      </header>

      {loadingCandidates && <div className="h-16 animate-pulse rounded-xl bg-subtle" />}
      {!loadingCandidates && candidatesError && !candidates && (
        <FetchError what="possible duplicates" message={candidatesError instanceof ApiError ? candidatesError.message : undefined} onRetry={() => mutateCandidates()} />
      )}
      {!loadingCandidates && candidates && candidates.length === 0 && (
        <EmptyState title="No duplicates found" description="Veynlo checks for an exact normalized address match across your properties." />
      )}
      {candidates && candidates.length > 0 && (
        <div className="space-y-3">
          {candidates.map((group, i) => (
            <MergeCandidateCard key={`${group.reason}-${group.propertyIds.join("-")}-${i}`} group={group} onMerged={refreshAll} />
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
                <MergeLineageRowItem key={row.property_merge_lineage.id} row={row} onUndone={refreshAll} />
              ))}
            </CardBody>
          </Card>
        )}
      </section>
    </div>
  );
}
