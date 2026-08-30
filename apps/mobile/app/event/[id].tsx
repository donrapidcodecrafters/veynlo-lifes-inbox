import { useEffect, useState } from "react";
import { Pressable, Share, Switch, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { useAuth } from "@/lib/auth-context";
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
    householdId: string | null;
    visibility: string;
  };
  evidence: Evidence | null;
}

interface Member {
  userId: string | null;
  status: string;
  displayName: string | null;
}

interface ResourceGrant {
  id: string;
  granteeUserId: string;
}

export default function EventDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { theme } = useAppTheme();
  const { user } = useAuth();
  const [data, setData] = useState<EventDetail | null | undefined>(undefined);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [grants, setGrants] = useState<ResourceGrant[]>([]);
  const [granting, setGranting] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);

  useEffect(() => {
    api.get<EventDetail | null>(`/v1/events/${id}`).then(setData);
  }, [id]);

  useEffect(() => {
    const householdId = data?.event.householdId;
    if (!householdId) return;
    api.get<Member[]>(`/v1/households/${householdId}/members`).then(setMembers);
    api.get<ResourceGrant[]>(`/v1/events/${id}/grants`).then(setGrants);
  }, [data?.event.householdId, id]);

  if (data === undefined) return <Screen><View style={{ height: 120, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} /></Screen>;
  if (!data) return <Screen><ScreenHeader title="Not found" /><EmptyState title="Not found" description="This event doesn't exist or you don't have access to it." /></Screen>;

  const { event, evidence } = data;
  const start = formatTemporal(event.start);
  const end = formatTemporal(event.end);
  const subtitle = start ? `${start}${end && !event.isAllDay ? ` – ${end}` : ""}${event.isAllDay ? " · All day" : ""}` : undefined;

  async function toggleVisibility(visible: boolean) {
    await api.post(`/v1/events/${id}/visibility`, { visibility: visible ? "household" : "private" });
    setData(await api.get<EventDetail>(`/v1/events/${id}`));
  }

  async function grantMember(granteeUserId: string) {
    setGranting(true);
    setGrantError(null);
    try {
      await api.post(`/v1/events/${id}/grants`, { granteeUserId });
      setGrants(await api.get<ResourceGrant[]>(`/v1/events/${id}/grants`));
    } catch (err) {
      setGrantError(err instanceof ApiError ? err.message : "Couldn't share with that person. Please try again.");
    } finally {
      setGranting(false);
    }
  }

  async function revokeGrant(grantId: string) {
    await api.post(`/v1/events/${id}/grants/${grantId}/revoke`);
    setGrants(await api.get<ResourceGrant[]>(`/v1/events/${id}/grants`));
  }

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
        {event.householdId && (
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, paddingTop: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Visible to household</Text>
              <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>Let household members with schedule access see this event.</Text>
            </View>
            <Switch value={event.visibility === "household"} onValueChange={toggleVisibility} trackColor={{ false: theme.colors.borderStrong, true: theme.colors.brandDefault }} />
          </View>
        )}
        {event.householdId && (
          <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: theme.colors.borderSubtle, paddingTop: 12 }}>
            <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Share with a household member</Text>
            <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
              Gives one specific person access to this event, even if it&apos;s private and not visible to the whole household.
            </Text>
            {(() => {
              const activeMembers = members.filter((m) => m.userId && m.status === "active" && m.userId !== user?.id);
              const grantedIds = new Set(grants.map((g) => g.granteeUserId));
              const available = activeMembers.filter((m) => !grantedIds.has(m.userId!));
              return (
                <>
                  {available.length > 0 && (
                    <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                      {available.map((m) => (
                        <Pressable
                          key={m.userId}
                          onPress={() => !granting && m.userId && grantMember(m.userId)}
                          accessibilityRole="button"
                          accessibilityLabel={`Share with ${m.displayName ?? "household member"}`}
                          style={{ paddingVertical: 6, paddingHorizontal: 10, borderRadius: theme.radius.sm, backgroundColor: theme.colors.bgSubtle }}
                        >
                          <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.textPrimary }}>{m.displayName ?? "Household member"}</Text>
                        </Pressable>
                      ))}
                    </View>
                  )}
                  {grantError && <Text style={{ fontSize: 12, color: theme.colors.critical }}>{grantError}</Text>}
                  {grants.length > 0 && (
                    <View style={{ gap: 6 }}>
                      {grants.map((g) => {
                        const member = activeMembers.find((m) => m.userId === g.granteeUserId);
                        return (
                          <View
                            key={g.id}
                            style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.sm, paddingVertical: 6, paddingHorizontal: 10 }}
                          >
                            <Text style={{ fontSize: 13, color: theme.colors.textPrimary }}>{member?.displayName ?? "Household member"}</Text>
                            <Pressable onPress={() => revokeGrant(g.id)} accessibilityRole="button" accessibilityLabel="Revoke access">
                              <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.critical }}>Revoke</Text>
                            </Pressable>
                          </View>
                        );
                      })}
                    </View>
                  )}
                </>
              );
            })()}
          </View>
        )}
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
