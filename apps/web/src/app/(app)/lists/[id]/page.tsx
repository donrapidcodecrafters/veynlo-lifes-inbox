"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import useSWR from "swr";
import { api, swrFetcher, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, FieldError } from "@/components/ui/input";
import { useSession } from "@/hooks/use-session";
import { ShareResourcePanel } from "@/components/sharing/share-resource-panel";
import { SharedNoteBanner } from "@/components/sharing/shared-note-banner";

interface SavedItem {
  id: string;
  listId: string;
  createdByUserId: string;
  label: string;
  checked: boolean;
  checkedByUserId: string | null;
  assignedToUserId: string | null;
  isPrivate: boolean;
}

interface MatchedMemory {
  id: string;
  title: string | null;
  sourceUrl: string | null;
  category: string | null;
  pinned: boolean;
}

interface ListDetail {
  list: { id: string; name: string; kind: string; ownerUserId: string; householdId: string | null; smartListQuery: Record<string, unknown> | null };
  items: SavedItem[];
  matchedMemories: MatchedMemory[];
  sharedNote: string | null;
}

interface Membership {
  userId: string | null;
  relationshipLabel: string | null;
  invitedEmail: string | null;
  status: "invited" | "active" | "left" | "removed";
}

function memberLabel(m: Membership): string {
  return m.relationshipLabel ?? m.invitedEmail ?? "Household member";
}

export default function ListDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useSession();
  const { data, isLoading, mutate } = useSWR<ListDetail>(`/v1/lists/${id}`, swrFetcher);
  const { data: members } = useSWR<Membership[]>(data?.list.householdId ? `/v1/households/${data.list.householdId}/members` : null, swrFetcher);
  const [label, setLabel] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);

  async function addItem(e: FormEvent) {
    e.preventDefault();
    setAdding(true);
    setError(null);
    try {
      await api.post(`/v1/lists/${id}/items`, { label, isPrivate });
      setLabel("");
      setIsPrivate(false);
      mutate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that item.");
    } finally {
      setAdding(false);
    }
  }

  // toggleChecked/assignItem/deleteItem previously had no try/catch at all — a failed request (a stale
  // item on a list you were just removed from, a dropped connection) silently did nothing: no error
  // shown, and the checkbox/row just snapped back on the next revalidation with no explanation. Now
  // surfaced through the same `error` banner addItem already uses.
  async function toggleChecked(item: SavedItem) {
    setError(null);
    try {
      await api.put(`/v1/lists/items/${item.id}`, { checked: !item.checked });
      mutate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update that item.");
    }
  }

  async function assignItem(item: SavedItem, assignedToUserId: string) {
    setError(null);
    try {
      await api.put(`/v1/lists/items/${item.id}`, { assignedToUserId: assignedToUserId || null });
      mutate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update that item.");
    }
  }

  async function deleteItem(itemId: string) {
    setError(null);
    try {
      await api.delete(`/v1/lists/items/${itemId}`);
      mutate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't remove that item.");
    }
  }

  async function deleteList() {
    if (!confirm("Delete this list and all its items?")) return;
    setError(null);
    try {
      await api.delete(`/v1/lists/${id}`);
      router.replace("/lists");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete this list.");
    }
  }

  if (isLoading) return <p className="text-sm text-tertiary">Loading…</p>;
  if (!data) return <p className="text-sm text-tertiary">List not found.</p>;

  const isOwner = user?.id === data.list.ownerUserId;
  const activeMembers = (members ?? []).filter((m) => m.status === "active" && m.userId);
  const isSmart = Boolean(data.list.smartListQuery);

  return (
    <div className="space-y-6">
      <Link href="/lists" className="text-sm text-tertiary hover:text-primary">
        ← Lists
      </Link>

      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="break-words text-2xl font-semibold tracking-tight text-primary">{data.list.name}</h1>
          <div className="mt-1 flex items-center gap-2">
            {isSmart && <Badge tone="brand">Smart list</Badge>}
            {data.list.householdId && <Badge tone="neutral">Shared</Badge>}
          </div>
        </div>
        {isOwner && (
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => setSharing((s) => !s)}>
              Share
            </Button>
            <Button variant="ghost" onClick={deleteList}>
              Delete list
            </Button>
          </div>
        )}
      </header>

      <SharedNoteBanner note={data.sharedNote} />

      {isOwner && sharing && (
        <Card>
          <CardBody>
            <ShareResourcePanel resourceId={String(id)} collectionPath="/v1/lists" resourceLabel="list" />
          </CardBody>
        </Card>
      )}

      {isSmart ? (
        <p className="text-sm text-tertiary">
          This list auto-matches your saved items — see <Link href="/saved" className="text-brand hover:underline">Saved</Link> to add more.
        </p>
      ) : (
        <Card>
          <CardBody>
            <form onSubmit={addItem} className="flex flex-wrap items-end gap-3">
              <div className="min-w-[200px] flex-1">
                <Input placeholder="Add an item…" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={300} required />
              </div>
              <label className="flex items-center gap-2 pb-2 text-sm text-secondary">
                <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
                Private
              </label>
              <Button type="submit" loading={adding} disabled={!label.trim()}>
                Add
              </Button>
            </form>
            <FieldError>{error ?? undefined}</FieldError>
          </CardBody>
        </Card>
      )}

      {isSmart ? (
        data.matchedMemories.length === 0 ? (
          <p className="text-sm text-tertiary">No saved items match this list's criteria yet.</p>
        ) : (
          <div className="space-y-2">
            {data.matchedMemories.map((m) => (
              <Link key={m.id} href={`/saved/${m.id}`}>
                <Card className="transition-colors hover:bg-subtle">
                  <CardBody className="flex items-center justify-between gap-3">
                    <p className="min-w-0 flex-1 truncate text-[0.9375rem] text-primary">{m.title ?? m.sourceUrl ?? "Untitled save"}</p>
                    {m.pinned && <Badge tone="warning">Pinned</Badge>}
                  </CardBody>
                </Card>
              </Link>
            ))}
          </div>
        )
      ) : data.items.length === 0 ? (
        <p className="text-sm text-tertiary">No items yet — add the first one above.</p>
      ) : (
        <div className="space-y-2">
          {data.items.map((item) => {
            const canManage = isOwner || item.createdByUserId === user?.id;
            return (
              <Card key={item.id}>
                <CardBody className="flex flex-wrap items-center gap-3">
                  <input type="checkbox" checked={item.checked} onChange={() => toggleChecked(item)} aria-label={`Check off ${item.label}`} />
                  <p className={`min-w-[120px] flex-1 truncate text-[0.9375rem] ${item.checked ? "text-tertiary line-through" : "text-primary"}`}>
                    {item.label}
                  </p>
                  {item.isPrivate && <Badge tone="neutral">Private</Badge>}
                  {activeMembers.length > 0 && canManage && (
                    <select
                      value={item.assignedToUserId ?? ""}
                      onChange={(e) => assignItem(item, e.target.value)}
                      className="h-8 shrink-0 rounded-lg border border-border-default bg-surface px-2 text-xs text-secondary"
                    >
                      <option value="">Unassigned</option>
                      {activeMembers.map((m) => (
                        <option key={m.userId} value={m.userId!}>
                          {memberLabel(m)}
                        </option>
                      ))}
                    </select>
                  )}
                  {/* Assignment was only ever rendered inside the canManage-gated <select> above, so anyone
                      without edit rights on this item — including the very person it's assigned to — had no
                      way to see it was assigned to them at all (confirmed live: a household member opening a
                      shared list saw zero indication that an item another member created was assigned to
                      them). Show a read-only indicator to everyone else; only the ability to change the
                      assignment stays gated behind canManage. */}
                  {!canManage && item.assignedToUserId && (
                    <Badge tone="neutral">
                      Assigned: {item.assignedToUserId === user?.id ? "You" : (activeMembers.find((m) => m.userId === item.assignedToUserId) ? memberLabel(activeMembers.find((m) => m.userId === item.assignedToUserId)!) : "Household member")}
                    </Badge>
                  )}
                  {canManage && (
                    <button onClick={() => deleteItem(item.id)} className="shrink-0 text-sm text-tertiary hover:text-critical" aria-label={`Remove ${item.label}`}>
                      Remove
                    </button>
                  )}
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
