import { useEffect, useState } from "react";
import { Share, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";
import { EvidenceCard, type Evidence } from "@/components/evidence-card";
import { HistorySection } from "@/components/history-section";
import { formatTemporal, type TemporalValueLike } from "@/lib/format";

interface EventDetail {
  event: {
    title: string;
    start: TemporalValueLike;
    end: TemporalValueLike | null;
    isAllDay: boolean;
    location: string | null;
    status: string;
    providerEventId: string | null;
  };
  evidence: Evidence | null;
}

export default function EventDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { theme } = useAppTheme();
  const [data, setData] = useState<EventDetail | null | undefined>(undefined);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.get<EventDetail | null>(`/v1/events/${id}`).then(setData);
  }, [id]);

  if (data === undefined) return <Screen><View style={{ height: 120, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} /></Screen>;
  if (!data) return <Screen><ScreenHeader title="Not found" /><EmptyState title="Not found" description="This event doesn't exist or you don't have access to it." /></Screen>;

  const { event, evidence } = data;
  const start = formatTemporal(event.start);
  const end = formatTemporal(event.end);
  const subtitle = start ? `${start}${end && !event.isAllDay ? ` – ${end}` : ""}${event.isAllDay ? " · All day" : ""}` : undefined;

  async function syncToCalendar() {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const result = await api.post<{ provider: string; providerEventId: string }>(`/v1/events/${id}/push-to-calendar`);
      setSyncMessage(`Synced to ${result.provider === "google_calendar" ? "Google Calendar" : "Outlook Calendar"}.`);
      setData(await api.get<EventDetail>(`/v1/events/${id}`));
    } catch (err) {
      setSyncMessage(err instanceof ApiError ? err.message : "Couldn't sync this event. Please try again.");
    } finally {
      setSyncing(false);
    }
  }

  async function share() {
    setSharing(true);
    try {
      const result = await api.post<{ url: string }>(`/v1/events/${id}/share`);
      setShareUrl(result.url);
      setCopied(false);
      // Best-effort — the persistent copy/revoke row below is the real UI either way. Many browsers (most
      // desktop ones, confirmed live via Expo web) have no Web Share API at all and Share.share() throws
      // synchronously there; native iOS/Android always support it, but never let its absence block the flow.
      await Share.share({ message: result.url }).catch(() => undefined);
    } finally {
      setSharing(false);
    }
  }

  async function copyShareUrl() {
    if (!shareUrl) return;
    await Clipboard.setStringAsync(shareUrl);
    setCopied(true);
  }

  async function revokeShare() {
    await api.post(`/v1/events/${id}/share/revoke`);
    setShareUrl(null);
  }

  return (
    <Screen>
      <ScreenHeader title={event.title} subtitle={subtitle} />
      <Card style={{ gap: 8 }}>
        <Badge tone={event.status === "confirmed" ? "positive" : "neutral"}>{event.status.replace(/_/g, " ")}</Badge>
        {event.location && <Text style={{ fontSize: 14, color: theme.colors.textPrimary }}>{event.location}</Text>}
        <Button variant="secondary" onPress={syncToCalendar} loading={syncing}>
          {event.providerEventId ? "Sync changes to calendar" : "Sync to Google/Outlook Calendar"}
        </Button>
        {syncMessage && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>{syncMessage}</Text>}
        <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, paddingTop: 12 }}>
          {!shareUrl ? (
            <Button variant="ghost" onPress={share} loading={sharing}>
              Share
            </Button>
          ) : (
            <View style={{ gap: 8 }}>
              <Text style={{ fontSize: 13, color: theme.colors.textPrimary }} numberOfLines={1}>
                {shareUrl}
              </Text>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Button variant="secondary" onPress={copyShareUrl}>
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </View>
                <View style={{ flex: 1 }}>
                  <Button variant="ghost" onPress={revokeShare}>
                    Revoke
                  </Button>
                </View>
              </View>
            </View>
          )}
        </View>
      </Card>
      <HistorySection resourceType="calendar_event" resourceId={id} />
      <EvidenceCard evidence={evidence} />
    </Screen>
  );
}
