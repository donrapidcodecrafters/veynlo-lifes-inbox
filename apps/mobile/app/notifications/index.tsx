import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { api, ApiError } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";

interface NotificationRecord {
  id: string;
  priority: string;
  channel: string;
  title: string;
  body: string;
  state: "queued" | "sent" | "suppressed" | "opened" | "actioned" | "failed";
  suppressionReason: string | null;
  scheduledFor: string;
  sentAt: string | null;
  openedAt: string | null;
}

// Kept in sync with apps/web's settings/notifications page: a bare 3-state map made "opened", "actioned",
// and "failed" all fall through to the "neutral" default instead of reflecting the real state.
const STATE_TONE: Record<NotificationRecord["state"], "positive" | "warning" | "neutral" | "critical"> = {
  sent: "positive",
  queued: "neutral",
  suppressed: "warning",
  opened: "positive",
  actioned: "positive",
  failed: "critical",
};

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function NotificationHistoryScreen() {
  const { theme } = useAppTheme();
  const [items, setItems] = useState<NotificationRecord[] | undefined>(undefined);
  // Confirmed live elsewhere in this app (documents.tsx, timeline.tsx): a `.then` with no `.catch` on a
  // mount-time fetch becomes an unhandled promise rejection on any transient network failure, which React
  // Native Web surfaces as a full-screen "Uncaught Error" dev overlay blocking the entire app, not just
  // this screen.
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<NotificationRecord[]>("/v1/notifications")
      .then(setItems)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Couldn't load your notifications. Please try again."));
  }, []);

  return (
    <Screen>
      <ScreenHeader title="Notification history" subtitle="Everything Veynlo has sent or considered sending you." />
      {error && <Text style={{ fontSize: 13, color: theme.colors.critical }}>{error}</Text>}

      {items === undefined && !error && <View style={{ height: 120, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} accessibilityElementsHidden importantForAccessibility="no" />}

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
                    ? // Every other snake_case value this screen (and its siblings — see documents.tsx's
                      // processingState, connections.tsx's health) displays gets `.replace(/_/g, " ")`'d into
                      // words first; this one didn't, so a real suppression reason like "quiet_hours" showed
                      // up on screen with the underscore still in it (confirmed live: "Suppressed —
                      // quiet_hours").
                      `Suppressed${n.suppressionReason ? ` — ${n.suppressionReason.replace(/_/g, " ")}` : ""} (would've sent ${formatWhen(n.scheduledFor)})`
                    : `Scheduled for ${formatWhen(n.scheduledFor)}`}
                {n.openedAt ? ` · Opened ${formatWhen(n.openedAt)}` : ""}
              </Text>
            </Card>
          ))}
        </View>
      )}
    </Screen>
  );
}
