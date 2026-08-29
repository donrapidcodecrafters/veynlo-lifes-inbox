"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

interface TimelineItem {
  id: string;
  kind: "calendar_event" | "purchase" | "bill" | "document" | "return_case" | "warranty";
  title: string;
  occurredAt: string;
  resourceType: string;
  resourceId: string;
}

interface TimelineResponse {
  items: TimelineItem[];
  nextCursor: string | null;
}

const KIND_LABEL: Record<TimelineItem["kind"], string> = {
  calendar_event: "Event",
  purchase: "Purchase",
  bill: "Bill",
  document: "Document",
  return_case: "Return",
  warranty: "Warranty",
};

const KIND_TONE: Record<TimelineItem["kind"], "info" | "positive" | "warning" | "neutral" | "critical"> = {
  calendar_event: "info",
  purchase: "positive",
  bill: "warning",
  document: "neutral",
  return_case: "critical",
  warranty: "neutral",
};

const KIND_HREF: Record<TimelineItem["kind"], (resourceId: string) => string> = {
  calendar_event: (id) => `/life/events/${id}`,
  purchase: (id) => `/life/purchases/${id}`,
  bill: (id) => `/life/bills/${id}`,
  return_case: (id) => `/life/returns/${id}`,
  warranty: (id) => `/life/warranties/${id}`,
  document: () => `/documents`, // no per-document detail page exists yet — the list is the closest real destination
};

function groupByDay(items: TimelineItem[]): Array<[string, TimelineItem[]]> {
  const groups = new Map<string, TimelineItem[]>();
  for (const item of items) {
    const day = new Date(item.occurredAt).toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    const existing = groups.get(day);
    if (existing) existing.push(item);
    else groups.set(day, [item]);
  }
  return Array.from(groups.entries());
}

export default function TimelinePage() {
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    api
      .get<TimelineResponse>("/v1/timeline")
      .then((res) => {
        setItems(res.items);
        setCursor(res.nextCursor);
      })
      .finally(() => setIsLoading(false));
  }, []);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const res = await api.get<TimelineResponse>(`/v1/timeline?before=${encodeURIComponent(cursor)}`);
      setItems((prev) => [...prev, ...res.items]);
      setCursor(res.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">Timeline</h1>
        <p className="mt-1 text-sm text-tertiary">Everything Veynlo knows, in order.</p>
      </header>

      {isLoading && (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-subtle" />
          ))}
        </div>
      )}

      {!isLoading && items.length === 0 && (
        <EmptyState
          title="Nothing here yet"
          description="As Veynlo learns about your purchases, bills, appointments, and documents, they'll show up here in order."
        />
      )}

      {items.length > 0 && (
        <div className="space-y-6">
          {groupByDay(items).map(([day, dayItems]) => (
            <div key={day}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-tertiary">{day}</h2>
              <div className="space-y-2">
                {dayItems.map((item) => (
                  <Link key={`${item.kind}-${item.id}`} href={KIND_HREF[item.kind](item.resourceId)}>
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
