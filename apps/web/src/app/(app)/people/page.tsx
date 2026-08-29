"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { api, swrFetcher } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";

interface Person {
  id: string;
  displayLabel: string;
  relationshipLabel: string | null;
  importantDates: Array<{ label: string; dateIso: string }>;
}

const RELATIONSHIP_OPTIONS = ["spouse", "partner", "child", "parent", "sibling", "caregiver", "doctor", "friend", "other"];

export default function PeoplePage() {
  const { data: people, isLoading, mutate } = useSWR<Person[]>("/v1/people", swrFetcher);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [relationship, setRelationship] = useState("");
  const [dateLabel, setDateLabel] = useState("Birthday");
  const [dateIso, setDateIso] = useState("");
  const [creating, setCreating] = useState(false);

  async function createPerson() {
    if (!name.trim()) return;
    setCreating(true);
    try {
      await api.post("/v1/people", {
        displayLabel: name,
        relationshipLabel: relationship || undefined,
        importantDates: dateIso ? [{ label: dateLabel, dateIso }] : undefined,
      });
      setName("");
      setRelationship("");
      setDateIso("");
      setShowForm(false);
      mutate();
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">People</h1>
          <p className="mt-1 text-sm text-tertiary">The people, caregivers, and providers in your life.</p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Cancel" : "Add person"}
        </Button>
      </header>

      {showForm && (
        <Card>
          <CardBody className="space-y-3">
            <div>
              <Label htmlFor="person-name">Name</Label>
              <Input id="person-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jamie Smith" />
            </div>
            <div>
              <Label htmlFor="person-relationship">Relationship</Label>
              <select
                id="person-relationship"
                value={relationship}
                onChange={(e) => setRelationship(e.target.value)}
                className="h-10 w-full rounded-lg border border-border-default bg-surface px-3.5 text-[0.9375rem] text-primary"
              >
                <option value="">None</option>
                {RELATIONSHIP_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="date-label">Important date</Label>
                <Input id="date-label" value={dateLabel} onChange={(e) => setDateLabel(e.target.value)} placeholder="Birthday" />
              </div>
              <div>
                <Label htmlFor="date-value">Date</Label>
                <Input id="date-value" type="date" value={dateIso} onChange={(e) => setDateIso(e.target.value)} />
              </div>
            </div>
            <Button size="sm" loading={creating} onClick={createPerson} disabled={!name.trim()}>
              Save
            </Button>
          </CardBody>
        </Card>
      )}

      {isLoading && <div className="h-16 animate-pulse rounded-xl bg-subtle" />}
      {!isLoading && (!people || people.length === 0) && (
        <EmptyState title="No people added yet" description="Add family members, caregivers, or providers to keep their important dates and history in one place." />
      )}
      {people && people.length > 0 && (
        <div className="divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface">
          {people.map((p) => (
            <Link key={p.id} href={`/people/${p.id}`} className="flex items-center justify-between px-4 py-3 hover:bg-subtle">
              <div>
                <p className="text-sm font-medium text-primary">{p.displayLabel}</p>
                {p.importantDates.length > 0 && (
                  <p className="text-xs text-tertiary">
                    {p.importantDates.map((d) => `${d.label} ${d.dateIso}`).join(" · ")}
                  </p>
                )}
              </div>
              {p.relationshipLabel && <Badge tone="neutral">{p.relationshipLabel}</Badge>}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
