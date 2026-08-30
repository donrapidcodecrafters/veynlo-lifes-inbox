import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { api } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";

interface NotificationRecord {
  id: string;
  priority: string;
  channel: string;
  title: string;
  body: string;
  state: "queued" | "sent" | "suppressed";
  suppressionReason: string | null;
  scheduledFor: string;
  sentAt: string | null;
  openedAt: string | null;
}

interface NotificationsPageResponse {
  items: NotificationRecord[];
  nextCursor: string | null;
}

const STATE_TONE: Record<string, "positive" | "warning" | "neutral"> = {
  sent: "positive",
  queued: "neutral",
  suppressed: "warning",
};

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function NotificationHistoryScreen() {
  const { theme } = useAppTheme();
  const [items, setItems] = useState<NotificationRecord[] | undefined>(undefined);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    api.get<NotificationsPageResponse>("/v1/notifications").then((res) => {
      setItems(res.items);
      setCursor(res.nextCursor);
    });
  }, []);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const res = await api.get<NotificationsPageResponse>(`/v1/notifications?before=${encodeURIComponent(cursor)}`);
      setItems((prev) => [...(prev ?? []), ...res.items]);
      setCursor(res.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <Screen>
      <ScreenHeader title="Notification history" subtitle="Everything Veynlo has sent or considered sending you." />

      {items === undefined && <View style={{ height: 120, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} />}

      {items?.length === 0 && (
        <EmptyState title="No notifications yet" description="When Veynlo sends you something, it'll show up here." />
      )}

      {items && items.length > 0 && (
        <View style={{ gap: 12 }}>
          {items.map((n) => (
            <Card key={n.id} style={{ gap: 6 }}>
              <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
                <Badge tone={STATE_TONE[n.state] ?? "neutral"}>{n.state}</Badge>
                <Badge tone="neutral">{n.priority}</Badge>
                <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.textTertiary, textTransform: "uppercase" }}>
                  {n.channel}
                </Text>
              </View>
              <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.textPrimary }}>{n.title}</Text>
              <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>{n.body}</Text>
              <Text style={{ fontSize: 12, color: theme.colors.textTertiary }}>
                {n.state === "sent" && n.sentAt
                  ? `Sent ${formatWhen(n.sentAt)}`
                  : n.state === "suppressed"
                    ? `Suppressed${n.suppressionReason ? ` — ${n.suppressionReason}` : ""} (would've sent ${formatWhen(n.scheduledFor)})`
                    : `Scheduled for ${formatWhen(n.scheduledFor)}`}
                {n.openedAt ? ` · Opened ${formatWhen(n.openedAt)}` : ""}
              </Text>
            </Card>
          ))}
          {cursor && (
            <Button variant="secondary" onPress={loadMore} loading={loadingMore}>
              Load more
            </Button>
          )}
        </View>
      )}
    </Screen>
  );
}
