"use client";

import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { swrFetcher, api } from "@/lib/api-client";
import { useBackfillStatus } from "@/lib/use-backfill-status";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { formatMoneyMinorUnits, formatTemporal, type TemporalValueLike } from "@/lib/format";

interface AttentionItem {
  id: string;
  reasonText: string;
  urgency: "critical" | "important" | "useful" | "informational";
  dueAt: TemporalValueLike | null;
  moneyAtStakeMinorUnits: number | null;
  moneyAtStakeCurrency: string | null;
  primaryActions: string[];
  assignedToUserId: string | null;
  linkedResourceType: string | null;
  linkedResourceId: string | null;
}

/** HOME-001 "open" action — attention items were entirely un-clickable before this; a card told you
 * something needed attention with no way to actually get to it. Maps the linked resource onto its real
 * detail route (all of which already existed, just never linked from here). */
function resourceHref(type: string | null, id: string | null): string | null {
  if (!type || !id) return null;
  switch (type) {
    case "bill":
      return `/life/bills/${id}`;
    case "return_case":
      return `/life/returns/${id}`;
    case "warranty":
      return `/life/warranties/${id}`;
    case "person":
      return `/people/${id}`;
    default:
      return null;
  }
}

interface HomeResponse {
  items: AttentionItem[];
  caughtUp: boolean;
  degraded: boolean;
  unhealthyConnections: Array<{ id: string; provider: string; health: string }>;
}

interface TodayItem {
  kind: "event" | "task" | "bill";
  id: string;
  title: string;
  at: string;
}

interface TodayResponse {
  items: TodayItem[];
}

interface HouseholdMembership {
  household: { id: string; name: string };
  membership: { userId: string | null };
}

interface Member {
  userId: string | null;
  status: string;
  displayName: string | null;
}

const URGENCY_TONE: Record<AttentionItem["urgency"], "critical" | "warning" | "info" | "neutral"> = {
  critical: "critical",
  important: "warning",
  useful: "info",
  informational: "neutral",
};

const SNOOZE_OPTIONS = [
  { label: "1 hour", ms: 60 * 60 * 1000 },
  { label: "Tomorrow", ms: 24 * 60 * 60 * 1000 },
  { label: "1 week", ms: 7 * 24 * 60 * 60 * 1000 },
];

const TODAY_KIND_LABEL: Record<TodayItem["kind"], string> = { event: "Event", task: "Task", bill: "Bill" };

export default function HomePage() {
  const backfilling = useBackfillStatus();
  const { data, isLoading, mutate } = useSWR<HomeResponse>("/v1/home", swrFetcher, {
    refreshInterval: backfilling ? 4000 : 0,
  });
  const { data: today } = useSWR<TodayResponse>("/v1/home/today", swrFetcher, { refreshInterval: backfilling ? 4000 : 0 });
  const { data: households } = useSWR<HouseholdMembership[]>("/v1/households", swrFetcher);
  const householdId = households?.[0]?.household.id ?? null;
  const { data: members } = useSWR<Member[]>(householdId ? `/v1/households/${householdId}/members` : null, swrFetcher);

  async function handleResolve(id: string) {
    await api.post(`/v1/attention/${id}/resolve`);
    mutate();
  }

  async function handleDismiss(id: string) {
    await api.post(`/v1/attention/${id}/dismiss`, { reason: "not_relevant" });
    mutate();
  }

  async function handleSnooze(id: string, ms: number) {
    await api.post(`/v1/attention/${id}/snooze`, { until: new Date(Date.now() + ms).toISOString() });
    mutate();
  }

  async function handleDelegate(id: string, assigneeUserId: string) {
    await api.post(`/v1/attention/${id}/delegate`, { assigneeUserId });
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

      {today && today.items.length > 0 && (
        <section aria-labelledby="today-heading">
          <h2 id="today-heading" className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">
            Today
          </h2>
          <Card>
            <CardBody className="divide-y divide-border-subtle p-0">
              {today.items.map((item) => {
                const href = item.kind === "event" ? `/life/events/${item.id}` : item.kind === "bill" ? `/life/bills/${item.id}` : "/life";
                return (
                  <Link key={`${item.kind}-${item.id}`} href={href} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-subtle">
                    <div>
                      <p className="text-[0.9375rem] font-medium text-primary">{item.title}</p>
                      <p className="text-sm text-tertiary">
                        {TODAY_KIND_LABEL[item.kind]} · {new Date(item.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                      </p>
                    </div>
                  </Link>
                );
              })}
            </CardBody>
          </Card>
        </section>
      )}

      <section aria-labelledby="needs-you-heading">
        <h2 id="needs-you-heading" className="mb-3 text-sm font-semibold uppercase tracking-wide text-tertiary">
          Needs You
        </h2>

        {!isLoading && backfilling && data && data.items.length > 0 && (
          <p className="mb-3 text-sm text-tertiary">Still reading through what you connected — more may appear shortly.</p>
        )}

        {isLoading && (
          <div className="space-y-3">
            {[0, 1].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-xl bg-subtle" />
            ))}
          </div>
        )}

        {!isLoading && data?.caughtUp && backfilling && (
          <EmptyState
            title="Still going through what you connected."
            description="Veynlo is reading through your history now — anything worth your attention will show up here automatically as it's found, no need to refresh."
          />
        )}

        {!isLoading && data?.caughtUp && !backfilling && (
          <EmptyState
            title={data.degraded ? "Nothing else needs attention from the sources currently available." : "You're caught up."}
            description={
              data.degraded
                ? "Some connections aren't syncing right now, so this isn't the full picture — reconnect them above to be sure."
                : "Nothing needs your attention right now. Connect another account or add something manually to find more."
            }
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
            {data.items.map((item) => (
              <AttentionItemCard
                key={item.id}
                item={item}
                members={members?.filter((m) => m.userId && m.status === "active") ?? []}
                onResolve={() => handleResolve(item.id)}
                onDismiss={() => handleDismiss(item.id)}
                onSnooze={(ms) => handleSnooze(item.id, ms)}
                onDelegate={(assigneeUserId) => handleDelegate(item.id, assigneeUserId)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function AttentionItemCard({
  item,
  members,
  onResolve,
  onDismiss,
  onSnooze,
  onDelegate,
}: {
  item: AttentionItem;
  members: Member[];
  onResolve: () => void;
  onDismiss: () => void;
  onSnooze: (ms: number) => void;
  onDelegate: (assigneeUserId: string) => void;
}) {
  const [expanded, setExpanded] = useState<"snooze" | "delegate" | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const due = formatTemporal(item.dueAt);
  const money = formatMoneyMinorUnits(item.moneyAtStakeMinorUnits, item.moneyAtStakeCurrency);

  async function handleShare() {
    const { url } = await api.post<{ url: string }>(`/v1/attention/${item.id}/share`);
    setShareUrl(url);
  }

  async function copyShareUrl() {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <li>
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

          <div className="flex flex-wrap items-center gap-2">
            {resourceHref(item.linkedResourceType, item.linkedResourceId) && (
              <Link href={resourceHref(item.linkedResourceType, item.linkedResourceId)!}>
                <Button size="sm" variant="secondary">
                  Open
                </Button>
              </Link>
            )}
            <Button size="sm" onClick={onResolve}>
              Mark handled
            </Button>
            <DropdownMenu
              items={[
                { label: "Dismiss", onSelect: onDismiss },
                { label: "Snooze", onSelect: () => setExpanded(expanded === "snooze" ? null : "snooze") },
                ...(members.length > 0 ? [{ label: "Delegate", onSelect: () => setExpanded(expanded === "delegate" ? null : "delegate") }] : []),
                { label: "Share", onSelect: handleShare },
              ]}
            />
          </div>

          {expanded === "snooze" && (
            <div className="flex flex-wrap gap-2 rounded-lg bg-subtle p-2">
              {SNOOZE_OPTIONS.map((opt) => (
                <Button key={opt.label} size="sm" variant="secondary" onClick={() => onSnooze(opt.ms)}>
                  {opt.label}
                </Button>
              ))}
            </div>
          )}

          {expanded === "delegate" && (
            <div className="flex flex-wrap gap-2 rounded-lg bg-subtle p-2">
              {members.map((m) => (
                <Button key={m.userId} size="sm" variant="secondary" onClick={() => m.userId && onDelegate(m.userId)}>
                  {m.displayName ?? "Household member"}
                </Button>
              ))}
            </div>
          )}

          {shareUrl && (
            <div className="flex items-center gap-2 rounded-lg bg-subtle p-2">
              <code className="flex-1 truncate text-sm text-primary">{shareUrl}</code>
              <Button size="sm" variant="secondary" onClick={copyShareUrl}>
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          )}
        </CardBody>
      </Card>
    </li>
  );
}
