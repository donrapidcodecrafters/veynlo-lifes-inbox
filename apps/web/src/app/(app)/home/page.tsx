"use client";

import useSWR from "swr";
import Link from "next/link";
import { swrFetcher, api } from "@/lib/api-client";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { formatMoneyMinorUnits, formatTemporal, type TemporalValueLike } from "@/lib/format";

interface AttentionItem {
  id: string;
  reasonText: string;
  urgency: "critical" | "important" | "useful" | "informational";
  dueAt: TemporalValueLike | null;
  moneyAtStakeMinorUnits: number | null;
  moneyAtStakeCurrency: string | null;
  primaryActions: string[];
}

interface HomeResponse {
  items: AttentionItem[];
  caughtUp: boolean;
  degraded: boolean;
  unhealthyConnections: Array<{ id: string; provider: string; health: string }>;
}

const URGENCY_TONE: Record<AttentionItem["urgency"], "critical" | "warning" | "info" | "neutral"> = {
  critical: "critical",
  important: "warning",
  useful: "info",
  informational: "neutral",
};

export default function HomePage() {
  const { data, isLoading, mutate } = useSWR<HomeResponse>("/v1/home", swrFetcher);

  async function handleResolve(id: string) {
    await api.post(`/v1/attention/${id}/resolve`);
    mutate();
  }

  async function handleDismiss(id: string) {
    await api.post(`/v1/attention/${id}/dismiss`, { reason: "not_relevant" });
    mutate();
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">Home</h1>
        <p className="mt-1 text-sm text-tertiary">What matters right now.</p>
      </header>

      {data?.degraded && data.unhealthyConnections.length > 0 && (
        <Card className="border-warning/40 bg-warning-subtle">
          <CardBody className="flex items-center justify-between gap-3">
            <p className="text-sm text-warning-subtle-text">
              {data.unhealthyConnections.length} connection{data.unhealthyConnections.length > 1 ? "s" : ""} need
              attention — some information may be out of date.
            </p>
            <Link href="/connections">
              <Button variant="secondary" size="sm">
                Review
              </Button>
            </Link>
          </CardBody>
        </Card>
      )}

      <section aria-labelledby="needs-you-heading">
        <h2 id="needs-you-heading" className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">
          Needs You
        </h2>

        {isLoading && (
          <div className="space-y-3">
            {[0, 1].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-xl bg-subtle" />
            ))}
          </div>
        )}

        {!isLoading && data?.caughtUp && (
          <EmptyState
            title="You're caught up."
            description="Nothing needs your attention right now. Connect another account or add something manually to find more."
            action={
              <Link href="/connections">
                <Button variant="secondary" size="sm">
                  Connect a source
                </Button>
              </Link>
            }
          />
        )}

        {!isLoading && data && data.items.length > 0 && (
          <ul className="space-y-3">
            {data.items.map((item) => {
              const due = formatTemporal(item.dueAt);
              const money = formatMoneyMinorUnits(item.moneyAtStakeMinorUnits, item.moneyAtStakeCurrency);
              return (
                <li key={item.id}>
                  <Card>
                    <CardBody className="space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-1.5">
                          <Badge tone={URGENCY_TONE[item.urgency]}>{item.urgency}</Badge>
                          <p className="text-[0.9375rem] font-medium text-primary">{item.reasonText}</p>
                          <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-tertiary">
                            {due && <span>Due {due}</span>}
                            {money && <span className="font-medium text-primary">{money} at stake</span>}
                          </div>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => handleResolve(item.id)}>
                          Mark handled
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => handleDismiss(item.id)}>
                          Dismiss
                        </Button>
                      </div>
                    </CardBody>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
