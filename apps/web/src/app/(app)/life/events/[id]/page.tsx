"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import useSWR from "swr";
import type { RecurrenceRule } from "@veynlo/core";
import { swrFetcher, api, ApiError } from "@/lib/api-client";
import { Card, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FetchError } from "@/components/ui/fetch-error";
import { FieldError, Label } from "@/components/ui/input";
import { RecurrencePicker } from "@/components/recurrence-picker";
import { EvidenceCard, type Evidence } from "@/components/evidence-card";
import { formatTemporal, type TemporalValueLike } from "@/lib/format";
import { REMINDER_OPTIONS, PROVIDER_LABEL } from "@/lib/calendar-destinations";

interface EventSummary {
  id: string;
  title: string;
  start: TemporalValueLike;
  end: TemporalValueLike | null;
  isAllDay: boolean;
  location: string | null;
  status: string;
  source: string;
  providerEventId: string | null;
  reminderMinutesBefore: number | null;
  writeBackConnectionId: string | null;
  writeBackStatus: string | null;
  recurrenceRule: RecurrenceRule | null;
}

interface EventDetail {
  event: EventSummary;
  evidence: Evidence | null;
  // CAL-001 "duplicate copies visually collapse while preserving original records" — the other record(s)
  // this event has been cross-source-linked with (see IngestionService.findCrossSourceCalendarEventMatch):
  // never a merge, both stay independently readable. Empty for an ordinary, unlinked event.
  linkedEvents: Array<{ event: EventSummary; evidence: Evidence | null }>;
}

interface Connection {
  id: string;
  provider: string;
  writeBackEnabled: boolean;
}

export default function EventDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, error, isLoading, mutate } = useSWR<EventDetail | null>(`/v1/events/${id}`, swrFetcher);
  const { data: connections } = useSWR<Connection[]>("/v1/connectors", swrFetcher);
  const writeBackTargets = (connections ?? []).filter((c) => (c.provider === "google_calendar" || c.provider === "microsoft_calendar") && c.writeBackEnabled);

  if (isLoading) return <div className="h-40 animate-pulse rounded-xl bg-subtle" />;
  if (error && !data) {
    return (
      <div className="space-y-6">
        <Link href="/life" className="text-sm text-tertiary hover:text-primary">
          ← Back to Life
        </Link>
        <FetchError what="this event" message={error instanceof ApiError ? error.message : undefined} onRetry={() => mutate()} />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="space-y-6">
        <Link href="/life" className="text-sm text-tertiary hover:text-primary">
          ← Back to Life
        </Link>
        <EmptyState title="Not found" description="This event doesn't exist or you don't have access to it." />
      </div>
    );
  }

  const { event, evidence, linkedEvents } = data;
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

      <ReminderCard event={event} onSaved={() => mutate()} />
      <RecurrenceCard event={event} onSaved={() => mutate()} />
      {writeBackTargets.length > 0 && <WriteBackCard event={event} targets={writeBackTargets} onPushed={() => mutate()} />}

      {linkedEvents.length > 0 && <LinkedEventsCard linkedEvents={linkedEvents} />}

      <EvidenceCard evidence={evidence} />
    </div>
  );
}

/**
 * CAL-001 "duplicate copies visually collapse while preserving original records" — this event has been
 * identified (see IngestionService.findCrossSourceCalendarEventMatch) as very likely the same real-world
 * appointment as one or more other independent `calendar_events` rows. Neither row was ever merged or
 * deleted — this simply surfaces the other record(s) so the user can inspect either original directly, the
 * same "click through to the underlying record" affordance the Life page's collapsed list card offers.
 */
function LinkedEventsCard({ linkedEvents }: { linkedEvents: EventDetail["linkedEvents"] }) {
  return (
    <Card>
      <CardBody className="space-y-3">
        <div>
          <p className="text-sm font-medium text-primary">Other sources for this appointment</p>
          <p className="text-xs text-tertiary">
            This looks like the same real-world event as {linkedEvents.length === 1 ? "another record" : `${linkedEvents.length} other records`} below —
            both are kept, nothing was merged or deleted.
          </p>
        </div>
        <div className="space-y-3">
          {linkedEvents.map(({ event: linked, evidence: linkedEvidence }) => (
            <div key={linked.id} className="space-y-2 rounded-lg border border-border-subtle p-3">
              <div className="flex items-center justify-between gap-2">
                <Link href={`/life/events/${linked.id}`} className="min-w-0 text-sm font-medium text-primary hover:underline">
                  {linked.title}
                </Link>
                <Badge tone="neutral">{linked.providerEventId ? "Synced calendar" : "Discovered from email"}</Badge>
              </div>
              {formatTemporal(linked.start) && <p className="text-xs text-tertiary">{formatTemporal(linked.start)}</p>}
              {linked.location && <p className="text-xs text-tertiary">{linked.location}</p>}
              <EvidenceCard evidence={linkedEvidence} />
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  );
}

/** CAL-002 "let the user set/edit the reminder lead time... when creating a manual event" — this is the
 * edit half (creation's default is set server-side by ScheduleService.createEvent); works identically for
 * a manually created event and a discovered/confirmed one, since both are just `calendar_events` rows. */
function ReminderCard({ event, onSaved }: { event: EventDetail["event"]; onSaved: () => void }) {
  const [value, setValue] = useState(event.reminderMinutesBefore ?? (event.isAllDay ? 1440 : 60));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.put(`/v1/events/${event.id}/reminder`, { reminderMinutesBefore: value });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save that reminder. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardBody className="space-y-2">
        <Label htmlFor="reminder-select">Remind me</Label>
        <div className="flex flex-wrap items-center gap-2">
          <select
            id="reminder-select"
            value={value}
            onChange={(e) => setValue(Number(e.target.value))}
            className="h-9 rounded-lg border border-border-subtle bg-surface px-3 text-sm text-primary"
          >
            {REMINDER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <Button size="sm" variant="secondary" onClick={save} loading={saving}>
            {saved ? "Saved" : "Save"}
          </Button>
        </div>
        {error && <FieldError>{error}</FieldError>}
      </CardBody>
    </Card>
  );
}

/** TASK-003 — the "editing" half of setting a recurrence rule (AddEventForm on the Life page is the
 * "creating" half). Owner-only server-side (ScheduleService.setEventRecurrence); this page doesn't hide the
 * control from a non-owner household member, but the save call will simply fail with a clear error for them. */
function RecurrenceCard({ event, onSaved }: { event: EventDetail["event"]; onSaved: () => void }) {
  const [rule, setRule] = useState<RecurrenceRule | null>(event.recurrenceRule);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.put(`/v1/events/${event.id}/recurrence`, { recurrenceRule: rule });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save that recurrence rule. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardBody className="space-y-2">
        <p className="text-sm font-medium text-primary">Recurrence</p>
        <RecurrencePicker value={rule} onChange={setRule} />
        <Button size="sm" variant="secondary" onClick={save} loading={saving}>
          {saved ? "Saved" : "Save"}
        </Button>
        {error && <FieldError>{error}</FieldError>}
      </CardBody>
    </Card>
  );
}

/** CAL-001 "write-back capability" — manual push control for an event that isn't already synced from a
 * provider. Only rendered when the user has at least one write-back-enabled calendar connection. */
function WriteBackCard({
  event,
  targets,
  onPushed,
}: {
  event: EventDetail["event"];
  targets: Connection[];
  onPushed: () => void;
}) {
  const [connectionId, setConnectionId] = useState(event.writeBackConnectionId ?? targets[0]?.id ?? "");
  const [pushing, setPushing] = useState(false);
  const [result, setResult] = useState<"pushed" | "failed" | null>(null);

  async function push() {
    setPushing(true);
    setResult(null);
    try {
      const res = await api.post<{ pushed: boolean }>(`/v1/calendar-events/${event.id}/push`, { connectionId });
      setResult(res.pushed ? "pushed" : "failed");
      onPushed();
    } catch {
      setResult("failed");
    } finally {
      setPushing(false);
    }
  }

  return (
    <Card>
      <CardBody className="space-y-2">
        <p className="text-sm font-medium text-primary">Sync to a connected calendar</p>
        {event.writeBackStatus && (
          <p className="text-sm text-tertiary">
            {event.writeBackStatus === "pushed" ? "Last synced successfully." : "The last sync attempt didn't go through — this event is still saved in Veynlo."}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={connectionId}
            onChange={(e) => setConnectionId(e.target.value)}
            className="h-9 rounded-lg border border-border-subtle bg-surface px-3 text-sm text-primary"
          >
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {PROVIDER_LABEL[t.provider] ?? t.provider}
              </option>
            ))}
          </select>
          <Button size="sm" variant="secondary" onClick={push} loading={pushing} disabled={!connectionId}>
            Push
          </Button>
        </div>
        {result === "failed" && <FieldError>Couldn&apos;t sync to that calendar right now. Try again later.</FieldError>}
      </CardBody>
    </Card>
  );
}
