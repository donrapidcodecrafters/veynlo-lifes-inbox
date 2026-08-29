import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { api } from "@/lib/api-client";
import { useAppTheme } from "@/lib/theme-context";
import { Screen } from "@/components/screen";
import { Card } from "@/components/card";
import { Badge } from "@/components/badge";
import { EmptyState } from "@/components/empty-state";
import { ScreenHeader } from "@/components/screen-header";
import { EvidenceCard, type Evidence } from "@/components/evidence-card";
import { formatTemporal, type TemporalValueLike } from "@/lib/format";

interface EventDetail {
  event: {
    title: string;
    start: TemporalValueLike;
    end: TemporalValueLike | null;
    isAllDay: boolean;
    location: string | null;
    status: string;
  };
  evidence: Evidence | null;
}

export default function EventDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { theme } = useAppTheme();
  const [data, setData] = useState<EventDetail | null | undefined>(undefined);

  useEffect(() => {
    api.get<EventDetail | null>(`/v1/events/${id}`).then(setData);
  }, [id]);

  if (data === undefined) return <Screen><View style={{ height: 120, backgroundColor: theme.colors.bgSubtle, borderRadius: theme.radius.lg }} /></Screen>;
  if (!data) return <Screen><ScreenHeader title="Not found" /><EmptyState title="Not found" description="This event doesn't exist or you don't have access to it." /></Screen>;

  const { event, evidence } = data;
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
      <EvidenceCard evidence={evidence} />
    </Screen>
  );
}
