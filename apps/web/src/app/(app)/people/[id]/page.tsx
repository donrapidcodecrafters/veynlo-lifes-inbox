"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import useSWR from "swr";
import { api, swrFetcher, ApiError } from "@/lib/api-client";
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

interface LinkedItems {
  purchases: Array<{ id: string; merchantName: string | null }>;
  bills: Array<{ id: string; billerLabel: string }>;
  warranties: Array<{ id: string; productLabel: string }>;
  events: Array<{ id: string; title: string }>;
}

type LinkableType = "purchase" | "bill" | "warranty" | "event";

const LINKABLE_TYPES: Array<{ value: LinkableType; label: string; listUrl: string; detailPath: string; endpointSegment: string }> = [
  { value: "purchase", label: "Purchase", listUrl: "/v1/purchases", detailPath: "/life/purchases", endpointSegment: "purchases" },
  { value: "bill", label: "Bill", listUrl: "/v1/bills", detailPath: "/life/bills", endpointSegment: "bills" },
  { value: "warranty", label: "Warranty", listUrl: "/v1/warranties", detailPath: "/life/warranties", endpointSegment: "warranties" },
  { value: "event", label: "Appointment", listUrl: "/v1/events", detailPath: "/life/events", endpointSegment: "events" },
];

const RELATIONSHIP_OPTIONS = ["spouse", "partner", "child", "parent", "sibling", "caregiver", "doctor", "friend", "other"];

export default function PersonDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data, isLoading, mutate } = useSWR<Person | null>(`/v1/people/${id}`, swrFetcher);
  const { data: linkedItems, mutate: mutateLinkedItems } = useSWR<LinkedItems>(`/v1/people/${id}/linked-items`, swrFetcher);
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
                <Input value={d.label} onChange={(e) => updateDate(i, { label: e.target.value })} placeholder="Birthday" className="min-w-0 flex-1" />
                {/* Input's shared base style is `w-full` — inside this flex row that would claim the row's
                    full width as this field's flex-basis, starving the label field next to it down to
                    almost nothing. A class can't reliably beat `w-full` here (this app's cn() is a plain
                    string join, not tailwind-merge, so class override order isn't guaranteed), so this
                    overrides via inline style instead. */}
                <Input
                  type="date"
                  value={d.dateIso}
                  onChange={(e) => updateDate(i, { dateIso: e.target.value })}
                  className="shrink-0"
                  style={{ width: "auto" }}
                />
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

      <LinkedItemsCard personId={data.id} items={linkedItems} onChange={() => mutateLinkedItems()} />

      <HistorySection resourceType="person" resourceId={data.id} />
    </div>
  );
}

/** PEO-004 "person linkage" — every purchase/bill/warranty/appointment manually linked to this person
 * (a contractor, a gift recipient), plus the ability to add a new one. Always manual: nothing infers a
 * link from evidence today. */
function LinkedItemsCard({ personId, items, onChange }: { personId: string; items: LinkedItems | undefined; onChange: () => void }) {
  const [addingType, setAddingType] = useState<LinkableType | null>(null);
  const [candidates, setCandidates] = useState<Array<{ id: string; label: string }>>([]);
  const [selectedCandidateId, setSelectedCandidateId] = useState("");
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startAdding(type: LinkableType) {
    setAddingType(type);
    setError(null);
    setSelectedCandidateId("");
    setLoadingCandidates(true);
    try {
      const config = LINKABLE_TYPES.find((t) => t.value === type)!;
      const rows = await api.get<Array<Record<string, unknown>>>(config.listUrl);
      setCandidates(
        rows.map((r) => ({
          id: r.id as string,
          label: type === "purchase" ? ((r.merchantName as string | null) ?? "Untitled purchase") : type === "bill" ? (r.billerLabel as string) : type === "warranty" ? (r.productLabel as string) : (r.title as string),
        })),
      );
    } finally {
      setLoadingCandidates(false);
    }
  }

  async function confirmAdd() {
    if (!addingType || !selectedCandidateId) return;
    setSaving(true);
    setError(null);
    try {
      const config = LINKABLE_TYPES.find((t) => t.value === addingType)!;
      await api.post(`/v1/${config.endpointSegment}/${selectedCandidateId}/link-person`, { personId });
      setAddingType(null);
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't link that item.");
    } finally {
      setSaving(false);
    }
  }

  async function unlink(type: LinkableType, itemId: string) {
    const config = LINKABLE_TYPES.find((t) => t.value === type)!;
    await api.post(`/v1/${config.endpointSegment}/${itemId}/unlink-person`, { personId });
    onChange();
  }

  if (!items) return null;
  const hasAny = items.purchases.length > 0 || items.bills.length > 0 || items.warranties.length > 0 || items.events.length > 0;

  return (
    <Card>
      <CardBody className="space-y-3">
        <p className="text-[0.9375rem] font-medium text-primary">Linked items</p>
        {!hasAny && <p className="text-sm text-tertiary">Nothing linked to this person yet.</p>}

        {items.purchases.map((p) => (
          <LinkedItemRow key={p.id} href={`/life/purchases/${p.id}`} label={p.merchantName ?? "Untitled purchase"} onUnlink={() => unlink("purchase", p.id)} />
        ))}
        {items.bills.map((b) => (
          <LinkedItemRow key={b.id} href={`/life/bills/${b.id}`} label={b.billerLabel} onUnlink={() => unlink("bill", b.id)} />
        ))}
        {items.warranties.map((w) => (
          <LinkedItemRow key={w.id} href={`/life/warranties/${w.id}`} label={w.productLabel} onUnlink={() => unlink("warranty", w.id)} />
        ))}
        {items.events.map((e) => (
          <LinkedItemRow key={e.id} href={`/life/events/${e.id}`} label={e.title} onUnlink={() => unlink("event", e.id)} />
        ))}

        {!addingType && (
          <div className="flex flex-wrap gap-2 border-t border-border-subtle pt-3">
            {LINKABLE_TYPES.map((t) => (
              <Button key={t.value} variant="secondary" size="sm" onClick={() => startAdding(t.value)}>
                Link a {t.label.toLowerCase()}
              </Button>
            ))}
          </div>
        )}

        {addingType && (
          <div className="space-y-2 border-t border-border-subtle pt-3">
            {loadingCandidates && <p className="text-sm text-tertiary">Loading…</p>}
            {!loadingCandidates && candidates.length === 0 && <p className="text-sm text-tertiary">Nothing to link yet.</p>}
            {!loadingCandidates && candidates.length > 0 && (
              <select
                value={selectedCandidateId}
                onChange={(e) => setSelectedCandidateId(e.target.value)}
                className="h-10 w-full rounded-lg border border-border-default bg-surface px-3.5 text-[0.9375rem] text-primary"
              >
                <option value="">Choose one…</option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            )}
            {error && <p className="text-sm text-critical">{error}</p>}
            <div className="flex gap-2">
              <Button size="sm" loading={saving} disabled={!selectedCandidateId} onClick={confirmAdd}>
                Link
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setAddingType(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function LinkedItemRow({ href, label, onUnlink }: { href: string; label: string; onUnlink: () => void }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <Link href={href} className="text-brand hover:underline">
        {label}
      </Link>
      <button type="button" onClick={onUnlink} className="text-xs text-tertiary hover:text-critical">
        Unlink
      </button>
    </div>
  );
}
