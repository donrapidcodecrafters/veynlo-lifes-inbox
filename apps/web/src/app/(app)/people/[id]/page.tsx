"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import useSWR from "swr";
import { api, swrFetcher } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { HistorySection } from "@/components/history-section";

interface Person {
  id: string;
  displayLabel: string;
  relationshipLabel: string | null;
  importantDates: Array<{ label: string; dateIso: string }>;
}

const RELATIONSHIP_OPTIONS = ["spouse", "partner", "child", "parent", "sibling", "caregiver", "doctor", "friend", "other"];

export default function PersonDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data, isLoading, mutate } = useSWR<Person | null>(`/v1/people/${id}`, swrFetcher);
  const [name, setName] = useState("");
  const [relationship, setRelationship] = useState("");
  const [dates, setDates] = useState<Array<{ label: string; dateIso: string }>>([]);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (data) {
      setName(data.displayLabel);
      setRelationship(data.relationshipLabel ?? "");
      setDates(data.importantDates);
    }
  }, [data]);

  async function save() {
    setSaving(true);
    try {
      await api.patch(`/v1/people/${id}`, { displayLabel: name, relationshipLabel: relationship || null, importantDates: dates });
      mutate();
    } finally {
      setSaving(false);
    }
  }

  async function deletePerson() {
    setDeleting(true);
    try {
      await api.delete(`/v1/people/${id}`);
      router.push("/people");
    } finally {
      setDeleting(false);
    }
  }

  function addDate() {
    setDates((d) => [...d, { label: "", dateIso: "" }]);
  }

  function updateDate(index: number, patch: Partial<{ label: string; dateIso: string }>) {
    setDates((d) => d.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  }

  function removeDate(index: number) {
    setDates((d) => d.filter((_, i) => i !== index));
  }

  if (isLoading) return <div className="h-40 animate-pulse rounded-xl bg-subtle" />;
  if (!data) return <EmptyState title="Not found" description="This person doesn't exist or you don't have access to them." />;

  return (
    <div className="space-y-6">
      <Link href="/people" className="text-sm text-tertiary hover:text-primary">
        ← Back to People
      </Link>

      <Card>
        <CardBody className="space-y-3">
          <div>
            <Label htmlFor="name">Name</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="relationship">Relationship</Label>
            <select
              id="relationship"
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

          <div className="space-y-2">
            <Label htmlFor="dates">Important dates</Label>
            {dates.map((d, i) => (
              <div key={i} className="flex gap-2">
                <Input value={d.label} onChange={(e) => updateDate(i, { label: e.target.value })} placeholder="Birthday" className="flex-1" />
                <Input type="date" value={d.dateIso} onChange={(e) => updateDate(i, { dateIso: e.target.value })} />
                <Button variant="ghost" size="sm" onClick={() => removeDate(i)}>
                  Remove
                </Button>
              </div>
            ))}
            <Button variant="secondary" size="sm" onClick={addDate}>
              Add date
            </Button>
          </div>

          <div className="flex items-center gap-2 border-t border-border-subtle pt-3">
            <Button size="sm" loading={saving} onClick={save}>
              Save
            </Button>
            <Button size="sm" variant="critical" loading={deleting} onClick={deletePerson}>
              Delete
            </Button>
            {data.relationshipLabel && <Badge tone="neutral">{data.relationshipLabel}</Badge>}
          </div>
        </CardBody>
      </Card>

      <HistorySection resourceType="person" resourceId={data.id} />
    </div>
  );
}
