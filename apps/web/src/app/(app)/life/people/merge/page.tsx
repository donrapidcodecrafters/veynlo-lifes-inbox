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

interface PersonRow {
  id: string;
  displayName: string;
}

interface MergeCandidateGroup {
  reason: "matching_email" | "matching_phone" | "matching_name_and_organization";
  personIds: string[];
  people: PersonRow[];
}

interface MergeLineageRow {
  person_merge_lineage: {
    id: string;
    survivingPersonId: string;
    mergedPersonId: string;
    mergedPersonSnapshot: Record<string, unknown>;
    mergedAt: string;
    unmergedAt: string | null;
  };
  people: PersonRow;
}

const REASON_LABEL: Record<MergeCandidateGroup["reason"], string> = {
  matching_email: "Matching email address",
  matching_phone: "Matching phone number",
  matching_name_and_organization: "Matching name and organization",
};

/**
 * PEO-002 "ambiguous merges require review" — one card per candidate group (a group can have more than two
 * people, e.g. three contacts that all share the same email), a radio to pick which record survives, and a
 * "Merge into selected" action. `POST /v1/people/merge` only ever takes one surviving/one merged id, so a
 * group of 3+ merges every other member into the chosen survivor one call at a time.
 */
function MergeCandidateCard({ group, onMerged }: { group: MergeCandidateGroup; onMerged: () => void }) {
  const [survivorId, setSurvivorId] = useState(group.personIds[0]);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function merge() {
    setMerging(true);
    setError(null);
    try {
      for (const personId of group.personIds) {
        if (personId === survivorId) continue;
        await api.post("/v1/people/merge", { survivingPersonId: survivorId, mergedPersonId: personId });
      }
      onMerged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't merge these people.");
    } finally {
      setMerging(false);
    }
  }

  return (
    <Card>
      <CardBody className="space-y-3">
        <Badge tone="info">{REASON_LABEL[group.reason]}</Badge>
        <div className="space-y-1.5">
          {group.people.map((p) => (
            <label key={p.id} className="flex items-center gap-2 text-sm text-primary">
              <input
                type="radio"
                name={`survivor-${group.personIds.join("-")}`}
                checked={survivorId === p.id}
                onChange={() => setSurvivorId(p.id)}
              />
              {p.displayName}
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

/** PEO-002 "reversible" — a past merge with `unmergedAt: null` can be undone, restoring the merged-away
 * person and repointing exactly what that merge moved (PeopleService.unmergePeople). `mergedPersonSnapshot`
 * is a full snapshot of the merged-away row taken at merge time, so its display name survives even though
 * that person row itself is excluded from every normal list/detail query until undone. */
function MergeLineageRowItem({ row, onUndone }: { row: MergeLineageRow; onUndone: () => void }) {
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mergedName = typeof row.person_merge_lineage.mergedPersonSnapshot.displayName === "string" ? (row.person_merge_lineage.mergedPersonSnapshot.displayName as string) : "Unknown person";

  async function undo() {
    setUndoing(true);
    setError(null);
    try {
      await api.post(`/v1/people/merge-lineage/${row.person_merge_lineage.id}/unmerge`);
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
          <span className="font-medium">{mergedName}</span> merged into <span className="font-medium">{row.people.displayName}</span>
        </p>
        <p className="text-xs text-tertiary">
          {new Date(row.person_merge_lineage.mergedAt).toLocaleDateString()}
          {row.person_merge_lineage.unmergedAt && " · undone"}
        </p>
        {error && <p className="mt-1 text-xs text-critical">{error}</p>}
      </div>
      {!row.person_merge_lineage.unmergedAt && (
        <Button size="sm" variant="secondary" onClick={undo} loading={undoing}>
          Undo merge
        </Button>
      )}
    </div>
  );
}

export default function PeopleMergePage() {
  const {
    data: candidates,
    error: candidatesError,
    isLoading: loadingCandidates,
    mutate: mutateCandidates,
  } = useSWR<MergeCandidateGroup[]>("/v1/people/merge-candidates", swrFetcher);
  const { data: lineage, isLoading: loadingLineage, mutate: mutateLineage } = useSWR<MergeLineageRow[]>("/v1/people/merge-lineage", swrFetcher);

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
        <h1 className="text-2xl font-semibold tracking-tight text-primary">Possible duplicate people</h1>
        <p className="mt-1 text-sm text-tertiary">Veynlo never merges people automatically — review each group below and choose which record to keep.</p>
      </header>

      {loadingCandidates && <div className="h-16 animate-pulse rounded-xl bg-subtle" />}
      {!loadingCandidates && candidatesError && !candidates && (
        <FetchError what="possible duplicates" message={candidatesError instanceof ApiError ? candidatesError.message : undefined} onRetry={() => mutateCandidates()} />
      )}
      {!loadingCandidates && candidates && candidates.length === 0 && (
        <EmptyState title="No duplicates found" description="Veynlo checks for matching emails, phone numbers, and names + organizations across your people." />
      )}
      {candidates && candidates.length > 0 && (
        <div className="space-y-3">
          {candidates.map((group, i) => (
            <MergeCandidateCard key={`${group.reason}-${group.personIds.join("-")}-${i}`} group={group} onMerged={refreshAll} />
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
                <MergeLineageRowItem key={row.person_merge_lineage.id} row={row} onUndone={refreshAll} />
              ))}
            </CardBody>
          </Card>
        )}
      </section>
    </div>
  );
}
