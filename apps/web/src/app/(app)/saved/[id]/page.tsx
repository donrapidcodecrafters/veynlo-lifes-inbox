"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import useSWR from "swr";
import { api, swrFetcher, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label, FieldError } from "@/components/ui/input";
import { FetchError } from "@/components/ui/fetch-error";
import { useSession } from "@/hooks/use-session";
import { ShareResourcePanel } from "@/components/sharing/share-resource-panel";

const CATEGORIES = [
  "product",
  "place",
  "recipe",
  "article",
  "movie_show",
  "gift_idea",
  "event",
  "trip_idea",
  "how_to",
  "reference",
  "document",
  "generic",
] as const;

interface MemoryDetail {
  id: string;
  ownerUserId: string;
  sourceKind: string;
  sourceUrl: string | null;
  rawText: string | null;
  title: string | null;
  userNotes: string | null;
  category: string | null;
  categoryConfidence: number | null;
  relatedPersonLabel: string | null;
  classificationState: "pending" | "classified" | "failed" | "skipped";
  pinned: boolean;
  archivedAt: string | null;
  neverResurface: boolean;
  autoArchiveAt: string | null;
  notUsefulAt: string | null;
  promotedEntityType: string | null;
  promotedEntityId: string | null;
  // SAVE-006 "tags, ratings, highlights."
  tags: string[];
  rating: number | null;
  highlights: string[];
}

interface ResurfacingRule {
  id: string;
  triggerType: "date" | "person_birthday" | "trip_location" | "location_proximity";
  // Shape depends on triggerType — see CreateResurfacingRuleDtoSchema (services/api/src/modules/memories/
  // dto.ts): {date} | {dependentProfileId, daysBefore} | {locationLabel} | {placeId}.
  triggerConfig: Record<string, unknown>;
  active: boolean;
  lastFiredAt: string | null;
}

interface MyHouseholdRow {
  household: { id: string; name: string };
}

interface HouseholdDependent {
  id: string;
  displayName: string;
  birthDate: string | null;
}

interface PlaceRow {
  id: string;
  label: string;
}

interface TripRow {
  id: string;
  destinationLabel: string | null;
  status: string;
}

const RESURFACING_RULE_TYPES = [
  { value: "date", label: "On a date" },
  { value: "person_birthday", label: "Before a person's birthday" },
  { value: "trip_location", label: "When I plan a matching trip" },
  { value: "location_proximity", label: "When I'm near a saved place" },
] as const;

// SAVE-007 "Archive automatically after..." — relative quick-picks alongside a real date picker, so the
// common case ("in a week/month") doesn't require the user to do date math themselves.
const AUTO_ARCHIVE_QUICK_PICKS = [
  { label: "In 7 days", days: 7 },
  { label: "In 30 days", days: 30 },
  { label: "In 90 days", days: 90 },
] as const;

/** §29.1 SAVE-001/002/007 — view/edit a single saved memory: category, notes, pin/archive/never-resurface,
 * and object sharing (reuses the same generic ShareResourcePanel documents/lists already use). */
export default function SavedMemoryDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useSession();
  const { data: memory, error: fetchError, isLoading, mutate } = useSWR<MemoryDetail>(`/v1/memories/${id}`, swrFetcher);
  const { data: rules, mutate: mutateRules } = useSWR<ResurfacingRule[]>(`/v1/memories/${id}/resurfacing-rules`, swrFetcher);
  // SAVE-004 "Contextual resurfacing" — person_birthday/trip_location/location_proximity rules all need to
  // be keyed against something real the user already has (a household dependent, one of their own saved
  // places), never invented free-text the backend couldn't resolve. Fetched unconditionally alongside the
  // memory itself (small, owner-scoped lists — same "always fetch, it's cheap" pattern life/people/[id]
  // uses for its own dependents fetch) so the rule form has them ready the moment the user opens it.
  const { data: households } = useSWR<MyHouseholdRow[]>("/v1/households", swrFetcher);
  const primaryHouseholdId = households?.[0]?.household.id ?? null;
  const { data: dependents } = useSWR<HouseholdDependent[]>(primaryHouseholdId ? `/v1/households/${primaryHouseholdId}/dependents` : null, swrFetcher);
  const { data: places } = useSWR<PlaceRow[]>("/v1/places", swrFetcher);
  const { data: trips } = useSWR<TripRow[]>("/v1/trips", swrFetcher);
  const dependentsById = new Map((dependents ?? []).map((d) => [d.id, d.displayName]));
  const placesById = new Map((places ?? []).map((p) => [p.id, p.label]));
  const upcomingTrips = (trips ?? []).filter((t) => (t.status === "upcoming" || t.status === "active") && t.destinationLabel);

  const [title, setTitle] = useState("");
  const [userNotes, setUserNotes] = useState("");
  const [editingNotes, setEditingNotes] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [ruleType, setRuleType] = useState<ResurfacingRule["triggerType"]>("date");
  const [ruleDate, setRuleDate] = useState("");
  const [ruleDependentId, setRuleDependentId] = useState("");
  const [ruleDaysBefore, setRuleDaysBefore] = useState("14");
  const [ruleLocationLabel, setRuleLocationLabel] = useState("");
  const [rulePlaceId, setRulePlaceId] = useState("");
  const [addingRule, setAddingRule] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [highlightInput, setHighlightInput] = useState("");
  const [autoArchiveDate, setAutoArchiveDate] = useState("");

  if (isLoading) return <p className="text-sm text-tertiary">Loading…</p>;
  // A failed GET previously fell straight through to the same "not found" copy as a genuinely
  // missing memory, which reads as data loss instead of a retryable network/server hiccup — the
  // exact gap the FetchError sweep already closed on the other Life detail pages (pets/vehicles/
  // properties) and the saved/trips list pages. Mirror that fix here.
  if (fetchError && !memory) {
    return (
      <div className="space-y-6">
        <Link href="/saved" className="text-sm text-tertiary hover:text-primary">
          ← Saved
        </Link>
        <FetchError what="this saved item" message={fetchError instanceof ApiError ? fetchError.message : undefined} onRetry={() => mutate()} />
      </div>
    );
  }
  if (!memory) return <p className="text-sm text-tertiary">Saved item not found.</p>;

  const isOwner = user?.id === memory.ownerUserId;

  function startEditingNotes() {
    setTitle(memory!.title ?? "");
    setUserNotes(memory!.userNotes ?? "");
    setEditingNotes(true);
  }

  async function saveNotes() {
    setSaving(true);
    setError(null);
    try {
      await api.put(`/v1/memories/${id}`, { title: title || undefined, userNotes });
      setEditingNotes(false);
      mutate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  }

  async function setCategory(category: string) {
    setError(null);
    try {
      await api.put(`/v1/memories/${id}`, { category });
      mutate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update the category.");
    }
  }

  async function toggle(field: "pinned" | "archived" | "neverResurface" | "markNotUseful", value: boolean) {
    setError(null);
    try {
      await api.put(`/v1/memories/${id}`, { [field]: value });
      mutate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't update that.");
    }
  }

  async function deleteMemory() {
    if (!confirm("Delete this saved item?")) return;
    try {
      await api.delete(`/v1/memories/${id}`);
      router.replace("/saved");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete this item.");
    }
  }

  // Matches CreateResurfacingRuleDtoSchema's discriminated union exactly (services/api/src/modules/
  // memories/dto.ts) — one request shape per triggerType, so all 4 SAVE-004 trigger types are reachable
  // from the UI, not just `date`.
  function canCreateRule(): boolean {
    if (ruleType === "date") return Boolean(ruleDate);
    if (ruleType === "person_birthday") return Boolean(ruleDependentId);
    if (ruleType === "trip_location") return Boolean(ruleLocationLabel.trim());
    return Boolean(rulePlaceId);
  }

  async function createRule() {
    if (!canCreateRule()) return;
    setError(null);
    setAddingRule(true);
    try {
      const body =
        ruleType === "date"
          ? { triggerType: "date" as const, dateIso: new Date(ruleDate).toISOString() }
          : ruleType === "person_birthday"
            ? { triggerType: "person_birthday" as const, dependentProfileId: ruleDependentId, daysBefore: Number(ruleDaysBefore) || 0 }
            : ruleType === "trip_location"
              ? { triggerType: "trip_location" as const, locationLabel: ruleLocationLabel.trim() }
              : { triggerType: "location_proximity" as const, placeId: rulePlaceId };
      await api.post(`/v1/memories/${id}/resurfacing-rules`, body);
      setRuleDate("");
      setRuleDependentId("");
      setRuleDaysBefore("14");
      setRuleLocationLabel("");
      setRulePlaceId("");
      mutateRules();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't set that reminder.");
    } finally {
      setAddingRule(false);
    }
  }

  /** Human-readable detail for one rule's `triggerConfig`, resolving IDs (dependent/place) against the
   * lists already fetched for the create-rule form so the row reads as "Before Mia's birthday," not
   * "Before a person's birthday" with no name. */
  function ruleDetail(rule: ResurfacingRule): string {
    const config = rule.triggerConfig;
    if (rule.triggerType === "date") {
      const date = typeof config.date === "string" ? new Date(config.date) : null;
      return date && !Number.isNaN(date.getTime()) ? `Reminds me on ${date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}` : "Reminds me on a date";
    }
    if (rule.triggerType === "person_birthday") {
      const name = typeof config.dependentProfileId === "string" ? dependentsById.get(config.dependentProfileId) : undefined;
      const daysBefore = typeof config.daysBefore === "number" ? config.daysBefore : 14;
      return name ? `Reminds me ${daysBefore} day${daysBefore === 1 ? "" : "s"} before ${name}'s birthday` : "Reminds me before a person's birthday";
    }
    if (rule.triggerType === "trip_location") {
      return typeof config.locationLabel === "string" ? `Reminds me when I plan a trip to ${config.locationLabel}` : "Reminds me when I plan a matching trip";
    }
    const placeLabel = typeof config.placeId === "string" ? placesById.get(config.placeId) : undefined;
    return placeLabel ? `Reminds me when I'm near ${placeLabel}` : "Reminds me when I'm near a saved place";
  }

  async function removeRule(ruleId: string) {
    try {
      await api.delete(`/v1/memories/resurfacing-rules/${ruleId}`);
      mutateRules();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't remove that reminder.");
    }
  }

  // SAVE-006 "tags, ratings, highlights" — each control sends the whole replacement array/value, mirroring
  // the API's own whole-value PUT shape (see UpdateMemoryDtoSchema's doc comment).
  async function addTag() {
    const value = tagInput.trim();
    if (!value || !memory) return;
    if (memory.tags.includes(value)) {
      setTagInput("");
      return;
    }
    setError(null);
    try {
      await api.put(`/v1/memories/${id}`, { tags: [...memory.tags, value] });
      setTagInput("");
      mutate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that tag.");
    }
  }

  async function removeTag(tag: string) {
    if (!memory) return;
    setError(null);
    try {
      await api.put(`/v1/memories/${id}`, { tags: memory.tags.filter((t) => t !== tag) });
      mutate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't remove that tag.");
    }
  }

  async function setRating(rating: number | null) {
    setError(null);
    try {
      await api.put(`/v1/memories/${id}`, { rating });
      mutate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save that rating.");
    }
  }

  async function addHighlight() {
    const value = highlightInput.trim();
    if (!value || !memory) return;
    setError(null);
    try {
      await api.put(`/v1/memories/${id}`, { highlights: [...memory.highlights, value] });
      setHighlightInput("");
      mutate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't add that highlight.");
    }
  }

  async function removeHighlight(index: number) {
    if (!memory) return;
    setError(null);
    try {
      await api.put(`/v1/memories/${id}`, { highlights: memory.highlights.filter((_, i) => i !== index) });
      mutate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't remove that highlight.");
    }
  }

  // SAVE-007 "auto-archive after a condition" — wired to the existing (already-working) `autoArchiveAt`
  // backend field/scan; this is purely the missing UI control.
  async function setAutoArchiveInDays(days: number) {
    setError(null);
    try {
      await api.put(`/v1/memories/${id}`, { autoArchiveAtIso: new Date(Date.now() + days * 86_400_000).toISOString() });
      mutate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't set auto-archive.");
    }
  }

  async function setAutoArchiveOnDate() {
    if (!autoArchiveDate) return;
    setError(null);
    try {
      await api.put(`/v1/memories/${id}`, { autoArchiveAtIso: new Date(autoArchiveDate).toISOString() });
      setAutoArchiveDate("");
      mutate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't set auto-archive.");
    }
  }

  async function clearAutoArchive() {
    setError(null);
    try {
      await api.put(`/v1/memories/${id}`, { autoArchiveAtIso: null });
      mutate();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't clear auto-archive.");
    }
  }

  return (
    <div className="space-y-6">
      <Link href="/saved" className="text-sm text-tertiary hover:text-primary">
        ← Saved
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          {editingNotes ? (
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" maxLength={300} className="mb-2 max-w-md" />
          ) : (
            <h1 className="break-words text-2xl font-semibold tracking-tight text-primary">{memory.title ?? memory.sourceUrl ?? "Untitled save"}</h1>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {memory.pinned && <Badge tone="warning">Pinned</Badge>}
            {memory.archivedAt && <Badge tone="neutral">Archived</Badge>}
            {memory.classificationState === "pending" && <Badge tone="info">Categorizing…</Badge>}
            {memory.classificationState === "failed" && <Badge tone="critical">Categorization failed</Badge>}
          </div>
        </div>
        {isOwner && (
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <Button variant="ghost" size="sm" onClick={() => toggle("pinned", !memory.pinned)}>
              {memory.pinned ? "Unpin" : "Pin"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => toggle("archived", !memory.archivedAt)}>
              {memory.archivedAt ? "Unarchive" : "Archive"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSharing((s) => !s)}>
              Share
            </Button>
            <Button variant="ghost" size="sm" onClick={deleteMemory}>
              Delete
            </Button>
          </div>
        )}
      </header>

      {error && <p className="text-sm text-critical">{error}</p>}

      {isOwner && sharing && (
        <Card>
          <CardBody>
            <ShareResourcePanel resourceId={String(id)} collectionPath="/v1/memories" resourceLabel="saved item" />
          </CardBody>
        </Card>
      )}

      <Card>
        <CardBody className="space-y-3">
          <div>
            <p className="mb-1.5 text-sm font-medium text-secondary">Category</p>
            {/* SAVE-002 "Category is editable and not required before save" — every category is always a
                plain, always-clickable choice, whether or not the classifier ever ran. */}
            <div className="flex flex-wrap gap-1.5">
              {CATEGORIES.map((c) => (
                <button
                  key={c}
                  disabled={!isOwner}
                  onClick={() => setCategory(c)}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                    memory.category === c ? "bg-brand text-on-brand" : "bg-subtle text-secondary hover:bg-border-subtle"
                  }`}
                >
                  {c.replace(/_/g, " ")}
                </button>
              ))}
            </div>
          </div>

          {memory.sourceUrl && (
            <div>
              <p className="text-sm font-medium text-secondary">Source</p>
              <a href={memory.sourceUrl} target="_blank" rel="noopener noreferrer" className="break-all text-sm text-brand hover:underline">
                {memory.sourceUrl}
              </a>
            </div>
          )}

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <p className="text-sm font-medium text-secondary">Notes</p>
              {isOwner && !editingNotes && (
                <button onClick={startEditingNotes} className="text-xs font-medium text-brand hover:underline">
                  Edit
                </button>
              )}
            </div>
            {editingNotes ? (
              <div className="space-y-2">
                <Textarea value={userNotes} onChange={(e) => setUserNotes(e.target.value)} rows={3} placeholder="Why did you save this?" maxLength={5000} />
                <FieldError>{undefined}</FieldError>
                <div className="flex gap-2">
                  <Button size="sm" loading={saving} onClick={saveNotes}>
                    Save
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setEditingNotes(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <p className="break-words text-sm text-primary">
                {memory.userNotes ? (
                  memory.userNotes
                ) : (
                  // SAVE-006 "notes... can stay private when base item is shared" — the API never returns
                  // another owner's notes to a grantee, so an empty value here is ambiguous between "no
                  // notes exist" and "they're private"; only the owner's own empty case says the former.
                  <span className="text-tertiary">{isOwner ? "No notes yet." : "Notes are private to the owner."}</span>
                )}
              </p>
            )}
          </div>

          {isOwner && (
            <div>
              <p className="mb-1.5 text-sm font-medium text-secondary">Rating</p>
              <div className="flex items-center gap-1">
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    type="button"
                    aria-label={`Rate ${star} star${star === 1 ? "" : "s"}`}
                    onClick={() => setRating(memory.rating === star ? null : star)}
                    className={`text-xl leading-none ${memory.rating != null && star <= memory.rating ? "text-warning" : "text-tertiary hover:text-secondary"}`}
                  >
                    ★
                  </button>
                ))}
                {memory.rating != null && (
                  <button onClick={() => setRating(null)} className="ml-2 text-xs text-tertiary hover:text-critical">
                    Clear
                  </button>
                )}
              </div>
            </div>
          )}

          {(isOwner || memory.tags.length > 0) && (
            <div>
              <p className="mb-1.5 text-sm font-medium text-secondary">Tags</p>
              <div className="flex flex-wrap items-center gap-1.5">
                {memory.tags.map((tag) => (
                  <Badge key={tag} tone="neutral">
                    <span className="flex items-center gap-1">
                      {tag}
                      {isOwner && (
                        <button aria-label={`Remove tag ${tag}`} onClick={() => removeTag(tag)} className="text-tertiary hover:text-critical">
                          ×
                        </button>
                      )}
                    </span>
                  </Badge>
                ))}
                {isOwner && (
                  <div className="flex items-center gap-1">
                    <Input
                      value={tagInput}
                      onChange={(e) => setTagInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void addTag();
                        }
                      }}
                      placeholder="Add a tag"
                      maxLength={60}
                      className="h-7 w-32 text-xs"
                    />
                    <Button size="sm" variant="ghost" onClick={addTag} disabled={!tagInput.trim()}>
                      Add
                    </Button>
                  </div>
                )}
                {!isOwner && memory.tags.length === 0 && <span className="text-sm text-tertiary">No tags.</span>}
              </div>
            </div>
          )}

          {(isOwner || memory.highlights.length > 0) && (
            <div>
              <p className="mb-1.5 text-sm font-medium text-secondary">Highlights</p>
              {memory.highlights.length > 0 ? (
                <ul className="space-y-1.5">
                  {memory.highlights.map((highlight, i) => (
                    <li key={i} className="flex items-start justify-between gap-2 rounded-lg bg-subtle px-3 py-2 text-sm text-primary">
                      <span className="break-words">{highlight}</span>
                      {isOwner && (
                        <button onClick={() => removeHighlight(i)} className="shrink-0 text-xs text-tertiary hover:text-critical">
                          Remove
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                isOwner && <p className="text-sm text-tertiary">No highlights saved yet.</p>
              )}
              {isOwner && (
                <div className="mt-2 flex gap-2">
                  <Textarea
                    value={highlightInput}
                    onChange={(e) => setHighlightInput(e.target.value)}
                    placeholder="Quote a passage you want to remember…"
                    rows={2}
                    maxLength={2000}
                    className="flex-1"
                  />
                  <Button size="sm" variant="secondary" onClick={addHighlight} disabled={!highlightInput.trim()}>
                    Add
                  </Button>
                </div>
              )}
            </div>
          )}

          {memory.rawText && !editingNotes && (
            <div>
              <p className="text-sm font-medium text-secondary">Saved text</p>
              {/* A long unbroken run of characters with no spaces (e.g. pasted from a source with no
                  wrapping) — confirmed live, a ~400-char run — doesn't wrap on `whitespace-pre-wrap`
                  alone (it only breaks at existing whitespace/newlines), which blew this single line out
                  to ~4200px and pushed the whole page layout, sidebar included, into a sliver on the left.
                  `break-words` (overflow-wrap: break-word) forces a break inside the word itself. */}
              <p className="whitespace-pre-wrap break-words text-sm text-primary">{memory.rawText}</p>
            </div>
          )}
        </CardBody>
      </Card>

      {isOwner && (
        <Card>
          <CardBody className="space-y-3">
            <p className="text-sm font-medium text-secondary">Resurfacing</p>
            <label className="flex items-center gap-2 text-sm text-secondary">
              <input type="checkbox" checked={memory.neverResurface} onChange={(e) => toggle("neverResurface", e.target.checked)} />
              Never resurface this automatically
            </label>
            <label className="flex items-center gap-2 text-sm text-secondary">
              <input type="checkbox" checked={Boolean(memory.notUsefulAt)} onChange={(e) => toggle("markNotUseful", e.target.checked)} />
              Mark as not useful
            </label>

            {rules && rules.length > 0 && (
              <ul className="space-y-1.5">
                {rules.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="text-primary">
                      {ruleDetail(r)}
                      {!r.active && <span className="ml-1.5 text-xs text-tertiary">(done)</span>}
                      {r.active && r.lastFiredAt && <span className="ml-1.5 text-xs text-tertiary">(last reminded {new Date(r.lastFiredAt).toLocaleDateString()})</span>}
                    </span>
                    <button onClick={() => removeRule(r.id)} className="shrink-0 text-xs text-critical hover:underline">
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="space-y-2 border-t border-border-subtle pt-3">
              <p className="mb-1.5 text-sm font-medium text-secondary">Add a reminder</p>
              {/* SAVE-004's 4 real trigger types — each maps 1:1 to a variant of
                  CreateResurfacingRuleDtoSchema's discriminated union. */}
              <div className="flex flex-wrap gap-1.5">
                {RESURFACING_RULE_TYPES.map((t) => (
                  <button
                    key={t.value}
                    onClick={() => setRuleType(t.value)}
                    className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                      ruleType === t.value ? "bg-brand text-on-brand" : "bg-subtle text-secondary hover:bg-border-subtle"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {ruleType === "date" && (
                <div className="flex flex-wrap items-end gap-2">
                  <div>
                    <Label htmlFor="rule-date">Date</Label>
                    <Input id="rule-date" type="date" value={ruleDate} onChange={(e) => setRuleDate(e.target.value)} className="w-44" />
                  </div>
                </div>
              )}

              {ruleType === "person_birthday" && (
                <div className="flex flex-wrap items-end gap-2">
                  <div>
                    <Label htmlFor="rule-dependent">Person</Label>
                    {dependents && dependents.length > 0 ? (
                      <select
                        id="rule-dependent"
                        value={ruleDependentId}
                        onChange={(e) => setRuleDependentId(e.target.value)}
                        className="h-10 min-w-[180px] rounded-lg border border-border-default bg-surface px-2 text-sm text-primary"
                      >
                        <option value="">Choose…</option>
                        {dependents.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.displayName}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <p className="text-sm text-tertiary">
                        No household members yet.{" "}
                        <Link href="/settings/household" className="text-brand hover:underline">
                          Add one
                        </Link>{" "}
                        first.
                      </p>
                    )}
                  </div>
                  {dependents && dependents.length > 0 && (
                    <div>
                      <Label htmlFor="rule-days-before">Days before</Label>
                      <Input
                        id="rule-days-before"
                        type="number"
                        min={0}
                        max={90}
                        value={ruleDaysBefore}
                        onChange={(e) => setRuleDaysBefore(e.target.value)}
                        className="w-24"
                      />
                    </div>
                  )}
                </div>
              )}

              {ruleType === "trip_location" && (
                <div className="space-y-1.5">
                  {upcomingTrips.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {upcomingTrips.map((t) => (
                        <button
                          key={t.id}
                          onClick={() => setRuleLocationLabel(t.destinationLabel ?? "")}
                          className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                            ruleLocationLabel === t.destinationLabel ? "bg-brand text-on-brand" : "bg-subtle text-secondary hover:bg-border-subtle"
                          }`}
                        >
                          {t.destinationLabel}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="flex flex-wrap items-end gap-2">
                    <div>
                      <Label htmlFor="rule-location">Destination</Label>
                      {/* Free-text is intentional here (not a missing picker) — ResurfacingService.
                          evaluateTripLocationRule matches this label against upcoming/active trips at scan
                          time whether or not a matching trip exists yet ("saved Denver restaurants surface
                          while planning a Denver trip" works even before the trip is booked), so this isn't
                          geocoding, just a label — quick-picks above cover the "match an existing trip
                          exactly" case. */}
                      <Input
                        id="rule-location"
                        value={ruleLocationLabel}
                        onChange={(e) => setRuleLocationLabel(e.target.value)}
                        placeholder="e.g. Denver"
                        maxLength={200}
                        className="w-52"
                      />
                    </div>
                  </div>
                </div>
              )}

              {ruleType === "location_proximity" && (
                <div className="flex flex-wrap items-end gap-2">
                  <div>
                    <Label htmlFor="rule-place">Saved place</Label>
                    {places && places.length > 0 ? (
                      <select
                        id="rule-place"
                        value={rulePlaceId}
                        onChange={(e) => setRulePlaceId(e.target.value)}
                        className="h-10 min-w-[180px] rounded-lg border border-border-default bg-surface px-2 text-sm text-primary"
                      >
                        <option value="">Choose…</option>
                        {places.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <p className="text-sm text-tertiary">
                        No saved places yet.{" "}
                        <Link href="/places" className="text-brand hover:underline">
                          Save one
                        </Link>{" "}
                        first.
                      </p>
                    )}
                  </div>
                </div>
              )}

              <Button size="sm" variant="secondary" loading={addingRule} onClick={createRule} disabled={!canCreateRule()}>
                Add reminder
              </Button>
            </div>

            {/* SAVE-007 "auto-archive after a condition" — the backend field/scan already worked; this is
                the missing UI control to actually set it. */}
            <div className="border-t border-border-subtle pt-3">
              <p className="mb-1.5 text-sm font-medium text-secondary">Archive automatically after…</p>
              {memory.autoArchiveAt ? (
                <div className="flex flex-wrap items-center gap-2 text-sm text-secondary">
                  <span>
                    Scheduled for {new Date(memory.autoArchiveAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
                  </span>
                  <button onClick={clearAutoArchive} className="text-xs text-critical hover:underline">
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="flex flex-wrap items-end gap-2">
                  {AUTO_ARCHIVE_QUICK_PICKS.map((pick) => (
                    <Button key={pick.days} size="sm" variant="ghost" onClick={() => setAutoArchiveInDays(pick.days)}>
                      {pick.label}
                    </Button>
                  ))}
                  <div>
                    <Label htmlFor="auto-archive-date">Or a specific date</Label>
                    <Input id="auto-archive-date" type="date" value={autoArchiveDate} onChange={(e) => setAutoArchiveDate(e.target.value)} className="w-44" />
                  </div>
                  <Button size="sm" variant="secondary" onClick={setAutoArchiveOnDate} disabled={!autoArchiveDate}>
                    Set
                  </Button>
                </div>
              )}
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
