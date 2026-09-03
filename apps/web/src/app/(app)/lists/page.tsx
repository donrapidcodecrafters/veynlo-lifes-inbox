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

const LIST_KINDS = [
  { value: "custom", label: "Custom" },
  { value: "grocery", label: "Grocery" },
  { value: "packing", label: "Packing" },
  { value: "household_maintenance", label: "Household maintenance" },
  { value: "gift", label: "Gift" },
  { value: "school_supplies", label: "School supplies" },
  { value: "trip_prep", label: "Trip prep" },
] as const;

interface ListRow {
  id: string;
  name: string;
  kind: string;
  householdId: string | null;
  smartListQuery: Record<string, unknown> | null;
  itemCounts: { total: number; checked: number };
}

// §29.1 SAVE-003 "Smart lists... 'all recipes,' 'gift ideas for Dad,' 'places in Denver,' or 'products
// under $500'" — a minimal quick-create for the single most common case (all saved items of one category);
// the full criteria language (person/location/price) is set via the API today, not this form.
const SMART_LIST_CATEGORIES = [
  { value: "recipe", label: "All recipes" },
  { value: "gift_idea", label: "Gift ideas" },
  { value: "place", label: "Places" },
  { value: "product", label: "Products" },
  { value: "trip_idea", label: "Trip ideas" },
  { value: "article", label: "Articles" },
] as const;

interface MyHousehold {
  household: { id: string; name: string };
}

function kindLabel(kind: string): string {
  return LIST_KINDS.find((k) => k.value === kind)?.label ?? kind;
}

/**
 * FAM-005 "Shared lists" — spec: "Groceries, packing, household maintenance, gifts, school supplies,
 * trip prep and custom lists." A list with no household is private to its owner; picking a household
 * shares it with every active member of that household (FAM-006 delegation-scoped visibility, same
 * pattern as calendar events/tasks/documents).
 */
export default function ListsPage() {
  const { data: lists, error: listsError, isLoading, mutate } = useSWR<ListRow[]>("/v1/lists", swrFetcher);
  const { data: households } = useSWR<MyHousehold[]>("/v1/households", swrFetcher);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<(typeof LIST_KINDS)[number]["value"]>("custom");
  const [householdId, setHouseholdId] = useState<string>("");
  const [isSmart, setIsSmart] = useState(false);
  const [smartCategory, setSmartCategory] = useState<(typeof SMART_LIST_CATEGORIES)[number]["value"]>("recipe");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  async function createList(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    setFieldErrors({});
    try {
      await api.post("/v1/lists", {
        name,
        kind,
        householdId: householdId || null,
        smartListQuery: isSmart ? { category: smartCategory } : undefined,
      });
      setName("");
      setKind("custom");
      setHouseholdId("");
      setIsSmart(false);
      mutate();
    } catch (err) {
      // The name input had no maxLength, so a name over the server's 120-char cap hit this catch with
      // no `fieldErrors` handling at all — the user saw only the generic "Request body failed
      // validation." (confirmed live) with no clue which field was wrong or why. `maxLength` below stops
      // most of this at the source; surfacing `fieldErrors` (same pattern as the sign-up form) covers
      // whatever server-side validation still fires past that.
      if (err instanceof ApiError && err.fieldErrors) setFieldErrors(err.fieldErrors);
      setError(err instanceof ApiError ? (err.fieldErrors?.name?.[0] ?? err.message) : "Couldn't create that list.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">Lists</h1>
        <p className="mt-1 text-sm text-tertiary">Groceries, packing, gifts, and anything else you want to track together — or privately.</p>
      </header>

      <Card>
        <CardBody>
          <form onSubmit={createList} className="space-y-3">
            <div>
              <Label htmlFor="list-name">New list</Label>
              <Input
                id="list-name"
                placeholder="e.g. Weekly groceries"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                error={fieldErrors.name?.[0]}
                required
              />
            </div>
            <div className="flex flex-wrap gap-3">
              <div>
                <Label htmlFor="list-kind">Type</Label>
                <select
                  id="list-kind"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as typeof kind)}
                  className="h-10 rounded-lg border border-border-default bg-surface px-3 text-sm text-primary"
                >
                  {LIST_KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </div>
              {households && households.length > 0 && (
                <div>
                  <Label htmlFor="list-household">Share with</Label>
                  <select
                    id="list-household"
                    value={householdId}
                    onChange={(e) => setHouseholdId(e.target.value)}
                    className="h-10 rounded-lg border border-border-default bg-surface px-3 text-sm text-primary"
                  >
                    <option value="">Just me (private)</option>
                    {households.map((h) => (
                      <option key={h.household.id} value={h.household.id}>
                        {h.household.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-secondary">
                <input type="checkbox" checked={isSmart} onChange={(e) => setIsSmart(e.target.checked)} />
                Smart list (auto-matches your saved items)
              </label>
              {isSmart && (
                <select
                  value={smartCategory}
                  onChange={(e) => setSmartCategory(e.target.value as typeof smartCategory)}
                  className="h-9 rounded-lg border border-border-default bg-surface px-3 text-sm text-primary"
                >
                  {SMART_LIST_CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <FieldError>{error ?? undefined}</FieldError>
            <Button type="submit" loading={creating} disabled={!name.trim()}>
              Create list
            </Button>
          </form>
        </CardBody>
      </Card>

      {isLoading && <p className="text-sm text-tertiary">Loading…</p>}

      {!isLoading && listsError && !lists && (
        <FetchError what="your lists" message={listsError instanceof ApiError ? listsError.message : undefined} onRetry={() => mutate()} />
      )}

      {!isLoading && !listsError && (lists ?? []).length === 0 && (
        <EmptyState
          title="No lists yet"
          description="Create a grocery list, a packing list, or anything else you want to track — private to you, or shared with your household."
        />
      )}

      {(lists ?? []).length > 0 && (
        <div className="space-y-3">
          {lists!.map((list) => (
            <Link key={list.id} href={`/lists/${list.id}`}>
              <Card className="transition-colors hover:bg-subtle">
                <CardBody className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate text-[0.9375rem] font-medium text-primary">{list.name}</p>
                    <div className="mt-1 flex items-center gap-2">
                      {list.smartListQuery ? <Badge tone="brand">Smart</Badge> : <Badge tone="neutral">{kindLabel(list.kind)}</Badge>}
                      {list.householdId && <Badge tone="neutral">Shared</Badge>}
                    </div>
                  </div>
                  {/* A smart list has no saved_items rows at all — its real count only exists on the
                      detail page (a live query against saved memories), so this overview intentionally
                      doesn't show a stale/misleading 0/0 here. */}
                  {!list.smartListQuery && (
                    <p className="shrink-0 text-sm text-tertiary">
                      {list.itemCounts.checked}/{list.itemCounts.total} done
                    </p>
                  )}
                </CardBody>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
