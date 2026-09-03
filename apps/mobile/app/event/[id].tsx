import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { RecurrenceRule } from "@veynlo/core";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";
import { EvidenceCard, type Evidence } from "@/components/evidence-card";
import { FetchError } from "@/components/fetch-error";
import { RecurrencePicker } from "@/components/recurrence-picker";
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

export default function EventDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { theme } = useAppTheme();
  const [data, setData] = useState<EventDetail | null | undefined>(undefined);
  const [writeBackTargets, setWriteBackTargets] = useState<Connection[]>([]);
  // A bare `.then` with no `.catch` on a mount-time fetch becomes an unhandled promise rejection on any
  // transient network failure, which React Native Web surfaces as a full-screen "Uncaught Error" dev
  // overlay blocking the entire app, not just this screen (confirmed live — see entity/[id].tsx's identical
  // fix and doc comment).
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  // Found live: no reusable load function existed here — a transient 500/network error left the user
  // permanently stuck on "Something went wrong" with no in-place recovery. Mirrors bill/[id].tsx's
  // identical fix: wired to FetchError's own Retry button instead. The write-back-targets fetch stays
  // best-effort/fire-and-forget (unrelated failure modes — no error state of its own, same as before).
  const load = useCallback(() => {
    setError(null);
    api
      .get<EventDetail | null>(`/v1/events/${id}`)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load this. Please try again."))
      .finally(() => setRetrying(false));
    // CAL-001 write-back targets — best-effort, same as the Inbox screen's identical fetch.
    api
      .get<Connection[]>("/v1/connectors")
      .then((connections) => setWriteBackTargets(connections.filter((c) => (c.provider === "google_calendar" || c.provider === "microsoft_calendar") && c.writeBackEnabled)))
      .catch(() => {});
  }, [id]);

  useEffect(load, [load]);

  if (error) {
    return (
      <Screen>
        <ScreenHeader title="Something went wrong" />
        <FetchError
          message={error}
          what="this event"
          retrying={retrying}
          onRetry={() => {
            setRetrying(true);
            load();
          }}
        />
      </Screen>
    );
  }
  if (data === undefined) return <Screen><View style={{ height: 120, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" /></Screen>;
  if (!data) return <Screen><ScreenHeader title="Not found" /><EmptyState title="Not found" description="This event doesn't exist or you don't have access to it." /></Screen>;

  const { event, evidence, linkedEvents } = data;
  const start = formatTemporal(event.start);
  const end = formatTemporal(event.end);
  const subtitle = start ? `${start}${end && !event.isAllDay ? ` – ${end}` : ""}${event.isAllDay ? " · All day" : ""}` : undefined;

  return (
    <Screen>
      <ScreenHeader title={event.title} subtitle={subtitle} />
      <Card style={{ gap: 8 }}>
        <Badge tone={event.status === "confirmed" ? "positive" : "neutral"}>{event.status.replace(/_/g, " ")}</Badge>
        {event.location && <Text style={{ fontSize: 14, color: theme.colors.textPrimary }}>{event.location}</Text>}
      </Card>
      <ReminderCard event={event} onSaved={(reminderMinutesBefore) => setData((d) => (d ? { ...d, event: { ...d.event, reminderMinutesBefore } } : d))} />
      <RecurrenceCard event={event} onSaved={(recurrenceRule) => setData((d) => (d ? { ...d, event: { ...d.event, recurrenceRule } } : d))} />
      {writeBackTargets.length > 0 && (
        <WriteBackCard
          event={event}
          targets={writeBackTargets}
          onPushed={() =>
            api
              .get<EventDetail | null>(`/v1/events/${id}`)
              .then(setData)
              .catch(() => {})
          }
        />
      )}
      {linkedEvents.length > 0 && <LinkedEventsCard linkedEvents={linkedEvents} onOpen={(linkedId) => router.push(`/event/${linkedId}`)} />}
      <EvidenceCard evidence={evidence} />
    </Screen>
  );
}

/**
 * CAL-001 "duplicate copies visually collapse while preserving original records" — this event has been
 * identified (see IngestionService.findCrossSourceCalendarEventMatch) as very likely the same real-world
 * appointment as one or more other independent `calendar_events` rows. Neither row was ever merged or
 * deleted — this simply surfaces the other record(s) so the user can open either original directly, the
 * same "tap through to the underlying record" affordance the Life tab's collapsed list card offers.
 */
function LinkedEventsCard({ linkedEvents, onOpen }: { linkedEvents: EventDetail["linkedEvents"]; onOpen: (id: string) => void }) {
  const { theme } = useAppTheme();
  return (
    <Card style={{ gap: 10 }}>
      <View style={{ gap: 2 }}>
        <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textPrimary }}>Other sources for this appointment</Text>
        <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
          This looks like the same real-world event as {linkedEvents.length === 1 ? "another record" : `${linkedEvents.length} other records`} below — both
          are kept, nothing was merged or deleted.
        </Text>
      </View>
      {linkedEvents.map(({ event: linked, evidence: linkedEvidence }) => (
        <Pressable accessibilityRole="button"
          key={linked.id}
          onPress={() => onOpen(linked.id)}
          style={{ borderWidth: 1, borderColor: theme.colors.borderSubtle, borderRadius: theme.radius.lg, padding: 10, gap: 6 }}
        >
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textPrimary, flexShrink: 1 }} numberOfLines={1}>
              {linked.title}
            </Text>
            <Badge tone="neutral">{linked.providerEventId ? "Synced calendar" : "Discovered from email"}</Badge>
          </View>
          {formatTemporal(linked.start) && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{formatTemporal(linked.start)}</Text>}
          {linked.location && <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>{linked.location}</Text>}
          <EvidenceCard evidence={linkedEvidence} />
        </Pressable>
      ))}
    </Card>
  );
}

/** CAL-002 — see apps/web's identical `ReminderCard` (life/events/[id]/page.tsx) for the full contract. */
function ReminderCard({ event, onSaved }: { event: EventDetail["event"]; onSaved: (reminderMinutesBefore: number) => void }) {
  const { theme } = useAppTheme();
  const [value, setValue] = useState(event.reminderMinutesBefore ?? (event.isAllDay ? 1440 : 60));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(next: number) {
    setValue(next);
    setSaving(true);
    setError(null);
    try {
      await api.put(`/v1/events/${event.id}/reminder`, { reminderMinutesBefore: next });
      onSaved(next);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save that reminder.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card style={{ gap: 8 }}>
      <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textTertiary }}>REMIND ME</Text>
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        {REMINDER_OPTIONS.map((opt) => (
          <Pressable accessibilityRole="button"
            key={opt.value}
            onPress={() => save(opt.value)}
            disabled={saving}
            style={{
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderRadius: theme.radius.md,
              borderWidth: 1,
              borderColor: value === opt.value ? theme.colors.brandDefault : theme.colors.borderDefault,
              backgroundColor: value === opt.value ? theme.colors.brandDefault : "transparent",
            }}
          >
            <Text style={{ fontSize: 12, fontWeight: "600", color: value === opt.value ? theme.colors.textOnBrand : theme.colors.textPrimary }}>
              {opt.label}
            </Text>
          </Pressable>
        ))}
      </View>
      {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
    </Card>
  );
}

/** TASK-003 — see apps/web's identical `RecurrenceCard` (life/events/[id]/page.tsx) for the full contract. */
function RecurrenceCard({ event, onSaved }: { event: EventDetail["event"]; onSaved: (recurrenceRule: RecurrenceRule | null) => void }) {
  const { theme } = useAppTheme();
  const [rule, setRule] = useState<RecurrenceRule | null>(event.recurrenceRule);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.put(`/v1/events/${event.id}/recurrence`, { recurrenceRule: rule });
      onSaved(rule);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't save that recurrence rule.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card style={{ gap: 8 }}>
      <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textTertiary }}>RECURRENCE</Text>
      <RecurrencePicker value={rule} onChange={setRule} />
      <Button variant="secondary" onPress={save} loading={saving}>
        Save
      </Button>
      {error && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{error}</Text>}
    </Card>
  );
}

/** CAL-001 — see apps/web's identical `WriteBackCard` (life/events/[id]/page.tsx) for the full contract. */
function WriteBackCard({ event, targets, onPushed }: { event: EventDetail["event"]; targets: Connection[]; onPushed: () => void }) {
  const { theme } = useAppTheme();
  const [connectionId, setConnectionId] = useState(event.writeBackConnectionId ?? targets[0]?.id ?? "");
  const [pushing, setPushing] = useState(false);
  const [failed, setFailed] = useState(false);

  async function push() {
    setPushing(true);
    setFailed(false);
    try {
      const res = await api.post<{ pushed: boolean }>(`/v1/calendar-events/${event.id}/push`, { connectionId });
      if (!res.pushed) setFailed(true);
      onPushed();
    } catch {
      setFailed(true);
    } finally {
      setPushing(false);
    }
  }

  return (
    <Card style={{ gap: 8 }}>
      <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textPrimary }}>Sync to a connected calendar</Text>
      {event.writeBackStatus && (
        <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
          {event.writeBackStatus === "pushed" ? "Last synced successfully." : "The last sync attempt didn't go through — this event is still saved in Veynlo."}
        </Text>
      )}
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        {targets.map((t) => (
          <Pressable accessibilityRole="button"
            key={t.id}
            onPress={() => setConnectionId(t.id)}
            style={{
              paddingHorizontal: 10,
              paddingVertical: 6,
              borderRadius: theme.radius.md,
              borderWidth: 1,
              borderColor: connectionId === t.id ? theme.colors.brandDefault : theme.colors.borderDefault,
              backgroundColor: connectionId === t.id ? theme.colors.brandDefault : "transparent",
            }}
          >
            <Text style={{ fontSize: 12, fontWeight: "600", color: connectionId === t.id ? theme.colors.textOnBrand : theme.colors.textPrimary }}>
              {PROVIDER_LABEL[t.provider] ?? t.provider}
            </Text>
          </Pressable>
        ))}
      </View>
      <Button variant="secondary" onPress={push} loading={pushing} disabled={!connectionId}>
        Push
      </Button>
      {failed && <Text style={{ fontSize: 12, color: theme.colors.critical }}>Couldn&apos;t sync to that calendar right now. Try again later.</Text>}
    </Card>
  );
}
