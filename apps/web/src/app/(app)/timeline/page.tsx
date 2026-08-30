"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, API_BASE_URL } from "@/lib/api-client";
import { useDomainCacheInvalidation } from "@/lib/cache-invalidation";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SegmentedControl } from "@/components/ui/segmented-control";

type TimelineKind = "calendar_event" | "purchase" | "bill" | "document" | "return_case" | "warranty" | "shipment";

interface TimelineItem {
  id: string;
  kind: TimelineKind;
  title: string;
  occurredAt: string;
  resourceType: string;
  resourceId: string;
  relatedItems: TimelineItem[];
}

interface TimelineResponse {
  items: TimelineItem[];
  nextCursor: string | null;
}

const KIND_LABEL: Record<TimelineKind, string> = {
  calendar_event: "Event",
  purchase: "Purchase",
  bill: "Bill",
  document: "Document",
  return_case: "Return",
  warranty: "Warranty",
  shipment: "Shipment",
};

const KIND_TONE: Record<TimelineKind, "info" | "positive" | "warning" | "neutral" | "critical"> = {
  calendar_event: "info",
  purchase: "positive",
  bill: "warning",
  document: "neutral",
  return_case: "critical",
  warranty: "neutral",
  shipment: "positive",
};

const KIND_HREF: Record<TimelineKind, (resourceId: string) => string> = {
  calendar_event: (id) => `/life/events/${id}`,
  purchase: (id) => `/life/purchases/${id}`,
  bill: (id) => `/life/bills/${id}`,
  return_case: (id) => `/life/returns/${id}`,
  warranty: (id) => `/life/warranties/${id}`,
  document: () => `/documents`, // no per-document detail page exists yet — the list is the closest real destination
  shipment: () => `/life/purchases`, // shipments only ever appear nested under their purchase (see relatedItems) — no standalone detail page
};

const FILTER_KINDS: Array<{ value: TimelineKind | ""; label: string }> = [
  { value: "", label: "All" },
  { value: "purchase", label: "Purchases" },
  { value: "bill", label: "Bills" },
  { value: "calendar_event", label: "Events" },
  { value: "return_case", label: "Returns" },
  { value: "warranty", label: "Warranties" },
  { value: "document", label: "Documents" },
];

type ZoomLevel = "day" | "week" | "month";

function groupKey(date: Date, zoom: ZoomLevel): string {
  if (zoom === "month") return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  if (zoom === "week") {
    const startOfWeek = new Date(date);
    startOfWeek.setDate(date.getDate() - date.getDay());
    return `Week of ${startOfWeek.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}`;
  }
  return date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

function groupByZoom(items: TimelineItem[], zoom: ZoomLevel): Array<[string, TimelineItem[]]> {
  const groups = new Map<string, TimelineItem[]>();
  for (const item of items) {
    const key = groupKey(new Date(item.occurredAt), zoom);
    const existing = groups.get(key);
    if (existing) existing.push(item);
    else groups.set(key, [item]);
  }
  return Array.from(groups.entries());
}

const EXPORT_PRESETS = [
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
  { label: "This year", days: 365 },
];

export default function TimelinePage() {
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [zoom, setZoom] = useState<ZoomLevel>("day");
  const [kindFilter, setKindFilter] = useState<TimelineKind | "">("");
  const [showExport, setShowExport] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [jumpDate, setJumpDate] = useState("");

  // TIME-001 "search box" — debounced so every keystroke doesn't fire a request.
  useEffect(() => {
    const handle = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const refresh = useCallback(() => {
    setIsLoading(true);
    const params = new URLSearchParams();
    if (kindFilter) params.set("kind", kindFilter);
    if (search) params.set("search", search);
    // TIME-001 "jump to date" — `before` is already a real cursor (occurredAt < before); jumping to a
    // date just means starting the cursor there instead of at "now". One day added so the chosen date
    // itself is included, not excluded by the strict "<".
    if (jumpDate) params.set("before", new Date(new Date(jumpDate).getTime() + 86_400_000).toISOString());
    const qs = params.toString();
    api
      .get<TimelineResponse>(`/v1/timeline${qs ? `?${qs}` : ""}`)
      .then((res) => {
        setItems(res.items);
        setCursor(res.nextCursor);
      })
      .finally(() => setIsLoading(false));
  }, [kindFilter, search, jumpDate]);

  useDomainCacheInvalidation(refresh);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ before: cursor });
      if (kindFilter) params.set("kind", kindFilter);
      if (search) params.set("search", search);
      const res = await api.get<TimelineResponse>(`/v1/timeline?${params.toString()}`);
      setItems((prev) => [...prev, ...res.items]);
      setCursor(res.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }

  function exportRange(days: number) {
    const to = new Date();
    const from = new Date(Date.now() - days * 86_400_000);
    const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
    window.location.href = `${API_BASE_URL}/v1/timeline/export?${params.toString()}`;
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">Timeline</h1>
          <p className="mt-1 text-sm text-tertiary">Everything Veynlo knows, in order.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setShowExport((v) => !v)}>
          {showExport ? "Cancel" : "Export"}
        </Button>
      </header>

      {showExport && (
        <Card>
          <CardBody className="flex flex-wrap items-center gap-2">
            <p className="text-sm text-tertiary">Download a CSV of:</p>
            {EXPORT_PRESETS.map((p) => (
              <Button key={p.label} size="sm" variant="secondary" onClick={() => exportRange(p.days)}>
                {p.label}
              </Button>
            ))}
          </CardBody>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search timeline…"
          aria-label="Search timeline"
          className="h-9 min-w-0 flex-1 rounded-lg border border-border-default bg-surface px-3 text-sm text-primary placeholder:text-tertiary"
        />
        <div className="flex items-center gap-1.5">
          <label htmlFor="jump-to-date" className="text-sm text-tertiary">
            Jump to
          </label>
          <input
            id="jump-to-date"
            type="date"
            value={jumpDate}
            onChange={(e) => setJumpDate(e.target.value)}
            className="h-9 rounded-lg border border-border-default bg-surface px-2 text-sm text-primary"
          />
          {jumpDate && (
            <button type="button" onClick={() => setJumpDate("")} className="text-sm text-tertiary hover:text-primary">
              Clear
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          aria-label="Zoom level"
          value={zoom}
          onChange={setZoom}
          options={[
            { value: "day", label: "Day" },
            { value: "week", label: "Week" },
            { value: "month", label: "Month" },
          ]}
        />
        <div className="flex flex-wrap gap-1 rounded-lg bg-subtle p-1">
          {FILTER_KINDS.map((f) => (
            <button
              key={f.value || "all"}
              onClick={() => setKindFilter(f.value)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                kindFilter === f.value ? "bg-surface text-primary shadow-xs" : "text-tertiary"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading && (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-subtle" />
          ))}
        </div>
      )}

      {!isLoading && items.length === 0 && (
        <EmptyState
          title={search || jumpDate ? "No matches" : "Nothing here yet"}
          description={
            search || jumpDate
              ? "Nothing matches this search or date. Try a different term, or clear the search and jump-to-date fields."
              : "As Veynlo learns about your purchases, bills, appointments, and documents, they'll show up here in order."
          }
        />
      )}

      {items.length > 0 && (
        <div className="space-y-6">
          {groupByZoom(items, zoom).map(([label, groupItems]) => (
            <div key={label}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-tertiary">{label}</h2>
              <div className="space-y-2">
                {groupItems.map((item) => (
                  <div key={`${item.kind}-${item.id}`}>
                    <Link href={KIND_HREF[item.kind](item.resourceId)}>
                      <Card className="transition-colors hover:bg-subtle">
                        <CardBody className="flex items-center justify-between gap-3 py-3">
                          <div className="flex items-center gap-3">
                            <Badge tone={KIND_TONE[item.kind]}>{KIND_LABEL[item.kind]}</Badge>
                            <p className="text-sm font-medium text-primary">{item.title}</p>
                          </div>
                          <p className="text-xs text-tertiary">
                            {new Date(item.occurredAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                          </p>
                        </CardBody>
                      </Card>
                    </Link>
                    {item.relatedItems.length > 0 && (
                      <div className="ml-6 mt-1 space-y-1 border-l border-border-subtle pl-3">
                        {item.relatedItems.map((related) => (
                          <div key={`${related.kind}-${related.id}`} className="flex items-center gap-2 py-1">
                            <Badge tone={KIND_TONE[related.kind]}>{KIND_LABEL[related.kind]}</Badge>
                            <p className="text-xs text-tertiary">{related.title}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}

          {cursor && (
            <div className="pt-2 text-center">
              <Button variant="secondary" size="sm" onClick={loadMore} loading={loadingMore}>
                Load earlier
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
