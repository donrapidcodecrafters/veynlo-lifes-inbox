"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/ui/empty-state";
import { EvidenceCard, type Evidence } from "@/components/evidence-card";
import { HistorySection } from "@/components/history-section";
import { formatTemporal, type TemporalValueLike } from "@/lib/format";

interface EventDetail {
  event: {
    id: string;
    title: string;
    start: TemporalValueLike;
    end: TemporalValueLike | null;
    isAllDay: boolean;
    location: string | null;
    status: string;
    source: string;
    providerEventId: string | null;
    householdId: string | null;
    visibility: string;
  };
  evidence: Evidence | null;
}

export default function EventDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, mutate } = useSWR<EventDetail | null>(`/v1/events/${id}`, swrFetcher);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [copied, setCopied] = useState(false);

  if (isLoading) return <div className="h-40 animate-pulse rounded-xl bg-subtle" />;
  if (!data) return <EmptyState title="Not found" description="This event doesn't exist or you don't have access to it." />;

  const { event, evidence } = data;
  const start = formatTemporal(event.start);
  const end = formatTemporal(event.end);

  async function share() {
    setSharing(true);
    try {
      const result = await api.post<{ url: string }>(`/v1/events/${id}/share`);
      setShareUrl(result.url);
      setCopied(false);
    } finally {
      setSharing(false);
    }
  }

  async function copyShareUrl() {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
  }

  async function revokeShare() {
    await api.post(`/v1/events/${id}/share/revoke`);
    setShareUrl(null);
  }

  async function toggleVisibility(visible: boolean) {
    await api.post(`/v1/events/${id}/visibility`, { visibility: visible ? "household" : "private" });
    mutate();
  }

  async function syncToCalendar() {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const result = await api.post<{ provider: string; providerEventId: string }>(`/v1/events/${id}/push-to-calendar`);
      setSyncMessage(`Synced to ${result.provider === "google_calendar" ? "Google Calendar" : "Outlook Calendar"}.`);
      mutate();
    } catch (err) {
      setSyncMessage(err instanceof ApiError ? err.message : "Couldn't sync this event. Please try again.");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="space-y-6">
      <Link href="/life" className="text-sm text-tertiary hover:text-primary">
        ← Back to Life
      </Link>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">{event.title}</h1>
        {start && (
          <p className="mt-1 text-sm text-tertiary">
            {start}
            {end && !event.isAllDay ? ` – ${end}` : ""}
            {event.isAllDay ? " · All day" : ""}
          </p>
        )}
      </header>

      <Card>
        <CardBody className="space-y-2">
          <p className="text-sm font-medium text-primary">Details</p>
          <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-tertiary">Status</dt>
            <dd className="capitalize text-primary">
              <Badge tone={event.status === "confirmed" ? "positive" : "neutral"}>{event.status.replace(/_/g, " ")}</Badge>
            </dd>
            {event.location && (
              <>
                <dt className="text-tertiary">Location</dt>
                <dd className="text-primary">{event.location}</dd>
              </>
            )}
          </dl>
          <div className="flex flex-wrap items-center gap-3 border-t border-border-subtle pt-3">
            <Button size="sm" variant="secondary" onClick={syncToCalendar} loading={syncing}>
              {event.providerEventId ? "Sync changes to calendar" : "Sync to Google/Outlook Calendar"}
            </Button>
            {!shareUrl && (
              <Button size="sm" variant="ghost" onClick={share} loading={sharing}>
                Share
              </Button>
            )}
            {syncMessage && <p className="text-sm text-tertiary">{syncMessage}</p>}
          </div>
          {event.householdId && (
            <div className="border-t border-border-subtle pt-3">
              <Switch
                id="event-household-visible"
                checked={event.visibility === "household"}
                onCheckedChange={toggleVisibility}
                label="Visible to household"
                description="Let household members with schedule access see this event."
              />
            </div>
          )}
          {shareUrl && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-subtle p-2">
              <code className="min-w-0 flex-1 truncate text-sm text-primary">{shareUrl}</code>
              <Button size="sm" variant="secondary" onClick={copyShareUrl}>
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button size="sm" variant="ghost" onClick={revokeShare}>
                Revoke
              </Button>
            </div>
          )}
        </CardBody>
      </Card>

      <HistorySection resourceType="calendar_event" resourceId={event.id} />

      <EvidenceCard evidence={evidence} />
    </div>
  );
}
