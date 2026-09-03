"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import useSWR from "swr";
import { api, swrFetcher, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label, FieldError } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { FetchError } from "@/components/ui/fetch-error";

const CATEGORIES = [
  { value: "", label: "All categories" },
  { value: "product", label: "Product" },
  { value: "place", label: "Place" },
  { value: "recipe", label: "Recipe" },
  { value: "article", label: "Article" },
  { value: "movie_show", label: "Movie/Show" },
  { value: "gift_idea", label: "Gift idea" },
  { value: "event", label: "Event" },
  { value: "trip_idea", label: "Trip idea" },
  { value: "how_to", label: "How-to" },
  { value: "reference", label: "Reference" },
  { value: "document", label: "Document" },
  { value: "generic", label: "Generic" },
] as const;

interface MemoryRow {
  id: string;
  sourceKind: string;
  sourceUrl: string | null;
  title: string | null;
  category: string | null;
  classificationState: "pending" | "classified" | "failed" | "skipped";
  pinned: boolean;
  createdAt: string;
}

function categoryLabel(category: string | null): string {
  return CATEGORIES.find((c) => c.value === category)?.label ?? "Uncategorized";
}

/**
 * §29.1 "Saved Memory, Lists & Knowledge" (SAVE-001..004) — one destination for anything a user
 * intentionally wants to remember, distinct from /lists (FAM-005's household checklists). Category is
 * always editable post-hoc (SAVE-002), so a "pending"/"failed" classification never blocks using or
 * finding what was saved — it's just an unlabeled item until the user or the background classifier fills
 * it in.
 */
export default function SavedMemoriesPage() {
  const [category, setCategory] = useState("");
  const [query, setQuery] = useState("");
  const listPath = category ? `/v1/memories?category=${category}` : "/v1/memories";
  const { data: memories, error: listError, isLoading, mutate } = useSWR<MemoryRow[]>(listPath, swrFetcher);
  const { data: searchResults, isLoading: searching } = useSWR<MemoryRow[]>(
    query.trim() ? `/v1/memories/search?q=${encodeURIComponent(query.trim())}` : null,
    swrFetcher,
  );

  const [sourceUrl, setSourceUrl] = useState("");
  const [rawText, setRawText] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [justSaved, setJustSaved] = useState(false);

  async function saveMemory(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    setFieldErrors({});
    setJustSaved(false);
    try {
      // SAVE-001 "Immediate success confirmation; structure may appear seconds later" — the save
      // completes and confirms right away; category/title fill in later once classification runs.
      const sourceKind = sourceUrl.trim() ? "link" : "text";
      await api.post("/v1/memories", { sourceKind, sourceUrl: sourceUrl.trim() || undefined, rawText: rawText.trim() || undefined });
      setSourceUrl("");
      setRawText("");
      setJustSaved(true);
      mutate();
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors) setFieldErrors(err.fieldErrors);
      setSaveError(err instanceof ApiError ? err.message : "Couldn't save that.");
    } finally {
      setSaving(false);
    }
  }

  const shownMemories = query.trim() ? searchResults : memories;
  const shownLoading = query.trim() ? searching : isLoading;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">Saved</h1>
        <p className="mt-1 text-sm text-tertiary">
          Save any link, product, place, recipe, or note — without deciding right away where it belongs. Private to you unless you share it.
        </p>
      </header>

      <Card>
        <CardBody>
          <form onSubmit={saveMemory} className="space-y-3">
            <div>
              <Label htmlFor="memory-url">Save a link</Label>
              <Input
                id="memory-url"
                placeholder="https://…"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                maxLength={2000}
                error={fieldErrors.sourceUrl?.[0]}
              />
            </div>
            <div>
              <Label htmlFor="memory-text">Or paste/type a note</Label>
              <textarea
                id="memory-text"
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                maxLength={20000}
                rows={2}
                placeholder="Anything you want to remember…"
                className="w-full rounded-lg border border-border-default bg-surface px-3 py-2 text-sm text-primary"
              />
            </div>
            <FieldError>{saveError ?? undefined}</FieldError>
            {justSaved && <p className="text-sm text-positive-subtle-text">Saved — it'll be categorized automatically in a moment.</p>}
            <Button type="submit" loading={saving} disabled={!sourceUrl.trim() && !rawText.trim()}>
              Save
            </Button>
          </form>
        </CardBody>
      </Card>

      <div className="flex flex-wrap gap-3">
        <Input
          placeholder="Search what you've saved…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="min-w-[220px] flex-1"
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="h-10 rounded-lg border border-border-default bg-surface px-3 text-sm text-primary"
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      {shownLoading && <p className="text-sm text-tertiary">Loading…</p>}

      {!shownLoading && listError && !memories && (
        <FetchError what="your saved items" message={listError instanceof ApiError ? listError.message : undefined} onRetry={() => mutate()} />
      )}

      {!shownLoading && !listError && (shownMemories ?? []).length === 0 && (
        <EmptyState
          title={query.trim() ? "No matches" : "Nothing saved yet"}
          description={query.trim() ? "Try a different search term." : "Save a link, a note, or anything else you want to find again later."}
        />
      )}

      {(shownMemories ?? []).length > 0 && (
        <div className="space-y-2">
          {shownMemories!.map((m) => (
            <Link key={m.id} href={`/saved/${m.id}`}>
              <Card className="transition-colors hover:bg-subtle">
                <CardBody className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate text-[0.9375rem] font-medium text-primary">{m.title ?? m.sourceUrl ?? "Untitled save"}</p>
                    <div className="mt-1 flex items-center gap-2">
                      <Badge tone={m.category ? "brand" : "neutral"}>{categoryLabel(m.category)}</Badge>
                      {m.pinned && <Badge tone="warning">Pinned</Badge>}
                      {m.classificationState === "failed" && <Badge tone="critical">Classification failed</Badge>}
                    </div>
                  </div>
                </CardBody>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
