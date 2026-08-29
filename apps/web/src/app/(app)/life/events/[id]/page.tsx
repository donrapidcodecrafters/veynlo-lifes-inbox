"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { swrFetcher } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
  };
  evidence: Evidence | null;
}

export default function EventDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useSWR<EventDetail | null>(`/v1/events/${id}`, swrFetcher);

  if (isLoading) return <div className="h-40 animate-pulse rounded-xl bg-subtle" />;
  if (!data) return <EmptyState title="Not found" description="This event doesn't exist or you don't have access to it." />;

  const { event, evidence } = data;
  const start = formatTemporal(event.start);
  const end = formatTemporal(event.end);

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
        </CardBody>
      </Card>

      <HistorySection resourceType="calendar_event" resourceId={event.id} />

      <EvidenceCard evidence={evidence} />
    </div>
  );
}
