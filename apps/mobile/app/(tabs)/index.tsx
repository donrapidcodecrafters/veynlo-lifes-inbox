import { useCallback, useEffect, useState } from "react";
import { Pressable, RefreshControl, Text, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { api } from "@/lib/api-client";
import { useBackfillStatus } from "@/lib/use-backfill-status";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { ActionMenu } from "@/components/action-menu";
import { EmptyState } from "@/components/empty-state";
import { formatMoneyMinorUnits, formatTemporal, type TemporalValueLike } from "@/lib/format";

interface AttentionItem {
  id: string;
  reasonText: string;
  urgency: "critical" | "important" | "useful" | "informational";
  dueAt: TemporalValueLike | null;
  moneyAtStakeMinorUnits: number | null;
  moneyAtStakeCurrency: string | null;
  linkedResourceType: string | null;
  linkedResourceId: string | null;
}

/** HOME-001 "open" action — same missing-navigation fix as web's Home page. */
function resourceRoute(type: string | null, id: string | null): string | null {
  if (!type || !id) return null;
  switch (type) {
    case "bill":
      return `/bill/${id}`;
    case "return_case":
      return `/return-case/${id}`;
    case "warranty":
      return `/warranty/${id}`;
    case "person":
      return `/person/${id}`;
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

interface HouseholdMembership {
  household: { id: string; name: string };
}

interface Member {
  userId: string | null;
  status: string;
  displayName: string | null;
}

const URGENCY_TONE: Record<AttentionItem["urgency"], "critical" | "warning" | "neutral"> = {
  critical: "critical",
  important: "warning",
  useful: "neutral",
  informational: "neutral",
};

const SNOOZE_OPTIONS = [
  { label: "1 hour", ms: 60 * 60 * 1000 },
  { label: "Tomorrow", ms: 24 * 60 * 60 * 1000 },
  { label: "1 week", ms: 7 * 24 * 60 * 60 * 1000 },
];

const TODAY_KIND_LABEL: Record<TodayItem["kind"], string> = { event: "Event", task: "Task", bill: "Bill" };

export default function HomeScreen() {
  const { theme } = useAppTheme();
  const backfilling = useBackfillStatus();
  const [data, setData] = useState<HomeResponse | null>(null);
  const [today, setToday] = useState<TodayItem[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [home, todayRes, households] = await Promise.all([
      api.get<HomeResponse>("/v1/home"),
      api.get<{ items: TodayItem[] }>("/v1/home/today").catch(() => ({ items: [] })),
      api.get<HouseholdMembership[]>("/v1/households").catch(() => []),
    ]);
    setData(home);
    setToday(todayRes.items);
    const householdId = households[0]?.household.id;
    if (householdId) {
      const memberList = await api.get<Member[]>(`/v1/households/${householdId}/members`).catch(() => []);
      setMembers(memberList.filter((m) => m.userId && m.status === "active"));
    } else {
      setMembers([]);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // §54.2 launch criteria #2 — while a connection is still backfilling, new items keep landing here with
  // no user action; useFocusEffect alone only refetches on tab-switch, not while sitting on this tab.
  useEffect(() => {
    if (!backfilling) return;
    const interval = setInterval(load, 4000);
    return () => clearInterval(interval);
  }, [backfilling, load]);

  async function onRefresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  async function resolve(id: string) {
    await api.post(`/v1/attention/${id}/resolve`);
    load();
  }

  async function dismiss(id: string) {
    await api.post(`/v1/attention/${id}/dismiss`, { reason: "not_relevant" });
    load();
  }

  async function snooze(id: string, ms: number) {
    await api.post(`/v1/attention/${id}/snooze`, { until: new Date(Date.now() + ms).toISOString() });
    load();
  }

  async function delegate(id: string, assigneeUserId: string) {
    await api.post(`/v1/attention/${id}/delegate`, { assigneeUserId });
    load();
  }

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.brandDefault} />}>
      <View>
        <Text style={{ fontSize: 24, fontWeight: "700", color: theme.colors.textPrimary }}>Home</Text>
        <Text style={{ fontSize: 14, color: theme.colors.textTertiary, marginTop: 2 }}>What matters right now.</Text>
      </View>

      {data?.degraded && data.unhealthyConnections.length > 0 && (
        <Card style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, backgroundColor: theme.colors.warningSubtleBg }}>
          <Text style={{ flex: 1, fontSize: 13, color: theme.colors.warningSubtleText }}>
            {data.unhealthyConnections.length} connection{data.unhealthyConnections.length > 1 ? "s" : ""} need attention — some
            information may be out of date.
          </Text>
          <Button variant="secondary" onPress={() => router.push("/connections")}>
            Review
          </Button>
        </Card>
      )}

      {today.length > 0 && (
        <View style={{ gap: 8 }}>
          <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>Today</Text>
          <Card style={{ gap: 10 }}>
            {today.map((item) => {
              const route = item.kind === "event" ? `/event/${item.id}` : item.kind === "bill" ? `/bill/${item.id}` : "/(tabs)/life";
              return (
                <Pressable
                  key={`${item.kind}-${item.id}`}
                  onPress={() => router.push(route)}
                  accessibilityRole="button"
                  accessibilityLabel={`${item.title}, ${TODAY_KIND_LABEL[item.kind]}`}
                >
                  <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>{item.title}</Text>
                  <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
                    {TODAY_KIND_LABEL[item.kind]} · {new Date(item.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                  </Text>
                </Pressable>
              );
            })}
          </Card>
        </View>
      )}

      {data?.caughtUp && backfilling && (
        <EmptyState
          title="Still going through what you connected."
          description="Veynlo is reading through your history now — anything worth your attention will show up here automatically, no need to refresh."
        />
      )}

      {data?.caughtUp && !backfilling && (
        <EmptyState
          title={data.degraded ? "Nothing else needs attention from the sources currently available." : "You're caught up."}
          description={
            data.degraded
              ? "Some connections aren't syncing right now, so this isn't the full picture — reconnect them above to be sure."
              : "Nothing needs your attention right now. Connect an account or add something to find more."
          }
        />
      )}

      {data && data.items.length > 0 && backfilling && (
        <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Still reading through what you connected — more may appear shortly.</Text>
      )}

      {data && data.items.length > 0 && (
        <View style={{ gap: 12 }}>
          {data.items.map((item) => (
            <AttentionItemCard
              key={item.id}
              item={item}
              members={members}
              onResolve={() => resolve(item.id)}
              onDismiss={() => dismiss(item.id)}
              onSnooze={(ms) => snooze(item.id, ms)}
              onDelegate={(userId) => delegate(item.id, userId)}
            />
          ))}
        </View>
      )}
    </Screen>
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
  onDelegate: (userId: string) => void;
}) {
  const { theme } = useAppTheme();
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
    await Clipboard.setStringAsync(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Card style={{ gap: 12 }}>
      <View style={{ gap: 6 }}>
        <Badge tone={URGENCY_TONE[item.urgency]}>{item.urgency}</Badge>
        <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.textPrimary }}>{item.reasonText}</Text>
        <View style={{ flexDirection: "row", gap: 12 }}>
          {due && <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>Due {due}</Text>}
          {money && <Text style={{ fontSize: 13, fontWeight: "600", color: theme.colors.textPrimary }}>{money} at stake</Text>}
        </View>
      </View>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        {resourceRoute(item.linkedResourceType, item.linkedResourceId) && (
          <View style={{ flex: 1, minWidth: 90 }}>
            <Button variant="secondary" onPress={() => router.push(resourceRoute(item.linkedResourceType, item.linkedResourceId)!)}>
              Open
            </Button>
          </View>
        )}
        <View style={{ flex: 1, minWidth: 110 }}>
          <Button variant="secondary" onPress={onResolve}>
            Mark handled
          </Button>
        </View>
        <ActionMenu
          items={[
            { label: "Dismiss", onSelect: onDismiss },
            { label: "Snooze", onSelect: () => setExpanded(expanded === "snooze" ? null : "snooze") },
            ...(members.length > 0 ? [{ label: "Delegate", onSelect: () => setExpanded(expanded === "delegate" ? null : "delegate") }] : []),
            { label: "Share", onSelect: handleShare },
          ]}
        />
      </View>

      {expanded === "snooze" && (
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.md, padding: 8 }}>
          {SNOOZE_OPTIONS.map((opt) => (
            <Pressable
              key={opt.label}
              onPress={() => onSnooze(opt.ms)}
              accessibilityRole="button"
              accessibilityLabel={`Snooze ${opt.label}`}
              style={{ paddingVertical: 6, paddingHorizontal: 10, borderRadius: theme.radius.sm, backgroundColor: theme.colors.bgSurface }}
            >
              <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.textPrimary }}>{opt.label}</Text>
            </Pressable>
          ))}
        </View>
      )}

      {expanded === "delegate" && (
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.md, padding: 8 }}>
          {members.map((m) => (
            <Pressable
              key={m.userId}
              onPress={() => m.userId && onDelegate(m.userId)}
              accessibilityRole="button"
              accessibilityLabel={`Delegate to ${m.displayName ?? "Household member"}`}
              style={{ paddingVertical: 6, paddingHorizontal: 10, borderRadius: theme.radius.sm, backgroundColor: theme.colors.bgSurface }}
            >
              <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.textPrimary }}>{m.displayName ?? "Household member"}</Text>
            </Pressable>
          ))}
        </View>
      )}

      {shareUrl && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.md, padding: 8 }}>
          <Text style={{ flex: 1, fontSize: 12, color: theme.colors.textPrimary }} numberOfLines={1}>
            {shareUrl}
          </Text>
          <Button variant="secondary" onPress={copyShareUrl}>
            {copied ? "Copied" : "Copy"}
          </Button>
        </View>
      )}
    </Card>
  );
}
