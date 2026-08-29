"use client";

import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea, FieldError } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";

interface SavedItem {
  id: string;
  title: string;
  url: string | null;
  note: string | null;
  category: string;
  tags: string[];
  pinned: boolean;
  archived: boolean;
  address: string | null;
  createdAt: string;
}

export default function SavedPage() {
  const { data, isLoading, mutate } = useSWR<SavedItem[]>("/v1/saved-items", swrFetcher);
  const [adding, setAdding] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <Link href="/life" className="text-sm text-tertiary hover:text-primary">
        ← Back to Life
      </Link>
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">Saved</h1>
          <p className="mt-1 text-sm text-tertiary">Links, notes, and anything else worth remembering — no filing decision required.</p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setAdding((v) => !v)}>
          {adding ? "Cancel" : "Save something"}
        </Button>
      </header>

      {adding && <AddForm onDone={() => { setAdding(false); mutate(); }} />}

      {isLoading && (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-subtle" />
          ))}
        </div>
      )}

      {!isLoading && data?.length === 0 && (
        <EmptyState
          title="Nothing saved yet"
          description="Save a link, a quick note, or anything else you want to come back to later — you can sort out what it is afterward."
        />
      )}

      {data && data.length > 0 && (
        <ul className="space-y-2">
          {data.map((item) => (
            <li key={item.id}>
              <Card>
                <CardBody className="space-y-3 py-3">
                  <div className="flex items-center justify-between gap-4">
                    <button type="button" onClick={() => setExpandedId(expandedId === item.id ? null : item.id)} className="min-w-0 flex-1 text-left">
                      <p className="truncate text-sm font-medium text-primary">
                        {item.pinned && "📌 "}
                        {item.title}
                      </p>
                      <p className="truncate text-xs text-tertiary">
                        {item.category === "place" ? (item.address ?? "") : (item.url ?? item.note ?? "")}
                        {item.tags.length > 0 && ` · ${item.tags.join(", ")}`}
                      </p>
                    </button>
                    <div className="flex items-center gap-3">
                      <Badge tone="neutral">{item.category}</Badge>
                      {item.url && (
                        <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-brand hover:underline">
                          Open
                        </a>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}>
                        {expandedId === item.id ? "Close" : "Edit"}
                      </Button>
                    </div>
                  </div>
                  {expandedId === item.id && <ItemEditor item={item} onChanged={mutate} />}
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AddForm({ onDone }: { onDone: () => void }) {
  const [isPlace, setIsPlace] = useState(false);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (isPlace) {
        await api.post("/v1/saved-items", { title, address: address || undefined, note: note || undefined, category: "place" });
      } else {
        await api.post("/v1/saved-items", { title, url: url || undefined, note: note || undefined });
      }
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save that. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardBody>
        <form onSubmit={submit} className="space-y-3" noValidate>
          <div className="flex gap-1 rounded-lg bg-subtle p-1" role="tablist">
            {([false, true] as const).map((place) => (
              <button
                key={String(place)}
                type="button"
                role="tab"
                aria-selected={isPlace === place}
                onClick={() => setIsPlace(place)}
                className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  isPlace === place ? "bg-surface text-primary shadow-xs" : "text-tertiary"
                }`}
              >
                {place ? "A place" : "Link or note"}
              </button>
            ))}
          </div>
          <div>
            <Label htmlFor="saved-title">Title</Label>
            <Input id="saved-title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={500} />
          </div>
          {isPlace ? (
            <div>
              <Label htmlFor="saved-address">Address (optional)</Label>
              <Input id="saved-address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="123 Main St, Springfield" />
            </div>
          ) : (
            <div>
              <Label htmlFor="saved-url">Link (optional)</Label>
              <Input id="saved-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" />
            </div>
          )}
          <div>
            <Label htmlFor="saved-note">Note (optional)</Label>
            <Textarea id="saved-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <FieldError>{error ?? undefined}</FieldError>
          <Button type="submit" size="sm" loading={saving}>
            Save
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

function ItemEditor({ item, onChanged }: { item: SavedItem; onChanged: () => void }) {
  const [title, setTitle] = useState(item.title);
  const [note, setNote] = useState(item.note ?? "");
  const [address, setAddress] = useState(item.address ?? "");
  const [tags, setTags] = useState(item.tags.join(", "));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/v1/saved-items/${item.id}`, {
        title,
        note,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        ...(item.category === "place" ? { address } : {}),
      });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save changes. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function togglePin() {
    await api.patch(`/v1/saved-items/${item.id}`, { pinned: !item.pinned });
    onChanged();
  }

  async function archive() {
    await api.patch(`/v1/saved-items/${item.id}`, { archived: true });
    onChanged();
  }

  async function remove() {
    await api.delete(`/v1/saved-items/${item.id}`);
    onChanged();
  }

  return (
    <div className="space-y-3 border-t border-border-subtle pt-3">
      <div>
        <Label htmlFor={`title-${item.id}`}>Title</Label>
        <Input id={`title-${item.id}`} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      {item.category === "place" && (
        <div>
          <Label htmlFor={`address-${item.id}`}>Address</Label>
          <Input id={`address-${item.id}`} value={address} onChange={(e) => setAddress(e.target.value)} />
        </div>
      )}
      <div>
        <Label htmlFor={`note-${item.id}`}>Note</Label>
        <Textarea id={`note-${item.id}`} rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div>
        <Label htmlFor={`tags-${item.id}`}>Tags (comma-separated)</Label>
        <Input id={`tags-${item.id}`} value={tags} onChange={(e) => setTags(e.target.value)} />
      </div>
      <FieldError>{error ?? undefined}</FieldError>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={save} loading={saving}>
          Save changes
        </Button>
        <Button size="sm" variant="ghost" onClick={togglePin}>
          {item.pinned ? "Unpin" : "Pin"}
        </Button>
        <Button size="sm" variant="ghost" onClick={archive}>
          Archive
        </Button>
        <Button size="sm" variant="critical" onClick={remove}>
          Delete
        </Button>
      </div>
    </div>
  );
}
