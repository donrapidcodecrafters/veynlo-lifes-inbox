import { Text, View } from "react-native";
import { useAppTheme } from "@/lib/theme-context";
import { Card } from "@/components/card";

export interface Evidence {
  sourceEventId: string;
  kind: string;
  subjectLine: string | null;
  snippet: string | null;
  fromAddress: string | null;
  occurredAt: string;
  provider: string | null;
}

const KIND_LABEL: Record<string, string> = {
  email_message: "Email",
  manual_entry: "Added manually",
  calendar_feed_event: "Calendar feed",
};

const PROVIDER_LABEL: Record<string, string> = { gmail: "Gmail", outlook: "Outlook", ics: "Calendar feed" };

/** Mirrors apps/web/src/components/evidence-card.tsx — see its doc comment for why only a snippet/subject
 * is shown rather than the full original message (never stored). */
export function EvidenceCard({ evidence }: { evidence: Evidence | null }) {
  const { theme } = useAppTheme();

  if (!evidence) {
    return (
      <Card style={{ gap: 4 }}>
        <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Evidence</Text>
        <Text style={{ fontSize: 13, color: theme.colors.textTertiary }}>
          No source evidence is available for this item — it may have come from seed data or a domain that isn&apos;t linked to a source yet.
        </Text>
      </Card>
    );
  }

  const rows: Array<[string, string]> = [];
  if (evidence.subjectLine) rows.push(["Subject", evidence.subjectLine]);
  if (evidence.fromAddress) rows.push(["From", evidence.fromAddress]);
  if (evidence.snippet) rows.push(["Snippet", evidence.snippet]);
  rows.push(["Source", `${KIND_LABEL[evidence.kind] ?? evidence.kind}${evidence.provider ? ` · ${PROVIDER_LABEL[evidence.provider] ?? evidence.provider}` : ""}`]);
  rows.push([
    "Received",
    new Date(evidence.occurredAt).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }),
  ]);

  return (
    <Card style={{ gap: 8 }}>
      <Text style={{ fontSize: 14, fontWeight: "600", color: theme.colors.textPrimary }}>Evidence — where this came from</Text>
      <View style={{ gap: 4 }}>
        {rows.map(([label, value]) => (
          <View key={label} style={{ flexDirection: "row", gap: 8 }}>
            <Text style={{ fontSize: 13, color: theme.colors.textTertiary, width: 72 }}>{label}</Text>
            <Text style={{ fontSize: 13, color: theme.colors.textPrimary, flex: 1 }}>{value}</Text>
          </View>
        ))}
      </View>
    </Card>
  );
}
