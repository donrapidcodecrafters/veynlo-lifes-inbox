"use client";

import { useState } from "react";
import useSWR from "swr";
import { swrFetcher, api } from "@/lib/api-client";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";

interface InboxItem {
  id: string;
  category: string;
  summary: string;
  confidenceBand: string;
  reviewState: string;
  suggestedActions: string[];
}

const CONFIDENCE_TONE: Record<string, "positive" | "warning" | "critical" | "neutral"> = {
  verified: "positive",
  high: "positive",
  needs_review: "warning",
  conflicting: "critical",
  approximate: "neutral",
};

export default function InboxPage() {
  const [filter, setFilter] = useState<"new" | "all">("new");
  const { data, isLoading, mutate } = useSWR<InboxItem[]>(
    filter === "new" ? "/v1/inbox?reviewState=new" : "/v1/inbox",
    swrFetcher,
  );

  async function act(id: string, action: "confirm" | "archive" | "dismiss") {
    await api.post(`/v1/inbox/${id}/${action}`);
    mutate();
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-primary">Inbox</h1>
          <p className="mt-1 text-sm text-tertiary">Newly discovered information to review.</p>
        </div>
        <div className="flex gap-1 rounded-lg bg-subtle p-1">
          {(["new", "all"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
                filter === f ? "bg-surface text-primary shadow-xs" : "text-tertiary"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </header>

      {isLoading && (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl bg-subtle" />
          ))}
        </div>
      )}

      {!isLoading && data?.length === 0 && (
        <EmptyState
          title="You're caught up."
          description="New receipts, bills, appointments, and other discoveries will show up here for a quick review before they're filed."
        />
      )}

      {!isLoading && data && data.length > 0 && (
        <ul className="space-y-3">
          {data.map((item) => (
            <li key={item.id}>
              <Card>
                <CardBody className="space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-2">
                        <Badge tone="neutral">{item.category}</Badge>
                        <Badge tone={CONFIDENCE_TONE[item.confidenceBand] ?? "neutral"}>
                          {item.confidenceBand.replace("_", " ")}
                        </Badge>
                      </div>
                      <p className="text-[0.9375rem] font-medium text-primary">{item.summary}</p>
                    </div>
                  </div>
                  {item.reviewState === "new" && (
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => act(item.id, "confirm")}>
                        Confirm
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => act(item.id, "archive")}>
                        Archive
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => act(item.id, "dismiss")}>
                        Dismiss
                      </Button>
                    </div>
                  )}
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
